// The calendar end to end against a local Mail App (npm run dev:local): calendars, events, repeats
// changed "this one / this and following / all", private events in a shared mailbox, reminders and
// the .ics download. Each request says who it's from with the dev-as header (local only).
//
//   node test/simulate-calendar.mjs [http://127.0.0.1:5173]
//
// Needs a fresh local store (delete .wrangler/state first).
const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const OWNER = "owner@example.com";
const SAM = "sam@gmail.com";
const BOX = "team@example.com";
let passed = 0;
const failures = [];

async function req(as, method, path, body) {
	const res = await fetch(BASE + path, {
		method,
		headers: { "dev-as": as, "content-type": "application/json" },
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
const cal = `/api/v1/mailboxes/${BOX}/calendar`;
const week = (from, to = from) => `${cal}/events?from=${from}T00:00:00Z&to=${to}T00:00:00Z`;
const titles = (list) => list.map((o) => `${o.start} ${o.title}`);

// A shared mailbox used by the owner and Sam.
let r = await req(OWNER, "POST", "/api/v1/mailboxes", { email: OWNER, name: "Owner" });
check("owner mailbox", r.status < 300, r.text);
r = await req(OWNER, "POST", "/api/v1/people", { email: SAM, name: "Sam", role: "member", mailboxes: [] });
check("add Sam", r.status < 300, r.text);
r = await req(OWNER, "POST", "/api/v1/mailboxes", { email: BOX, name: "Team", people: [SAM], shared: true });
check("shared mailbox", r.status < 300, r.text);

// Calendars
r = await req(OWNER, "GET", `${cal}/calendars`);
check("first calendar made", r.json?.length === 1 && r.json[0].name === "Calendar", r.text);
const main = r.json[0].id;
r = await req(OWNER, "POST", `${cal}/calendars`, { name: "  Family  ", color: "pink" });
check("new calendar", r.status === 201 && r.json.name === "Family" && r.json.color === "pink", r.text);
const family = r.json.id;
r = await req(OWNER, "POST", `${cal}/calendars`, { name: "" });
check("calendar needs a name", r.status === 400);
r = await req(OWNER, "PUT", `${cal}/calendars/${family}`, { name: "Home", color: "teal" });
check("rename calendar", r.json?.name === "Home" && r.json.color === "teal", r.text);
r = await req("stranger@gmail.com", "GET", `${cal}/calendars`);
check("strangers can't see it", r.status === 404 || r.status === 403, String(r.status));

// A weekly meeting on Mondays and Wednesdays at 9, in London.
const base = { calendarId: main, timeZone: "Europe/London", location: "Kitchen table", notes: "Agenda: budget", color: null, private: false, reminders: [10] };
r = await req(OWNER, "POST", `${cal}/events`, { ...base, title: "Stand-up", allDay: false, start: "2026-10-12T09:00", end: "2026-10-12T09:15", repeat: { freq: "weekly", interval: 1, days: ["MO", "WE"] } });
check("make a repeating event", r.status === 201, r.text);
const standup = r.json.id;
r = await req(OWNER, "GET", week("2026-10-12", "2026-11-02"));
check("six repeats over three weeks", r.json?.length === 6, JSON.stringify(titles(r.json ?? [])));
check("9am London is 08:00 UTC before the clocks change", r.json?.[0]?.startAt === "2026-10-12T08:00:00.000Z", r.json?.[0]?.startAt);
check("and 09:00 UTC after", r.json?.[4]?.startAt === "2026-10-26T09:00:00.000Z", r.json?.[4]?.startAt);

// Change just one: Wednesday 14th moves to 10am.
const one = { ...base, title: "Stand-up (late)", allDay: false, start: "2026-10-14T10:00", end: "2026-10-14T10:15", repeat: { freq: "weekly", interval: 1, days: ["MO", "WE"] } };
r = await req(OWNER, "PUT", `${cal}/events/${standup}`, { event: one, scope: "one", occurrence: "2026-10-14T09:00" });
check("change one repeat", r.status === 200 && r.json.repeat === null, r.text);
r = await req(OWNER, "GET", week("2026-10-12", "2026-10-19"));
check("that week shows the moved one", JSON.stringify(titles(r.json)) === JSON.stringify(["2026-10-12T09:00 Stand-up", "2026-10-14T10:00 Stand-up (late)"]), JSON.stringify(titles(r.json)));

// This and following: from 26 October it's at 08:30 and called "Morning check-in".
const later = { ...base, title: "Morning check-in", allDay: false, start: "2026-10-26T08:30", end: "2026-10-26T08:45", repeat: { freq: "weekly", interval: 1, days: ["MO", "WE"] } };
r = await req(OWNER, "PUT", `${cal}/events/${standup}`, { event: later, scope: "following", occurrence: "2026-10-26T09:00" });
check("change this and following", r.status === 200 && r.json.id !== standup, r.text);
const checkin = r.json.id;
r = await req(OWNER, "GET", week("2026-10-19", "2026-11-02"));
check("old series stops, new one carries on", JSON.stringify(titles(r.json)) === JSON.stringify([
	"2026-10-19T09:00 Stand-up", "2026-10-21T09:00 Stand-up", "2026-10-26T08:30 Morning check-in", "2026-10-28T08:30 Morning check-in",
]), JSON.stringify(titles(r.json)));

// All: drag Monday 2 November's check-in to Tuesday at 08:30; every repeat moves a day... but it repeats on
// Mondays and Wednesdays, so the days stay and only the time shifts when dragged within the day.
r = await req(OWNER, "PUT", `${cal}/events/${checkin}`, { event: { ...later, start: "2026-11-02T08:00", end: "2026-11-02T08:15" }, scope: "all", occurrence: "2026-11-02T08:30" });
check("move all", r.status === 200 && r.json.start === "2026-10-26T08:00", r.text);

// Delete just one, then this and following.
r = await req(OWNER, "DELETE", `${cal}/events/${checkin}?scope=one&occurrence=2026-10-28T08:00`);
check("delete one", r.status === 200, r.text);
r = await req(OWNER, "GET", week("2026-10-26", "2026-11-02"));
check("the deleted one has gone", JSON.stringify(titles(r.json)) === JSON.stringify(["2026-10-26T08:00 Morning check-in"]), JSON.stringify(titles(r.json)));
r = await req(OWNER, "DELETE", `${cal}/events/${checkin}?scope=following&occurrence=2026-11-04T08:00`);
r = await req(OWNER, "GET", week("2026-11-02", "2026-11-30"));
check("this and following deleted", JSON.stringify(titles(r.json)) === JSON.stringify(["2026-11-02T08:00 Morning check-in"]), JSON.stringify(titles(r.json)));

// All-day, coloured, on the second calendar.
r = await req(OWNER, "POST", `${cal}/events`, { ...base, calendarId: family, title: "Half term", allDay: true, start: "2026-10-26", end: "2026-10-31", color: "orange", reminders: [1440], repeat: null });
check("all-day event", r.status === 201 && r.json.color === "orange", r.text);
r = await req(OWNER, "POST", `${cal}/events`, { ...base, title: "Backwards", allDay: false, start: "2026-10-26T10:00", end: "2026-10-26T09:00", repeat: null });
check("end before start refused", r.status === 400 && /end after/.test(r.json?.error), r.text);

// Private: Sam's dentist shows as Busy to the owner, who can't change it.
r = await req(SAM, "POST", `${cal}/events`, { ...base, title: "Dentist", location: "High Street", notes: "Bring card", private: true, allDay: false, start: "2026-10-27T15:00", end: "2026-10-27T16:00", repeat: null });
check("Sam adds a private event", r.status === 201, r.text);
const dentist = r.json.id;
r = await req(OWNER, "GET", week("2026-10-27", "2026-10-28"));
const busy = r.json.find((o) => o.eventId === dentist);
check("owner sees Busy", busy?.title === "Busy" && busy.notes === "" && busy.location === "" && busy.canEdit === false, JSON.stringify(busy));
r = await req(SAM, "GET", week("2026-10-27", "2026-10-28"));
check("Sam sees the details", r.json.find((o) => o.eventId === dentist)?.title === "Dentist");
r = await req(OWNER, "PUT", `${cal}/events/${dentist}`, { event: { ...base, title: "Hacked", allDay: false, start: "2026-10-27T15:00", end: "2026-10-27T16:00", repeat: null }, scope: "all" });
check("owner can't change it", r.status === 403, r.text);
r = await req(OWNER, "DELETE", `${cal}/events/${dentist}?scope=all`);
check("or delete it", r.status === 403, r.text);
r = await req(OWNER, "GET", `${cal}/export.ics`);
check("download keeps it private", r.status === 200 && r.text.includes("SUMMARY:Busy") && !r.text.includes("Dentist") && r.text.includes("BEGIN:VCALENDAR"), r.text.slice(0, 200));

// Reminders: one in 20 minutes with a 10-minute reminder shows in the coming reminders.
const soon = new Date(Date.now() + 20 * 60_000);
const londonWall = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d).replace(" ", "T");
r = await req(OWNER, "POST", `${cal}/events`, { ...base, title: "Call Mum", allDay: false, start: londonWall(soon), end: londonWall(new Date(soon.getTime() + 30 * 60_000)), repeat: null, reminders: [10, 60] });
check("event soon", r.status === 201, r.text);
r = await req(OWNER, "GET", `${cal}/reminders`);
const mum = r.json?.find((x) => x.title === "Call Mum");
check("reminder coming up", mum && mum.minutes === 10 && Math.abs(Date.parse(mum.at) - (soon.getTime() - 10 * 60_000)) < 61_000, r.text);
r = await req(SAM, "GET", `${cal}/reminders`);
check("Sam's private event has no reminder for the owner", !(await req(OWNER, "GET", `${cal}/reminders`)).json.some((x) => x.title === "Dentist"));

// Deleting a calendar deletes its events; the last one can't go.
r = await req(OWNER, "DELETE", `${cal}/calendars/${family}`);
check("delete calendar", r.status === 200, r.text);
r = await req(OWNER, "GET", week("2026-10-26", "2026-11-02"));
check("its events went with it", !r.json.some((o) => o.title === "Half term"), JSON.stringify(titles(r.json)));
r = await req(OWNER, "DELETE", `${cal}/calendars/${main}`);
check("can't delete the last calendar", r.status === 400, r.text);

// Bad ranges.
r = await req(OWNER, "GET", `${cal}/events?from=nonsense&to=2026-10-01T00:00:00Z`);
check("bad range refused", r.status === 400);

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
