import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceFeePoints, asksForDetails, drugPoints, hiddenRecipients, isShortener, oddHeaderPoints, riskyAttachment } from "../shared/spam-rules.ts";
import { SPAM_THRESHOLD, spamChecks, spamScore } from "../shared/spam-checks.ts";
import { MIN_LEARNT, learntFinding, spamProbability, tokensFor, type TokenCounts } from "../shared/spam-learning.ts";
import { DEFAULT_DAILY_LIMIT, MAX_DAILY_LIMIT, cleanSpamFilterSettings, readSpamAiAnswer, spamAiMessage, spamAiPoints } from "../shared/spam-ai.ts";

const checks = (found: { check: string }[]) => found.map((f) => f.check).sort();
const goodHeaders = [
	{ key: "date", value: "Wed, 29 Oct 2026 10:00:00 +0000" },
	{ key: "message-id", value: "<abc@mail.example>" },
	{ key: "to", value: "paul@example.com" },
];

const SCAM_419 = `Dear Friend,
I am Barrister James Okoro, the personal lawyer to the late Mr. Smith, a foreigner who died in a car crash.
He left the total sum of US$12.5 million in a security company. As the beneficiary you will receive 40%.
This transaction is 100% risk-free. Kindly reply urgently with your private telephone and contact details.`;

test("advance-fee scams: more phrases, more points", () => {
	assert.equal(advanceFeePoints(SCAM_419), 4);
	assert.equal(advanceFeePoints("Dear Sir, please find our invoice for 400 dollars attached. Yours faithfully, Jo"), 0, "two phrases is ordinary business mail");
	assert.equal(advanceFeePoints("Hi Paul, are we still on for Friday?"), 0);
});

test("drug spam", () => {
	assert.equal(drugPoints("Buy VIAGRA online pharmacy, no prescription needed"), 3);
	assert.equal(drugPoints("Cheap VIAGRA here"), 2);
	assert.equal(drugPoints("Generic viagra overnight"), 3);
	assert.equal(drugPoints("The pharmacy is closed on Sunday"), 0);
});

test("forms asking for personal details", () => {
	const form = "Please send:\nFull name:\nHome address:\nDate of birth:\nPhone number: ______\nBank account number:\n";
	assert.equal(asksForDetails(form), true);
	assert.equal(asksForDetails("Name: Jo Bloggs\nAddress: 1 High St\nPhone: 0123\nEmail: jo@x.com"), false, "a filled-in contact form notification");
	assert.equal(asksForDetails("Thanks for your order."), false);
});

test("header checks", () => {
	assert.equal(oddHeaderPoints(goodHeaders), 0);
	assert.equal(oddHeaderPoints([{ key: "to", value: "a@b.com" }]), 3, "no Date and no Message-ID");
	assert.equal(oddHeaderPoints([{ key: "date", value: "Wed, 29 Oct 2026 10:00:00 +0000" }]), 1, "no Message-ID");
	assert.equal(oddHeaderPoints([{ key: "date", value: "Mon, 9 Nov 2026 10:00:00 +0000" }, { key: "message-id", value: "<x@y>" }], Date.parse("2026-10-29T10:00:00Z")), 2, "dated in the future");
	assert.equal(oddHeaderPoints(undefined), 0, "no headers, no judgement");
	assert.equal(hiddenRecipients([{ key: "reply-to", value: "x@y.com" }, { key: "date", value: "x" }]), true);
	assert.equal(hiddenRecipients([{ key: "reply-to", value: "x@y.com" }, { key: "to", value: "a@b.com" }]), false);
});

test("risky attachments and link shorteners", () => {
	assert.equal(riskyAttachment(["invoice.pdf.exe"]), "invoice.pdf.exe");
	assert.equal(riskyAttachment(["Payment_Advice.html"]), "Payment_Advice.html");
	assert.equal(riskyAttachment(["report.xlsm"]), "report.xlsm");
	assert.equal(riskyAttachment(["photo.jpg", "minutes.docx", "accounts.pdf", "data.xlsx"]), null);
	assert.equal(isShortener("bit.ly"), true);
	assert.equal(isShortener("www.tinyurl.com"), true);
	assert.equal(isShortener("t.co"), false, "Twitter's own links aren't a sign of anything");
});

test("a 419 scam and a fake invoice reach Spam; real business mail doesn't", () => {
	const scam = spamChecks({ sender: "james@lawfirm-example.com", subject: "URGENT ASSISTANCE", text: SCAM_419, headers: goodHeaders, replyTo: "james.okoro@gmail.com" });
	assert.ok(spamScore(scam) >= SPAM_THRESHOLD, JSON.stringify(scam));
	assert.ok(checks(scam).includes("advance-fee") && checks(scam).includes("freemail-reply"));

	const malware = spamChecks({ sender: "accounts@supplier-x.example", subject: "Overdue invoice", text: "Please see the attached invoice and pay today.", attachments: ["Invoice_4471.pdf.exe"], headers: [{ key: "to", value: "a@b.com" }] });
	assert.ok(spamScore(malware) >= SPAM_THRESHOLD, JSON.stringify(malware));

	const supplier = spamChecks({
		sender: "accounts@printers.example", senderName: "Printers Ltd", subject: "Invoice 1043",
		text: "Dear Sir,\nPlease find attached invoice 1043 for 250 dollars, due in 30 days.\nYours faithfully,\nAccounts",
		attachments: ["invoice-1043.pdf"], headers: goodHeaders,
	});
	assert.ok(spamScore(supplier) < SPAM_THRESHOLD, JSON.stringify(supplier));

	const newsletter = spamChecks({
		sender: "news@shop.example", senderName: "Shop", subject: "New this week",
		html: `<p>Our new range is in. <a href="https://bit.ly/abc">See it</a></p>`, headers: goodHeaders,
	});
	assert.ok(spamScore(newsletter) < SPAM_THRESHOLD, JSON.stringify(newsletter));
});

