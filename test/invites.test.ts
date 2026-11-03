import assert from "node:assert/strict";
import { test } from "node:test";
import { recurrenceIdOf, recurrenceWall, type CalendarEvent } from "../shared/calendar.ts";
import {
	eventFromInvite, exceptionsFromInvite, findMeetingLink, inviteIcs, inviteSubject, joinWords, meetingKind, newJitsiLink,
	inviteMime, parseIcs, recurrenceIdFromInvite, repeatFromRrule, vtimezone, whenText, zoneFromTzid,
} from "../shared/invites.ts";

const outlook = [
	"BEGIN:VCALENDAR",
	"METHOD:REQUEST",
	"PRODID:Microsoft Exchange Server 2010",
	"VERSION:2.0",
	"BEGIN:VTIMEZONE",
	"TZID:GMT Standard Time",
	"BEGIN:STANDARD",
	"DTSTART:16010101T020000",
	"TZOFFSETFROM:+0100",
	"TZOFFSETTO:+0000",
	"END:STANDARD",
	"BEGIN:DAYLIGHT",
	"DTSTART:16010101T010000",
	"TZOFFSETFROM:+0000",
	"TZOFFSETTO:+0100",
	"END:DAYLIGHT",
	"END:VTIMEZONE",
	"BEGIN:VEVENT",
	'ORGANIZER;CN="Hannah Clarke":mailto:Hannah@Example.co.uk',
	'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Paul:mailto:paul@example.com',
	"ATTENDEE;PARTSTAT=ACCEPTED;CN=Sam:mailto:sam@example.co.uk",
	"DESCRIPTION:Agenda\\, notes\\nJoin: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=x",
	"UID:040000008200E00074C5B7101A82E0080000000",
	"SUMMARY;LANGUAGE=en-GB:Planning catch-up",
	"DTSTART;TZID=GMT Standard Time:20261020T143000",
	"DTEND;TZID=GMT Standard Time:20261020T153000",
	"SEQUENCE:2",
	"LOCATION:Microsoft Teams Meeting",
	"STATUS:CONFIRMED",
	"END:VEVENT",
	"END:VCALENDAR",
].join("\r\n");

