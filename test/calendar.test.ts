import { test } from "node:test";
import assert from "node:assert/strict";
import {
	cleanEventInput, countBefore, describeReminder, describeRepeat, eachRepeat, occurrencesOf, parseWall, formatWall,
	spanOf, toIcs, zonedToUtc, type CalendarEvent, type Repeat,
} from "../shared/calendar.ts";

const starts = (start: string, repeat: Repeat, n = 6) => {
	const out: string[] = [];
	eachRepeat(parseWall(start), repeat, (ms) => { out.push(formatWall(ms)); return out.length < n; });
	return out;
};

const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
	id: "e1", calendarId: "c1", title: "Team call", allDay: false, start: "2026-10-12T09:00", end: "2026-10-12T09:30",
	timeZone: "Europe/London", location: "", notes: "", color: null, private: false, repeat: null, reminders: [],
	exceptions: [], createdBy: null, createdByName: null, createdAt: "", updatedAt: "", ...over,
});

test("wall-clock times are checked", () => {
	assert.ok(!Number.isNaN(parseWall("2026-10-14T09:00")));
	assert.ok(Number.isNaN(parseWall("2026-02-31")));
	assert.ok(Number.isNaN(parseWall("2026-10-14T25:00")));
});

test("UK times follow the clocks changing", () => {
	// 9 am in London is 08:00 UTC in summer and 09:00 UTC in winter.
	assert.equal(new Date(zonedToUtc(parseWall("2026-10-23T09:00"), "Europe/London")).toISOString(), "2026-10-23T08:00:00.000Z");
	assert.equal(new Date(zonedToUtc(parseWall("2026-10-26T09:00"), "Europe/London")).toISOString(), "2026-10-26T09:00:00.000Z");
	assert.equal(new Date(zonedToUtc(parseWall("2026-10-14T09:00"), "America/New_York")).toISOString(), "2026-10-14T13:00:00.000Z");
});

test("a weekly 9 am meeting stays at 9 am after the clocks go back", () => {
	const ev = event({ repeat: { freq: "weekly", interval: 1 } });
	const got = occurrencesOf(ev, Date.parse("2026-10-19T00:00Z"), Date.parse("2026-11-03T00:00Z")).map((o) => new Date(o.start).toISOString());
	assert.deepEqual(got, ["2026-10-19T08:00:00.000Z", "2026-10-26T09:00:00.000Z", "2026-11-02T09:00:00.000Z"]);
});

test("daily, weekly, monthly and yearly repeats", () => {
	assert.deepEqual(starts("2026-10-14T09:00", { freq: "daily", interval: 2 }, 3), ["2026-10-14T09:00", "2026-10-16T09:00", "2026-10-18T09:00"]);
	assert.deepEqual(starts("2026-10-14T09:00", { freq: "weekly", interval: 1, days: ["MO", "WE", "FR"] }, 4),
		["2026-10-14T09:00", "2026-10-16T09:00", "2026-10-19T09:00", "2026-10-21T09:00"], "starts on the Wednesday, not the Monday before");
	assert.deepEqual(starts("2026-10-14T09:00", { freq: "weekly", interval: 2 }, 3), ["2026-10-14T09:00", "2026-10-28T09:00", "2026-11-11T09:00"]);
	assert.deepEqual(starts("2026-01-31T09:00", { freq: "monthly", interval: 1 }, 3), ["2026-01-31T09:00", "2026-03-31T09:00", "2026-05-31T09:00"], "months without a 31st are skipped");
	// 13 October 2026 is the second Tuesday.
	assert.deepEqual(starts("2026-10-13T18:00", { freq: "monthly", interval: 1, monthlyBy: "weekday" }, 3), ["2026-10-13T18:00", "2026-11-10T18:00", "2026-12-08T18:00"]);
	assert.deepEqual(starts("2026-09-29T18:00", { freq: "monthly", interval: 1, monthlyBy: "weekday" }, 4), ["2026-09-29T18:00", "2026-10-27T18:00", "2026-11-24T18:00", "2026-12-29T18:00"], "the last Tuesday");
	assert.deepEqual(starts("2028-02-29", { freq: "yearly", interval: 1 }, 2), ["2028-02-29T00:00", "2032-02-29T00:00"]);
});

