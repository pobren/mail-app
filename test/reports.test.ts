import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanFind, dayList, hasEstimates, isProblem, likeAnywhere, mailboxDays, mergeFound, reportCsv, reportDays, spamReasons, storageCost, sumDays, topSpamSenders, total, type FoundEmail, type MailboxCounts, type ReportsAnswer } from "../shared/reports.ts";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const days = dayList(7, NOW);
const empty = { database: 0, attachments: 0, files: 0, backups: 0 };

const anna: MailboxCounts = {
	countingSince: "2026-10-27",
	counted: [
		{ day: "2026-10-27", kind: "received", n: 10 },
		{ day: "2026-10-27", kind: "spam:checks", n: 3 },
		{ day: "2026-10-28", kind: "sent", n: 4 },
		{ day: "2026-10-28", kind: "failed", n: 1 },
		{ day: "2026-10-28", kind: "spam:blocked", n: 2 },
		{ day: "2026-10-29", kind: "not-spam", n: 1 },
		{ day: "2026-10-01", kind: "received", n: 99 },
	],
	estimated: [{ day: "2026-10-25", received: 5, sent: 2, spam: 1 }],
	failures: [],
	spamSenders: [{ sender: "a@junk.example", count: 3 }, { sender: "b@junk.example", count: 1 }],
	storage: { database: 2 * 1024 ** 3, attachments: 6 * 1024 ** 3, files: 0, backups: 0 },
};
const ben: MailboxCounts = { ...anna, countingSince: "2026-10-20", counted: [{ day: "2026-10-29", kind: "received", n: 2 }], estimated: [], spamSenders: [{ sender: "b@junk.example", count: 4 }], storage: empty };

test("the period is 7, 30 or 90 days, ending today", () => {
	assert.equal(reportDays("90"), 90);
	assert.equal(reportDays("12"), 30);
	assert.deepEqual([days[0], days[6]], ["2026-10-23", "2026-10-29"]);
});

test("days combine the tally with estimates from before it began", () => {
	const a = mailboxDays(anna, days);
	assert.deepEqual(a.get("2026-10-25"), { received: 5, sent: 2, failed: 0, spam: 1 });
	assert.deepEqual(a.get("2026-10-27"), { received: 10, sent: 0, failed: 0, spam: 3 });
	assert.equal(a.has("2026-10-01"), false);
	const all = total(sumDays([a, mailboxDays(ben, days)], days));
	assert.deepEqual(all, { received: 17, sent: 6, failed: 1, spam: 6 });
	assert.equal(hasEstimates([anna, ben], days[0]!), true);
	assert.equal(hasEstimates([ben], days[0]!), false);
});

test("spam reasons, Not spam and the top senders", () => {
	const { why, notSpam } = spamReasons([anna], days);
	assert.equal(why.checks, 3);
	assert.equal(why.blocked, 2);
	assert.equal(notSpam, 1);
	assert.deepEqual(topSpamSenders([anna, ben])[0], { sender: "b@junk.example", count: 5 });
});

test("storage inside Cloudflare's allowance is free; over it is whole dollars", () => {
	assert.equal(storageCost({ database: 2 * 1024 ** 3, attachments: 6 * 1024 ** 3, files: 0, backups: 0 }).dollars, 0);
	// 110 GB of attachments: 100 GB over at $0.015 = $1.50, shown as $2.
	assert.equal(storageCost({ database: 0, attachments: 110 * 1024 ** 3, files: 0, backups: 0 }).dollars, 2);
});

test("the CSV has a row per mailbox per day, and can't run formulas", () => {
	const answer: ReportsAnswer = { days: 7, from: days[0]!, to: days[6]!, mailboxes: [{ ...anna, mailbox: "=cmd@example.com", shared: false }], unreadable: [], people: [], log: [] };
	const lines = reportCsv(answer, NOW).trim().split("\n");
	assert.equal(lines.length, 8);
	assert.equal(lines[0], "Date,Mailbox,Received,Sent,Couldn't send,Spam");
	assert.equal(lines[5], "2026-10-27,'=cmd@example.com,10,0,0,3");
});

test("Find an email: the search is tidied, and % and _ are taken literally", () => {
	assert.equal(cleanFind("  Jane Smith <Jane@Example.COM>  "), "jane smith jane@example.com");
	assert.equal(cleanFind(42), "");
	assert.equal(likeAnywhere("jane"), "%jane%");
	assert.equal(likeAnywhere("100%_off\\"), "%100\\%\\_off\\\\%");
});

test("Find an email: every mailbox's finds are merged newest first, and problems are spam and failed sends", () => {
	const row = (at: string, status: FoundEmail["status"]): FoundEmail => ({ at, mailbox: "a@x.com", from: "b@y.com", to: "a@x.com", subject: "", status });
	const { found, more } = mergeFound([[row("2026-10-01T10:00:00Z", "delivered"), row("2026-10-03T10:00:00Z", "spam")], [row("2026-10-02T10:00:00Z", "failed")]], 2);
	assert.deepEqual(found.map((f) => f.status), ["spam", "failed"]);
	assert.equal(more, true);
	assert.deepEqual(found.map(isProblem), [true, true]);
	assert.equal(isProblem(row("2026-10-01T10:00:00Z", "bin")), false);
});