test("reads an Outlook invite with its own time zone name", () => {
	const file = parseIcs(outlook);
	assert.equal(file.method, "REQUEST");
	assert.equal(file.events.length, 1);
	const ev = file.events[0];
	assert.equal(ev.title, "Planning catch-up");
	assert.equal(ev.sequence, 2);
	assert.deepEqual(ev.organizer, { email: "hannah@example.co.uk", name: "Hannah Clarke" });
	assert.equal(ev.attendees.length, 2);
	assert.equal(ev.attendees[1].status, "accepted");
	assert.ok(ev.notes.startsWith("Agenda, notes\nJoin:"));
	const input = eventFromInvite(ev, file, "America/New_York", "cal");
	assert.equal(input.timeZone, "Europe/London");
	assert.equal(input.start, "2026-10-20T14:30");
	assert.equal(input.end, "2026-10-20T15:30");
	assert.match(input.meetingUrl, /^https:\/\/teams\.microsoft\.com\//);
	assert.equal(input.guests.length, 2);
});

test("reads a Google invite in UTC with a Meet link and a repeat", () => {
	const file = parseIcs([
		"BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT",
		"DTSTART:20261021T090000Z", "DTEND:20261021T093000Z",
		"RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=6",
		"EXDATE:20261028T090000Z",
		"UID:abc123@google.com", "SUMMARY:Stand-up",
		"X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
		"ORGANIZER;CN=Sam:mailto:sam@gmail.com",
		"ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=paul@example.com;X-NUM-GUESTS=0:mailto:paul@example.com",
		"END:VEVENT", "END:VCALENDAR",
	].join("\n"));
	const ev = file.events[0];
	const input = eventFromInvite(ev, file, "Europe/London", "cal");
	assert.equal(input.timeZone, "Europe/London");
	assert.equal(input.start, "2026-10-21T10:00"); // British Summer Time until 25 October
	assert.equal(input.meetingUrl, "https://meet.google.com/abc-defg-hij");
	assert.deepEqual(input.repeat, { freq: "weekly", interval: 1, days: ["WE"], count: 6 });
	assert.deepEqual(exceptionsFromInvite(ev, file, input), ["2026-10-28T09:00"]);
});

test("an all-day invite without an end lasts the day", () => {
	const file = parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nSUMMARY:Holiday\nDTSTART;VALUE=DATE:20261224\nEND:VEVENT\nEND:VCALENDAR");
	const input = eventFromInvite(file.events[0], file, "Europe/London", "cal");
	assert.equal(input.allDay, true);
	assert.equal(input.start, "2026-12-24");
	assert.equal(input.end, "2026-12-25");
});

test("long lines folded over two lines are joined back up", () => {
	const file = parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:y\r\nSUMMARY:A very long\r\n  title\r\nDTSTART:20261020T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR");
	assert.equal(file.events[0].title, "A very long title");
});

test("time zone names from other apps", () => {
	assert.equal(zoneFromTzid("GMT Standard Time"), "Europe/London");
	assert.equal(zoneFromTzid("Europe/Paris"), "Europe/Paris");
	assert.equal(zoneFromTzid("/mozilla.org/20050126_1/Europe/London"), "Europe/London");
	assert.equal(zoneFromTzid("(UTC+00:00) Dublin, Edinburgh, Lisbon, London"), "Europe/London");
	assert.equal(zoneFromTzid("Made Up Time"), null);
});

test("repeats from other apps", () => {
	assert.deepEqual(repeatFromRrule("FREQ=MONTHLY;BYDAY=2TU;UNTIL=20270301T000000Z"), { freq: "monthly", interval: 1, monthlyBy: "weekday", until: "2027-03-01" });
	assert.deepEqual(repeatFromRrule("FREQ=DAILY;INTERVAL=2"), { freq: "daily", interval: 2 });
	assert.equal(repeatFromRrule("FREQ=HOURLY"), null);
});

test("video call links", () => {
	assert.equal(meetingKind("https://us02web.zoom.us/j/123"), "zoom");
	assert.equal(meetingKind("https://teams.microsoft.com/l/meetup-join/x"), "teams");
	assert.equal(meetingKind("https://meet.google.com/abc"), "meet");
	assert.equal(joinWords("https://meet.jit.si/Mail-abc"), "Join video call");
	assert.equal(findMeetingLink("Room 3", "Dial in: https://zoom.us/j/9876543210?pwd=abc."), "https://zoom.us/j/9876543210?pwd=abc");
	assert.equal(findMeetingLink("See https://example.com"), "");
	assert.match(newJitsiLink(), /^https:\/\/meet\.jit\.si\/Mail-[a-z2-9]{14}$/);
});

test("the London time zone block lists the clocks changing", () => {
	const block = vtimezone("Europe/London", Date.UTC(2026, 9, 20));
	assert.equal(block[0], "BEGIN:VTIMEZONE");
	assert.ok(block.includes("TZID:Europe/London"));
	assert.ok(block.includes("DTSTART:20261025T020000"), "clocks go back at 2am BST on 25 October 2026");
	assert.ok(block.includes("DTSTART:20270328T010000"), "and forward at 1am GMT on 28 March 2027");
	assert.ok(block.filter((l) => l === "BEGIN:DAYLIGHT").length >= 5);
});

const ours: CalendarEvent = {
	id: "6f1d2c3b-1111-4222-8333-444455556666", calendarId: "cal", title: "Team lunch, upstairs", allDay: false,
	start: "2026-10-20T12:30", end: "2026-10-20T13:30", timeZone: "Europe/London", location: "", notes: "Bring ideas",
	color: null, private: false, repeat: null, reminders: [10], exceptions: [],
	guests: [{ email: "sam@example.co.uk", name: "Sam", status: "needs-action" }], meetingUrl: "https://meet.jit.si/Mail-abcdefghijkmnp",
	createdBy: "paul@example.com", createdByName: "Paul", createdAt: "", updatedAt: "", uid: null, organizer: null, sequence: 1, recurrenceId: null,
};

test("our invite reads back the same", () => {
	const ics = inviteIcs("REQUEST", ours, { email: "paul@example.com", name: "Paul O'Brien" }, ours.guests, Date.UTC(2026, 9, 15));
	assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
	assert.match(ics, /\r\nMETHOD:REQUEST\r\n/);
	assert.match(ics, /\r\nBEGIN:VTIMEZONE\r\n/);
	assert.match(ics, /RSVP=TRUE:mailto:sam@example\.co\.uk/);
	assert.ok(ics.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75));
	const file = parseIcs(ics);
	const ev = file.events[0];
	assert.equal(ev.uid, `${ours.id}@mail-app.local`);
	assert.equal(ev.sequence, 1);
	assert.equal(ev.title, "Team lunch, upstairs");
	assert.deepEqual(ev.organizer, { email: "paul@example.com", name: "Paul O'Brien" });
	const back = eventFromInvite(ev, file, "Asia/Tokyo", "cal");
	assert.equal(back.timeZone, "Europe/London");
	assert.equal(back.start, ours.start);
	assert.equal(back.end, ours.end);
	assert.equal(back.meetingUrl, ours.meetingUrl);
});