test("repeats stop at the end date or after so many times", () => {
	assert.equal(starts("2026-10-14T09:00", { freq: "daily", interval: 1, until: "2026-10-16" }, 50).length, 3);
	assert.equal(starts("2026-10-14T09:00", { freq: "weekly", interval: 1, days: ["MO", "TU"], count: 5 }, 50).length, 5);
	assert.equal(countBefore(parseWall("2026-10-14T09:00"), { freq: "daily", interval: 1 }, parseWall("2026-10-20T09:00")), 6);
});

test("removed repeats are left out and far-off ranges are quick", () => {
	const ev = event({ repeat: { freq: "daily", interval: 1 }, exceptions: ["2026-10-13T09:00"] });
	const got = occurrencesOf(ev, Date.parse("2026-10-12T00:00Z"), Date.parse("2026-10-15T00:00Z")).map((o) => o.occurrence);
	assert.deepEqual(got, ["2026-10-12T09:00", "2026-10-13T09:00", "2026-10-14T09:00"].filter((k) => k !== "2026-10-13T09:00"));
	const far = occurrencesOf(ev, Date.parse("2090-01-01T00:00Z"), Date.parse("2090-01-08T00:00Z"));
	assert.equal(far.length, 7);
});

test("all-day events span their days", () => {
	const ev = event({ allDay: true, start: "2026-10-14", end: "2026-10-16" });
	assert.equal(occurrencesOf(ev, Date.parse("2026-10-15T12:00Z"), Date.parse("2026-10-15T13:00Z")).length, 1);
	assert.equal(occurrencesOf(ev, Date.parse("2026-10-16T12:00Z"), Date.parse("2026-10-17T00:00Z")).length, 0);
});

test("span: open-ended repeats have no end", () => {
	assert.equal(spanOf(event({ repeat: { freq: "weekly", interval: 1 } })).last, null);
	assert.equal(new Date(spanOf(event({ repeat: { freq: "daily", interval: 1, count: 3 } })).last!).toISOString(), "2026-10-14T08:30:00.000Z");
});

test("checking events from the app", () => {
	assert.equal(typeof cleanEventInput({ start: "2026-10-14T10:00", end: "2026-10-14T09:00" }), "string");
	assert.equal(typeof cleanEventInput({ allDay: true, start: "2026-10-14", end: "2026-10-14" }), "string");
	const ok = cleanEventInput({ title: "  Dentist ", start: "2026-10-14T10:00", end: "2026-10-14T10:30", timeZone: "Nowhere/Land", color: "pink", reminders: [10, 10, -5, 60], repeat: { freq: "weekly", interval: 0, days: ["XX", "FR"] } });
	assert.ok(typeof ok === "object");
	assert.equal(ok.title, "Dentist");
	assert.equal(ok.timeZone, "Europe/London");
	assert.equal(ok.color, "pink");
	assert.deepEqual(ok.reminders, [10, 60]);
	assert.deepEqual(ok.repeat, { freq: "weekly", interval: 1, days: ["FR"] });
});

test("repeats and reminders in plain words", () => {
	assert.equal(describeRepeat({ freq: "weekly", interval: 1, days: ["MO", "TU", "WE", "TH", "FR"] }, "2026-10-14T09:00"), "Every weekday (Monday to Friday)");
	assert.equal(describeRepeat({ freq: "weekly", interval: 2, days: ["WE", "MO"] }, "2026-10-14T09:00"), "Every 2 weeks on Monday and Wednesday");
	assert.equal(describeRepeat({ freq: "monthly", interval: 1, monthlyBy: "weekday" }, "2026-10-13T18:00"), "Every month on the second Tuesday");
	assert.equal(describeRepeat({ freq: "monthly", interval: 1 }, "2026-10-22T18:00"), "Every month on the 22nd");
	assert.equal(describeRepeat({ freq: "yearly", interval: 1, until: "2030-03-03" }, "2026-10-14"), "Every year on 14 October, until 3 March 2030");
	assert.equal(describeReminder(0), "When it starts");
	assert.equal(describeReminder(60), "1 hour before");
	assert.equal(describeReminder(2880), "2 days before");
});

test(".ics export", () => {
	const ics = toIcs("Home", [event({ title: "Call; with, Sam", repeat: { freq: "weekly", interval: 1 }, exceptions: ["2026-10-19T09:00"], reminders: [10] })]);
	assert.match(ics, /DTSTART;TZID=Europe\/London:20261012T090000/);
	assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO/);
	assert.match(ics, /EXDATE;TZID=Europe\/London:20261019T090000/);
	assert.match(ics, /SUMMARY:Call\\; with\\, Sam/);
	assert.match(ics, /TRIGGER:-PT10M/);
});
