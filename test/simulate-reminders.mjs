// Snooze, "Remind me if no reply" and the company details footer, end to end against a local Mail App
// (npm run dev:local). Waits for the mailbox's alarm twice, so it takes about three minutes.
//
//   node test/simulate-reminders.mjs [http://127.0.0.1:5173]
//
// Needs a fresh local store (delete .wrangler/state first), and an install that can send.
const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const OWNER = "owner@example.com";
const BOX = "sam@example.com";
const M = `/api/v1/mailboxes/${encodeURIComponent(BOX)}`;
let passed = 0;
const failures = [];

async function req(method, path, body) {
	const res = await fetch(BASE + path, {
		method,
		headers: { "dev-as": OWNER, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json = null;
	try { json = JSON.parse(text); } catch { /* not json */ }
	return { status: res.status, json, text };
}
function check(name, ok, detail = "") {
	if (ok) passed++;
	else { failures.push(`${name} ${detail}`); console.log(`FAIL ${name} ${detail}`); }
}
async function deliver(subject, extra = "") {
	const id = `${crypto.randomUUID()}@example.org`;
	const eml = `From: Jo <jo@example.org>\r\nTo: ${BOX}\r\nSubject: ${subject}\r\nMessage-ID: <${id}>\r\n${extra}Date: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\nHello, this is ${subject}.\r\n`;
	await fetch(`${BASE}/cdn-cgi/handler/email?from=jo@example.org&to=${encodeURIComponent(BOX)}`, { method: "POST", body: eml });
	return id;
}
const list = async (folder) => (await req("GET", `${M}/emails?folder=${folder}&threaded=true&limit=50`)).json;
const find = (l, subject) => l.emails.find((e) => e.subject === subject);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (what, ok, ms = 150_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (await ok()) return true; await sleep(3000); }
	console.log(`(gave up waiting for ${what})`);
	return false;
};

await req("POST", "/api/v1/mailboxes", { email: BOX, name: "Sam" });

// ── Snooze ──
await deliver("Invoice 101");
await deliver("Lunch?");
let inbox = await list("inbox");
const invoice = find(inbox, "Invoice 101");
check("mail arrived", !!invoice && !!find(inbox, "Lunch?"));
check("too soon is refused", (await req("POST", `${M}/snooze`, { ids: [invoice.id], until: Date.now() + 5_000 })).status === 400);
check("moving into Snoozed by hand is refused", (await req("POST", `${M}/conversations`, { ids: [invoice.id], action: "move", folderId: "snoozed" })).status === 400);
const until = Date.now() + 65_000;
const snoozed = await req("POST", `${M}/snooze`, { ids: [invoice.id], until, fromFolder: "inbox" });
check("snooze", snoozed.json?.snoozed === 1, snoozed.text);
inbox = await list("inbox");
check("snoozed mail leaves the Inbox", !find(inbox, "Invoice 101"));
const snoozedList = await list("snoozed");
check("and waits in Snoozed, with its time", find(snoozedList, "Invoice 101")?.snoozed_until === until, JSON.stringify(snoozedList.emails[0] ?? null));
const folders = (await req("GET", `${M}/folders`)).json;
check("Snoozed shows no unread count", folders.find((f) => f.id === "snoozed")?.unreadCount === 0, JSON.stringify(folders));
const open = (await req("GET", `${M}/emails/${invoice.id}`)).json;
check("the open email says when it's back", open.reminders?.[0]?.kind === "snooze" && open.reminders[0].due_at === until);

// A reply wakes it early.
await deliver("Lunch plans");
const lunch = find(await list("inbox"), "Lunch plans");
await req("POST", `${M}/snooze`, { ids: [lunch.id], until: Date.now() + 3_600_000 });
const lunchMsgId = (await req("GET", `${M}/emails/${lunch.id}`)).json.message_id;
await deliver("Re: Lunch plans", `In-Reply-To: <${lunchMsgId}>\r\nReferences: <${lunchMsgId}>\r\n`);
inbox = await list("inbox");
check("a reply brings a snoozed conversation back", !!inbox.emails.find((e) => /Lunch plans/.test(e.subject) && e.thread_count === 2), JSON.stringify(inbox.emails.map((e) => [e.subject, e.thread_count])));
check("and ends its snooze", !find(await list("snoozed"), "Lunch plans"));

// Unsnooze now.
await deliver("Parking permit");
const permit = find(await list("inbox"), "Parking permit");
await req("POST", `${M}/snooze`, { ids: [permit.id], until: Date.now() + 3_600_000 });
await req("POST", `${M}/unsnooze`, { ids: [permit.id] });
check("Unsnooze brings it straight back", !!find(await list("inbox"), "Parking permit") && !find(await list("snoozed"), "Parking permit"));

// ── Email disclaimer ──
check("only admins see the email disclaimer", (await fetch(`${BASE}/api/v1/company`, { headers: { "dev-as": "nobody@example.com" } })).status !== 200);
const saved = await req("PUT", "/api/v1/company", { enabled: true, disclaimer: "Example Ltd. Registered in England and Wales, company number 12345678.\nRegistered office: 1 High Street, London." });
check("the email disclaimer saves", saved.json?.enabled === true && saved.json.disclaimer.endsWith("1 High Street, London."), saved.text);

// ── Remind me if no reply ──
const sent = await req("POST", `${M}/emails`, {
	to: "client@example.net", from: BOX, subject: "Invoice 202", html: "<p>Please pay invoice 202.</p>", text: "Please pay invoice 202.",
	remind_at: Date.now() + 65_000,
});
check("send with a reminder", sent.status === 202, sent.text);
const sentEmail = (await req("GET", `${M}/emails/${sent.json?.id}`)).json;
check("the footer is on the sent email", /data-app-company="1"[^]*Example Ltd\. Registered in England and Wales, company number 12345678\.[^]*Registered office: 1 High Street, London\./.test(sentEmail?.body ?? ""), sentEmail?.body);
check("the sent email knows its reminder", sentEmail?.reminders?.[0]?.kind === "no-reply" && sentEmail.reminders[0].shown === false);
check("Sent shows a reminder is waiting", typeof find(await list("sent"), "Invoice 202")?.no_reply === "number");

// A second one, answered before it's due.
const asked = await req("POST", `${M}/emails`, { to: "client@example.net", from: BOX, subject: "Quote 7", html: "<p>Quote attached.</p>", text: "Quote attached." });
await req("PUT", `${M}/emails/${asked.json.id}/reminder`, { at: Date.now() + 65_000 });
const askedMsgId = (await req("GET", `${M}/emails/${asked.json.id}`)).json.message_id;
await deliver("Re: Quote 7", `In-Reply-To: <${askedMsgId}>\r\nReferences: <${askedMsgId}>\r\n`);
check("a reply ends the reminder", !(await req("GET", `${M}/emails/${asked.json.id}`)).json.reminders?.length);

// ── Wait for the alarm ──
const back = await waitFor("the snooze to end", async () => !!find(await list("inbox"), "Invoice 101"));
check("snoozed mail comes back when it's due", back);
inbox = await list("inbox");
// Above mail that came in while it was snoozed (the reminder below may come back in the same moment).
const order = inbox.emails.map((e) => e.subject);
check("at the top of the Inbox", order.indexOf("Invoice 101") < order.indexOf("Re: Quote 7"), JSON.stringify(order));
check("and unread", find(inbox, "Invoice 101")?.read === false);

const due = await waitFor("the reminder", async () => find(await list("inbox"), "Invoice 202")?.no_reply === "due");
check("an unanswered email comes back to the Inbox", due);
check("it's still in Sent", !!find(await list("sent"), "Invoice 202"));
check("the answered one doesn't come back", !find(await list("inbox"), "Quote 7"));
const reminderRow = find(await list("inbox"), "Invoice 202");
await req("POST", `${M}/conversations`, { ids: [reminderRow.id], action: "move", folderId: "archive", fromFolder: "inbox" });
check("archiving it clears the reminder", !find(await list("inbox"), "Invoice 202"));
check("and leaves the email in Sent", !!find(await list("sent"), "Invoice 202"));
check("not in Archive", !find(await list("archive"), "Invoice 202"));

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