test("an answer names just us, with our answer", () => {
	const ics = inviteIcs("REPLY", { ...ours, uid: "abc@google.com", organizer: { email: "sam@gmail.com", name: "" } }, { email: "sam@gmail.com", name: "" }, [{ email: "paul@example.com", name: "Paul", status: "tentative" }]);
	const file = parseIcs(ics);
	assert.equal(file.method, "REPLY");
	assert.equal(file.events[0].uid, "abc@google.com");
	assert.deepEqual(file.events[0].attendees, [{ email: "paul@example.com", name: "Paul", status: "tentative" }]);
	assert.doesNotMatch(ics, /RSVP=TRUE/);
});

test("words for invite emails", () => {
	assert.equal(whenText(ours), "Tuesday 20 October 2026, 12:30 to 13:30 (Europe/London)");
	assert.equal(whenText({ allDay: true, start: "2026-12-24", end: "2026-12-27", timeZone: "Europe/London" }), "Thursday 24 December 2026 to Saturday 26 December 2026");
	assert.equal(inviteSubject("REQUEST", ours), "Invitation: Team lunch, upstairs @ Tue 20 Oct 2026 12:30");
	assert.equal(inviteSubject("REQUEST", ours, { update: true }), "Updated invitation: Team lunch, upstairs @ Tue 20 Oct 2026 12:30");
	assert.equal(inviteSubject("CANCEL", ours), "Cancelled: Team lunch, upstairs @ Tue 20 Oct 2026 12:30");
	assert.equal(inviteSubject("REPLY", ours, { answer: "declined" }), "Declined: Team lunch, upstairs @ Tue 20 Oct 2026 12:30");
});

test("one date of a series, changed on its own", () => {
	const series = { ...ours, repeat: { freq: "weekly" as const, interval: 1 } };
	const rid = recurrenceIdOf(series, "2026-10-27T12:30");
	assert.equal(rid, "2026-10-27T12:30:00.000Z"); // GMT again after 25 October
	assert.equal(recurrenceWall(series, rid), "2026-10-27T12:30");
	assert.equal(recurrenceIdOf({ allDay: true, timeZone: "Europe/London" }, "2026-12-24"), "2026-12-24");
	const moved = { ...series, repeat: null, start: "2026-10-27T14:00", end: "2026-10-27T15:00", uid: `${ours.id}@mail-app.local`, recurrenceId: rid };
	const ics = inviteIcs("REQUEST", moved, { email: "paul@example.com", name: "Paul" }, ours.guests);
	assert.match(ics, /\r\nRECURRENCE-ID:20261027T123000Z\r\n/);
	assert.doesNotMatch(ics, /RRULE/);
	const file = parseIcs(ics);
	assert.equal(file.events[0].uid, `${ours.id}@mail-app.local`);
	assert.equal(recurrenceIdFromInvite(file.events[0], file, "Europe/London"), rid);
	// Outlook names the date in its own time zone.
	const outlookOne = parseIcs(outlook.replace("SEQUENCE:2", "SEQUENCE:3\r\nRECURRENCE-ID;TZID=GMT Standard Time:20261020T143000"));
	assert.equal(recurrenceIdFromInvite(outlookOne.events[0], outlookOne, "Europe/London"), "2026-10-20T13:30:00.000Z");
});

test("the invite email has the calendar part beside the words, and the file", async () => {
	const { default: PostalMime } = await import("postal-mime");
	const ics = inviteIcs("REQUEST", ours, { email: "paul@example.com", name: "Paul O'Brien" }, ours.guests);
	const raw = inviteMime({
		from: { email: "paul@example.com", name: "Paul O'Brien" }, to: { email: "sam@example.co.uk", name: "Sam" },
		subject: "Invitation: Team lunch — upstairs", text: "Hello", html: "<p>Hello</p>", ics, method: "REQUEST", id: "abc",
	});
	assert.match(raw, /^From: "Paul O'Brien" <paul@example\.com>\r\n/);
	assert.match(raw, /\r\nContent-Type: text\/calendar; charset="UTF-8"; method=REQUEST\r\n/);
	const mail = await PostalMime.parse(raw);
	assert.equal(mail.subject, "Invitation: Team lunch — upstairs");
	assert.equal(mail.text?.trim(), "Hello");
	const cal = mail.attachments.filter((a) => /calendar|ics/.test(a.mimeType));
	assert.ok(cal.length >= 1);
	const text = new TextDecoder().decode(cal[0].content as ArrayBuffer);
	assert.equal(parseIcs(text).events[0].title, "Team lunch, upstairs");
});
