import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_AHEAD_MS, formatWhen, noReplyDueAt, snoozeChoices, validDueAt } from "../shared/reminders.ts";

const ids = (now: Date) => snoozeChoices(now).map((c) => c.id);

test("snooze choices on a weekday morning", () => {
	const now = new Date(2026, 9, 21, 9, 10); // Wednesday 21 Oct, 09:10
	assert.deepEqual(ids(now), ["later", "tomorrow", "weekend", "next-week"]);
	const [later, tomorrow, weekend, nextWeek] = snoozeChoices(now).map((c) => c.at);
	assert.equal(later.getHours(), 12);
	assert.equal(later.getMinutes(), 0);
	assert.deepEqual([tomorrow.getDate(), tomorrow.getHours()], [22, 8]);
	assert.deepEqual([weekend.getDay(), weekend.getDate(), weekend.getHours()], [6, 24, 8]);
	assert.deepEqual([nextWeek.getDay(), nextWeek.getDate(), nextWeek.getHours()], [1, 26, 8]);
});

test("no 'later today' in the evening, and no 'this weekend' at the weekend", () => {
	assert.deepEqual(ids(new Date(2026, 9, 21, 19, 0)), ["tomorrow", "weekend", "next-week"]);
	assert.deepEqual(ids(new Date(2026, 9, 23, 18, 30)), ["tomorrow", "next-week"]); // Friday evening
	assert.deepEqual(ids(new Date(2026, 9, 24, 10, 0)), ["later", "tomorrow", "next-week"]); // Saturday
	// Sunday's "next week" is the next day.
	const sunday = snoozeChoices(new Date(2026, 9, 25, 20, 0));
	assert.equal(sunday.find((c) => c.id === "next-week")!.at.getDate(), 26);
});

test("later today rounds to the half hour", () => {
	const later = snoozeChoices(new Date(2026, 9, 21, 9, 40))[0].at;
	assert.deepEqual([later.getHours(), later.getMinutes()], [12, 30]);
});

test("due times must be from a minute to a year ahead", () => {
	const now = Date.UTC(2026, 9, 21);
	assert.equal(validDueAt(now + 3_600_000, now), true);
	assert.equal(validDueAt(now + 10_000, now), false);
	assert.equal(validDueAt(now + MAX_AHEAD_MS + 1, now), false);
	assert.equal(validDueAt("tomorrow", now), false);
	assert.equal(validDueAt(Number.NaN, now), false);
});

test("'no reply in 3 days' is three days on at the same time", () => {
	const now = new Date(2026, 9, 21, 14, 5);
	const due = new Date(noReplyDueAt(3, now));
	assert.deepEqual([due.getDate(), due.getHours(), due.getMinutes()], [24, 14, 5]);
});

test("due times in words", () => {
	const now = new Date(2026, 9, 21, 9, 0);
	assert.equal(formatWhen(new Date(2026, 9, 21, 15, 0).getTime(), now), "today at 15:00");
	assert.equal(formatWhen(new Date(2026, 9, 22, 8, 0).getTime(), now), "tomorrow at 08:00");
	assert.equal(formatWhen(new Date(2026, 9, 24, 8, 0).getTime(), now), "Saturday at 08:00");
	assert.equal(formatWhen(new Date(2026, 10, 3, 8, 0).getTime(), now), "Tue 3 Nov at 08:00");
	assert.equal(formatWhen(new Date(2027, 0, 4, 8, 0).getTime(), now), "Mon 4 Jan 2027 at 08:00");
});
