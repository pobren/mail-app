// Scheduled send end to end against a local Mail App (npm run dev:local): schedule a new email and a
// reply, change the time, send one now (the mailbox's alarm sends it), cancel one back to Drafts, and
// check a deleted one never goes.
//
//   node test/simulate-scheduled.mjs [http://127.0.0.1:5173]
//
// Needs an install that can send.
const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const OWNER = "owner@example.com";
const BOX = "sched@example.com";
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
async function deliver(subject) {
	const id = `${crypto.randomUUID()}@example.org`;
	const eml = `From: Jo <jo@example.org>\r\nTo: ${BOX}\r\nSubject: ${subject}\r\nMessage-ID: <${id}>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\nHello, this is ${subject}.\r\n`;
	await fetch(`${BASE}/cdn-cgi/handler/email?from=jo@example.org&to=${encodeURIComponent(BOX)}`, { method: "POST", body: eml });
	return id;
}
const list = async (folder) => (await req("GET", `${M}/emails?folder=${folder}&threaded=true&limit=50`)).json;
const find = (l, subject) => l?.emails?.find((e) => e.subject === subject);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (ok, ms = 20_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (await ok()) return true; await sleep(1000); }
	return false;
};
const run = Date.now().toString(36);
const email = (subject, extra = {}) => ({ to: "someone@example.net", from: BOX, subject, html: `<p>${subject}</p>`, text: subject, ...extra });

let r = await req("POST", "/api/v1/mailboxes", { email: BOX, name: "Sched" });
check("mailbox", r.status < 300 || r.status === 409, r.text);

// Bad times.
r = await req("POST", `${M}/emails`, email(`Past ${run}`, { send_at: Date.now() - 60_000 }));
check("a time that's passed is refused", r.status === 400, r.text);
r = await req("POST", `${M}/emails`, email(`Far ${run}`, { send_at: Date.now() + 400 * 86_400_000 }));
check("more than a year ahead is refused", r.status === 400, r.text);

// Schedule a new email.
const inTwoHours = Date.now() + 2 * 3_600_000;
const later = `Later ${run}`;
r = await req("POST", `${M}/emails`, email(later, { send_at: inTwoHours, remind_at: Date.now() + 86_400_000 }));
check("scheduled", r.status === 202 && r.json?.status === "scheduled" && r.json.send_at === inTwoHours, r.text);
const laterId = r.json?.id;
let l = await list("scheduled");
check("waits in Scheduled with its time", find(l, later)?.send_at === inTwoHours, JSON.stringify(l));
check("not in Sent yet", !find(await list("sent"), later));
r = await req("GET", `${M}/folders`);
check("Scheduled shows how many are waiting", (r.json ?? []).find((f) => f.id === "scheduled")?.unreadCount >= 1, r.text);
r = await req("GET", `${M}/emails/${laterId}`);
check("the email says when it goes", r.json?.send_at === inTwoHours && r.json.folder_id === "scheduled", r.text);

// Change the time, then send it now.
const inThreeHours = inTwoHours + 3_600_000;
r = await req("POST", `${M}/emails/${laterId}/schedule`, { send_at: inThreeHours });
check("time changed", r.json?.send_at === inThreeHours, r.text);
r = await req("POST", `${M}/emails/${laterId}/schedule`, { send_at: 5 });
check("bad new time refused", r.status === 400, r.text);
r = await req("POST", `${M}/emails/${laterId}/schedule`, { now: true });
check("send now accepted", r.status === 200, r.text);
const went = await waitFor(async () => !!find(await list("sent"), later));
check("the alarm sent it to Sent", went);
const sent = find(await list("sent"), later);
check("dated when it went", sent && Date.parse(sent.date) > Date.now() - 60_000, JSON.stringify(sent));
check("its no-reply reminder was set from when it went", typeof sent?.no_reply === "number" && sent.no_reply > Date.now() + 86_400_000 - 120_000, JSON.stringify(sent));
check("gone from Scheduled", !find(await list("scheduled"), later));
r = await req("POST", `${M}/emails/${laterId}/schedule`, { now: true });
check("can't send again once gone", r.status === 404, r.text);

// A scheduled reply, cancelled back to Drafts.
const origSubject = `Question ${run}`;
await deliver(origSubject);
await sleep(1500);
const orig = find(await list("inbox"), origSubject);
check("email to answer arrived", !!orig);
r = await req("POST", `${M}/emails/${orig?.id}/reply`, email(`Re: ${origSubject}`, { send_at: inTwoHours }));
check("reply scheduled", r.json?.status === "scheduled", r.text);
const replyId = r.json?.id;
r = await req("GET", `${M}/emails/${replyId}`);
check("reply is in the conversation", r.json?.thread_id && r.json.thread_id === orig?.thread_id, `${r.json?.thread_id} vs ${orig?.thread_id}`);
r = await req("POST", `${M}/emails/${replyId}/unschedule`);
check("cancel send", r.status === 200, r.text);
r = await req("GET", `${M}/emails/${replyId}`);
check("back in Drafts, answering the original", r.json?.folder_id === "draft" && r.json.in_reply_to === orig?.id && !r.json.send_at, JSON.stringify({ f: r.json?.folder_id, irt: r.json?.in_reply_to, id: orig?.id }));
r = await req("POST", `${M}/emails/${replyId}/unschedule`);
check("cancel twice", r.status === 404, r.text);

// A forward, deleted before it goes, never goes.
r = await req("POST", `${M}/emails/${orig?.id}/forward`, email(`Fwd: ${origSubject}`, { send_at: inTwoHours }));
check("forward scheduled", r.json?.status === "scheduled", r.text);
const fwdId = r.json?.id;
r = await req("DELETE", `${M}/emails/${fwdId}`);
check("deleted", r.status === 204, r.text);
await req("POST", `${M}/emails/${fwdId}/schedule`, { now: true });
await sleep(4000);
check("a deleted scheduled email never goes", !find(await list("sent"), `Fwd: ${origSubject}`));

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
