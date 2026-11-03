import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSourceUrl, outsideEvents, refreshedWords } from "../shared/outside-calendars.ts";

const ICS = [
	"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:test",
	"BEGIN:VEVENT", "UID:a1", "DTSTART;VALUE=DATE:20261225", "DTEND;VALUE=DATE:20261226", "SUMMARY:Christmas Day", "END:VEVENT",
	"BEGIN:VEVENT", "UID:w1", "DTSTART;TZID=Europe/London:20261102T090000", "DTEND;TZID=Europe/London:20261102T093000", "RRULE:FREQ=WEEKLY;BYDAY=MO", "SUMMARY:Stand-up", "BEGIN:VALARM", "TRIGGER:-PT10M", "END:VALARM", "END:VEVENT",
	"BEGIN:VEVENT", "UID:w1", "RECURRENCE-ID;TZID=Europe/London:20261109T090000", "DTSTART;TZID=Europe/London:20261109T110000", "DTEND;TZID=Europe/London:20261109T113000", "SUMMARY:Stand-up (late)", "END:VEVENT",
	"BEGIN:VEVENT", "UID:c1", "STATUS:CANCELLED", "DTSTART:20261110T100000Z", "DTEND:20261110T110000Z", "SUMMARY:Cancelled", "END:VEVENT",
	"BEGIN:VEVENT", "UID:old", "DTSTART;VALUE=DATE:20200101", "DTEND;VALUE=DATE:20200102", "SUMMARY:Long ago", "END:VEVENT",
	"BEGIN:VEVENT", "UID:g1", "DTSTART:20261111T100000Z", "DTEND:20261111T110000Z", "SUMMARY:With guests", "ATTENDEE:mailto:someone@x.com", "END:VEVENT",
	"END:VCALENDAR",
].join("\r\n");
const now = Date.parse("2026-10-25T12:00:00Z");

test("reads a calendar file", () => {
	const events = outsideEvents(ICS, "cal", "Europe/London", now);
	assert.ok(Array.isArray(events));
	const titles = events.map((e) => e.input.title);
	assert.deepEqual(titles, ["Christmas Day", "Stand-up", "Stand-up (late)", "With guests"]);
	const series = events.find((e) => e.input.title === "Stand-up")!;
	assert.equal(series.input.repeat?.freq, "weekly");
	assert.deepEqual(series.exceptions, ["2026-11-09T09:00"], "the changed date is skipped in the series");
	assert.ok(events.every((e) => e.input.reminders.length === 0 && e.input.guests.length === 0 && e.input.calendarId === "cal"));
});

test("an import keeps old events", () => {
	const events = outsideEvents(ICS, "cal", "Europe/London", now, true);
	assert.ok(Array.isArray(events) && events.some((e) => e.input.title === "Long ago"));
});

test("not a calendar", () => {
	assert.equal(typeof outsideEvents("<html>hello</html>", "cal", "Europe/London"), "string");
});

test("links", () => {
	assert.equal(cleanSourceUrl("webcal://p01-calendars.icloud.com/published/2/abc"), "https://p01-calendars.icloud.com/published/2/abc");
	assert.equal(cleanSourceUrl(" https://www.gov.uk/bank-holidays/england-and-wales.ics "), "https://www.gov.uk/bank-holidays/england-and-wales.ics");
	for (const bad of ["ftp://x.com/a.ics", "javascript:alert(1)", "http://localhost/a.ics", "http://127.0.0.1/a.ics", "http://192.168.1.10/a.ics", "http://10.0.0.1/x", "http://[::1]/x", "https://user:pass@x.com/a.ics", "not a link", ""]) {
		assert.equal(cleanSourceUrl(bad), null, bad);
	}
});

test("updated words", () => {
	assert.equal(refreshedWords(null), "Not updated yet");
	assert.equal(refreshedWords(new Date(now - 30_000).toISOString(), now), "Updated just now");
	assert.equal(refreshedWords(new Date(now - 3 * 3600_000).toISOString(), now), "Updated 3 hours ago");
});