// -- Learning -------------------------------------------------------------------------------------

function learnt(spam: string[][], ham: string[][]): TokenCounts {
	const tokens = new Map<string, { spam: number; ham: number }>();
	for (const t of spam.flat()) tokens.set(t, { spam: (tokens.get(t)?.spam ?? 0) + 1, ham: tokens.get(t)?.ham ?? 0 });
	for (const t of ham.flat()) tokens.set(t, { spam: tokens.get(t)?.spam ?? 0, ham: (tokens.get(t)?.ham ?? 0) + 1 });
	return { spam: spam.length, ham: ham.length, tokens };
}

test("tokens: words, subject words, links and sender", () => {
	const t = tokensFor({ sender: "Jo@Example.com", subject: "Cheap Watches", body: `<p>Buy <a href="https://www.watches.example/x">watches</a> now</p>` });
	assert.ok(t.includes("f:jo@example.com") && t.includes("f:@example.com"));
	assert.ok(t.includes("s:cheap") && t.includes("s:watches"));
	assert.ok(t.includes("u:watches.example") && t.includes("buy"));
	assert.ok(!t.includes("the"));
});

test("learning: nothing until enough is learnt, then spam-like mail scores high", () => {
	const spamMail = (i: number) => tokensFor({ sender: `x${i}@cheap${i}.example`, subject: "Replica watches cheap", body: "Best replica watches, cheap prices, order today" });
	const hamMail = (i: number) => tokensFor({ sender: `colleague${i}@example.com`, subject: "Meeting notes", body: "Here are the notes from Tuesday's meeting about the roadmap" });
	const few = learnt([spamMail(1)], [hamMail(1)]);
	assert.equal(spamProbability(spamMail(99), few), null);

	const counts = learnt(Array.from({ length: MIN_LEARNT }, (_, i) => spamMail(i)), Array.from({ length: MIN_LEARNT }, (_, i) => hamMail(i)));
	const p = spamProbability(tokensFor({ sender: "new@cheap-new.example", subject: "Cheap replica watches", body: "replica watches order today" }), counts)!;
	assert.ok(p > 0.99, String(p));
	assert.equal(learntFinding(p)?.check, "learnt-spam");
	const q = spamProbability(tokensFor({ sender: "new@example.com", subject: "Meeting notes", body: "notes from the roadmap meeting" }), counts)!;
	assert.ok(q < 0.01, String(q));
	assert.deepEqual(learntFinding(q), { check: "learnt-genuine", points: -2 });
	assert.equal(learntFinding(0.5), null);
});

// -- AI check -------------------------------------------------------------------------------------

test("AI settings: off by default, limit kept sensible", () => {
	assert.deepEqual(cleanSpamFilterSettings(null), { ai: false, aiDailyLimit: DEFAULT_DAILY_LIMIT });
	assert.equal(cleanSpamFilterSettings({ ai: "yes" }).ai, false);
	assert.equal(cleanSpamFilterSettings({ ai: true, aiDailyLimit: 5_000_000 }).aiDailyLimit, MAX_DAILY_LIMIT);
	assert.equal(cleanSpamFilterSettings({ aiDailyLimit: -3 }).aiDailyLimit, DEFAULT_DAILY_LIMIT);
	assert.equal(cleanSpamFilterSettings({ aiDailyLimit: 0 }).aiDailyLimit, 0);
});

test("AI answers: read safely, only ever add points", () => {
	assert.deepEqual(readSpamAiAnswer('Sure! {"verdict":"phishing","confidence":92,"reason":"Fake bank login page."}'), { verdict: "phishing", confidence: 92, reason: "Fake bank login page." });
	assert.equal(readSpamAiAnswer({ verdict: "spam", confidence: 70, reason: "x" }).verdict, "spam");
	assert.equal(readSpamAiAnswer("not json at all").verdict, "ok");
	assert.equal(readSpamAiAnswer('{"verdict":"definitely fine"}').verdict, "ok");
	assert.equal(readSpamAiAnswer(`{"verdict":"spam","confidence":90,"reason":"${"a".repeat(500)}"}`).reason.length, 120);
	assert.equal(spamAiPoints({ verdict: "spam", confidence: 90, reason: "" }), 5);
	assert.equal(spamAiPoints({ verdict: "spam", confidence: 75, reason: "" }), 3);
	assert.equal(spamAiPoints({ verdict: "spam", confidence: 20, reason: "" }), 0);
	assert.equal(spamAiPoints({ verdict: "ok", confidence: 99, reason: "" }), 0);
});

test("the AI is given who it's from, the subject, link sites and the start of the text", () => {
	const msg = spamAiMessage({ sender: "a@b.example", senderName: "Bob", replyTo: null, subject: "Hello", text: "x ".repeat(10_000), links: ["b.example", "b.example", "c.example"] });
	assert.match(msg, /^From: Bob <a@b\.example>\nSubject: Hello\nLinks go to: b\.example, c\.example\n\n/);
	assert.ok(msg.length < 4300);
});
