// The spam filter end to end against a local Mail App (npm run dev:local): SpamAssassin's rules, risky
// attachments, learning from Spam and Not spam, Admin > Spam filter and "Forward spam too".
//
//   node test/simulate-spam.mjs [http://127.0.0.1:5173]
//
// Needs a fresh local store (delete .wrangler/state first). The AI check itself needs Workers AI, so
// locally only its settings are tried.
const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const OWNER = "owner@example.com";
const BOX = "owner@example.com";
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
async function deliver({ from, fromName = "", subject, body, html, replyTo, attachment, noHeaders = false }) {
	const boundary = "b" + crypto.randomUUID();
	const head = [
		`From: ${fromName ? `"${fromName}" ` : ""}<${from}>`,
		`To: ${BOX}`,
		`Subject: ${subject}`,
		...(noHeaders ? [] : [`Message-ID: <${crypto.randomUUID()}@${from.split("@")[1]}>`, `Date: ${new Date().toUTCString()}`]),
		...(replyTo ? [`Reply-To: ${replyTo}`] : []),
		"MIME-Version: 1.0",
	];
	let eml;
	if (attachment) {
		eml = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", body, `--${boundary}`,
			`Content-Type: application/octet-stream; name="${attachment}"`, `Content-Disposition: attachment; filename="${attachment}"`, "Content-Transfer-Encoding: base64", "", btoa("MZ fake program"), `--${boundary}--`, ""].join("\r\n");
	} else if (html) {
		eml = [...head, "Content-Type: text/html; charset=utf-8", "", html, ""].join("\r\n");
	} else {
		eml = [...head, "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n");
	}
	const res = await fetch(`${BASE}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(BOX)}`, { method: "POST", body: eml });
	return res.status;
}
async function folderOf(subject) {
	for (const folder of ["inbox", "spam"]) {
		const r = await req("GET", `/api/v1/mailboxes/${BOX}/emails?folder=${folder}&limit=200`);
		const list = Array.isArray(r.json) ? r.json : r.json?.emails ?? [];
		const hit = list.find((e) => e.subject === subject);
		if (hit) return { folder, email: hit };
	}
	return { folder: null };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let r = await req("GET", "/api/v1/me");
check("owner is admin", r.json?.role === "admin", r.text);
r = await req("POST", "/api/v1/mailboxes", { email: BOX, name: "Owner" });
check("mailbox made", r.status === 201, r.text);

const SCAM = `Dear Friend,
I am Barrister James Okoro, the personal lawyer to the late Mr. Smith, a foreigner who died in a car crash.
He left the total sum of US$12.5 million in a security company. As the beneficiary you will receive 40%.
This transaction is 100% risk-free. Kindly reply urgently with your private telephone and contact details.`;

const mails = [
	{ subject: "Lunch on Friday?", from: "jo@friend.example", fromName: "Jo", body: "Fancy lunch on Friday? There's a new place on the high street.", want: "inbox" },
	{ subject: "Invoice 1043", from: "accounts@printers.example", fromName: "Printers Ltd", body: "Dear Sir,\nPlease find attached invoice 1043 for 250 dollars, due in 30 days.\nYours faithfully,\nAccounts", want: "inbox" },
	{ subject: "New this week", from: "news@shop.example", fromName: "Shop", html: `<p>Our new range is in. <a href="https://bit.ly/abc">See it</a></p>`, want: "inbox" },
	{ subject: "URGENT ASSISTANCE", from: "james@lawfirm.example", body: SCAM, replyTo: "james.okoro@gmail.com", want: "spam", why: "advance-fee" },
	{ subject: "Overdue invoice", from: "accounts@supplier.example", body: "Please see the attached invoice and pay today.", attachment: "Invoice_4471.pdf.exe", replyTo: "accounts.dept@outlook.com", want: "spam", why: "risky-attachment" },
	{ subject: "Loan approved", from: "loans@quickcash.example", body: "Your loan is approved. Send:\nFull name:\nHome address:\nDate of birth:\nPhone number:\nBank account number:\n", replyTo: "quickcash.loans@gmail.com", want: "spam", why: "asks-details" },
];
for (const m of mails) {
	const status = await deliver(m);
	check(`delivered ${m.subject}`, status < 300, String(status));
}
await wait(500);
for (const m of mails) {
	const { folder, email } = await folderOf(m.subject);
	check(`${m.subject} -> ${m.want}`, folder === m.want, `got ${folder}`);
	if (m.why && email) {
		const t = await req("GET", `/api/v1/mailboxes/${BOX}/threads/${email.thread_id ?? email.id}`);
		const headers = JSON.stringify(t.json ?? "");
		check(`${m.subject} says why (${m.why})`, headers.includes(m.why), headers.slice(0, 200));
	}
}

// Learning: pressing Not spam and moving to Spam teach the mailbox.
r = await req("GET", `/api/v1/mailboxes/${BOX}/spam/learning`);
const before = r.json;
check("learning summary", typeof before?.spam === "number", r.text);
const lunch = (await folderOf("Lunch on Friday?")).email;
r = await req("POST", `/api/v1/mailboxes/${BOX}/emails/${lunch.id}/move`, { folderId: "spam" });
check("moved to spam", r.status === 200, r.text);
r = await req("GET", `/api/v1/mailboxes/${BOX}/spam/learning`);
check("learnt one more spam", r.json?.spam === before.spam + 1, `${JSON.stringify(before)} -> ${r.text}`);
r = await req("POST", `/api/v1/mailboxes/${BOX}/spam/not-spam`, { sender: "jo@friend.example", emailId: lunch.id });
check("not spam", r.status === 200, r.text);
r = await req("GET", `/api/v1/mailboxes/${BOX}/spam/learning`);
check("relearnt as genuine, not counted twice", r.json?.spam === before.spam && r.json?.ham === before.ham + 1, r.text);

// Admin > Spam filter: off by default, limit saved.
r = await req("GET", "/api/v1/spam-filter");
check("AI off by default", r.json?.settings?.ai === false && r.json?.settings?.aiDailyLimit === 1400, r.text);
r = await req("PUT", "/api/v1/spam-filter", { ai: true, aiDailyLimit: 500 });
check("AI switched on with a limit", r.json?.settings?.ai === true && r.json?.settings?.aiDailyLimit === 500, r.text);
r = await req("PUT", "/api/v1/spam-filter", { ai: false, aiDailyLimit: 1400 });
check("AI switched off again", r.json?.settings?.ai === false, r.text);

// Forward spam too.
r = await req("PUT", `/api/v1/mailboxes/${BOX}/forwarding`, { enabled: true, email: "old@gmail.com", keepCopy: true, includeSpam: true });
check("forward spam too saved", r.json?.forwarding?.includeSpam === true, r.text);

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
