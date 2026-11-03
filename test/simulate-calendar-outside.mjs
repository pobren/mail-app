// Calendars from other websites and .ics import, end to end against a local Mail App (npm run dev:local).
// Imports an .ics file (twice: no doubling up), adds UK bank holidays from GOV.UK by link (needs the
// internet), checks they're read only, then removes them.
//
//   node test/simulate-calendar-outside.mjs [http://127.0.0.1:5173]
//
const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const ADMIN = "owner@example.com";
const BOX = "outside@example.com";
let passed = 0;
const failures = [];
async function req(method, path, body, raw = false) {
	const res = await fetch(BASE + path, {
		method,
		headers: { "dev-as": ADMIN, "content-type": raw ? "text/calendar" : "application/json" },
		body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
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
const ICS = [
	"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:test",
	"BEGIN:VEVENT", "UID:imp-1", "DTSTART;TZID=Europe/London:20261116T090000", "DTEND;TZID=Europe/London:20261116T100000", "SUMMARY:Imported meeting", "LOCATION:Leeds", "END:VEVENT",
	"BEGIN:VEVENT", "UID:imp-2", "DTSTART;VALUE=DATE:20200101", "DTEND;VALUE=DATE:20200102", "SUMMARY:Old event", "END:VEVENT",
	"END:VCALENDAR",
].join("\r\n");

let r = await req("POST", "/api/v1/mailboxes", { email: BOX, name: "Outside" });
check("mailbox", r.status < 300 || r.status === 409, r.text);
const cal = `/api/v1/mailboxes/${BOX}/calendar`;
const own = (await req("GET", `${cal}/calendars`)).json[0].id;

// Import
r = await req("POST", `${cal}/calendars/${own}/import`, ICS, true);
check("import", r.json?.added + r.json?.skipped === 2, r.text);
r = await req("POST", `${cal}/calendars/${own}/import`, ICS, true);
check("importing twice doesn't double up", r.json?.added === 0 && r.json.skipped === 2, r.text);
r = await req("POST", `${cal}/calendars/${own}/import`, "<html>nope</html>", true);
check("not a calendar", r.status === 400, r.text);
r = await req("GET", `${cal}/events?from=2026-11-16T00:00:00Z&to=2026-11-17T00:00:00Z`);
const imported = r.json?.find((o) => o.title === "Imported meeting");
check("imported event is ours to change", imported?.canEdit === true && imported.location === "Leeds" && imported.startAt === "2026-11-16T09:00:00.000Z", r.text);

// From a link
r = await req("POST", `${cal}/calendars`, { name: "Bad", sourceUrl: "http://192.168.1.1/cal.ics" });
check("private network links refused", r.status === 400, r.text);
r = await req("POST", `${cal}/calendars`, { name: "Bank holidays", color: "green", sourceUrl: process.env.ICS_URL ?? "webcal://www.gov.uk/bank-holidays/england-and-wales.ics", tz: "Europe/London" });
if (r.status !== 201) {
	console.log(`(skipping the link checks: GOV.UK couldn't be reached from here: ${r.text})`);
} else {
	const hol = r.json;
	check("link calendar made", hol.refreshedAt && !hol.refreshError, r.text);
	r = await req("GET", `${cal}/events?from=2026-12-21T00:00:00Z&to=2026-12-31T00:00:00Z`);
	const xmas = r.json?.find((o) => o.calendarId === hol.id && /Christmas/.test(o.title));
	check("Christmas Day is in it", !!xmas && xmas.allDay && xmas.start === "2026-12-25", r.text.slice(0, 300));
	check("read only", xmas && xmas.canEdit === false, JSON.stringify(xmas));
	r = await req("PUT", `${cal}/events/${xmas?.eventId}`, { event: { ...xmas, title: "Mine now" }, scope: "all" });
	check("can't change it", r.status === 400, r.text);
	r = await req("DELETE", `${cal}/events/${xmas?.eventId}?scope=all`);
	check("can't delete it", r.status === 400, r.text);
	r = await req("POST", `${cal}/events`, { calendarId: hol.id, title: "Sneaky", allDay: true, start: "2026-12-01", end: "2026-12-02", timeZone: "Europe/London", location: "", notes: "", color: null, private: false, repeat: null, reminders: [], guests: [], meetingUrl: "" });
	check("can't add to it", r.status === 400, r.text);
	r = await req("POST", `${cal}/calendars/${hol.id}/refresh`, {});
	check("update now", r.json?.id === hol.id && !r.json.refreshError, r.text);
	r = await req("POST", `${cal}/calendars/${hol.id}/import`, ICS, true);
	check("can't import into it", r.status === 400, r.text);
	r = await req("DELETE", `${cal}/calendars/${own}`);
	check("own calendar is still the last of its own", r.status === 400, r.text);
	r = await req("DELETE", `${cal}/calendars/${hol.id}`);
	check("remove it", r.status === 200, r.text);
}

console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
