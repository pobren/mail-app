// Calendar subscribe links end to end against a local Mail App (npm run dev:local): make a link,
// read it as Apple Calendar would (no sign-in), check private events and "busy times only", then
// replace and turn off the link.
//
//   node test/simulate-calendar-feed.mjs [http://127.0.0.1:5173]
//
const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const OWNER = "feed-owner@example.com";
const SAM = "feed-sam@gmail.com";
let passed = 0;
const failures = [];

async function req(as, method, path, body) {
	const res = await fetch(BASE + path, {
		method,
		headers: { ...(as ? { "dev-as": as } : {}), "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json = null;
	try { json = JSON.parse(text); } catch { /* not json */ }
	return { status: res.status, json, text, type: res.headers.get("content-type") ?? "" };
}
function check(name, ok, detail = "") {
	if (ok) passed++;
	else { failures.push(`${name} ${detail}`); console.log(`FAIL ${name} ${detail}`); }
}
const ADMIN = "owner@example.com";
let r = await req(ADMIN, "POST", "/api/v1/mailboxes", { email: OWNER, name: "Feed owner" });
check("mailbox", r.status < 300 || r.status === 409, r.text);
const cal = `/api/v1/mailboxes/${OWNER}/calendar`;
const work = (await req(ADMIN, "GET", `${cal}/calendars`)).json[0].id;
const ev = (title, start, extra = {}) => ({ calendarId: work, title, allDay: false, start, end: start.replace("T09", "T10"), timeZone: "Europe/London", location: "Office", notes: "Agenda", color: null, private: false, repeat: null, reminders: [10], guests: [], meetingUrl: "", ...extra });
await req(ADMIN, "POST", `${cal}/events`, ev("Board meeting", "2026-11-10T09:00"));
await req(ADMIN, "POST", `${cal}/events`, ev("Doctor", "2026-11-11T09:00", { private: true }));

await req(ADMIN, "DELETE", `${cal}/calendars/${work}/feed`);
r = await req(ADMIN, "GET", `${cal}/calendars/${work}/feed`);
check("no link at first", r.json?.feed === null, r.text);
r = await req(SAM, "GET", `${cal}/calendars/${work}/feed`);
check("others can't see the link", r.status === 404 || r.status === 403, String(r.status));
r = await req(ADMIN, "POST", `${cal}/calendars/${work}/feed`, { level: "all" });
check("make a link", r.json?.feed?.url?.includes("/f/cal/"), r.text);
const url = r.json.feed.url;
check("apple link is webcal", r.json.feed.links.apple.startsWith("webcal://"), r.text);
const path = new URL(url).pathname;

r = await req(null, "GET", path);
check("the link opens without signing in", r.status === 200 && r.type.startsWith("text/calendar"), `${r.status} ${r.type}`);
check("it has the event with its details", r.text.includes("SUMMARY:Board meeting") && r.text.includes("LOCATION:Office"), r.text.slice(0, 400));
check("private events show as Busy", !r.text.includes("Doctor") && r.text.includes("SUMMARY:Busy"), "");
check("no reminders", !r.text.includes("VALARM"), "");
check("time zone included for Outlook", r.text.includes("BEGIN:VTIMEZONE") && r.text.includes("TZID:Europe/London"), "");

r = await req(ADMIN, "POST", `${cal}/calendars/${work}/feed`, { level: "busy" });
check("same link, busy only", r.json?.feed?.url === url && r.json.feed.level === "busy", r.text);
r = await req(null, "GET", path);
check("busy only hides everything", !r.text.includes("Board meeting") && !r.text.includes("Office") && !r.text.includes("Agenda"), "");

r = await req(ADMIN, "POST", `${cal}/calendars/${work}/feed`, { level: "all", renew: true });
check("a new link", r.json?.feed?.url && r.json.feed.url !== url, r.text);
r = await req(null, "GET", path);
check("old link stops working", r.status === 404, String(r.status));
const path2 = new URL(r.json?.feed?.url ?? (await req(ADMIN, "GET", `${cal}/calendars/${work}/feed`)).json.feed.url).pathname;
r = await req(null, "GET", path2);
check("new link works", r.status === 200, String(r.status));

r = await req(ADMIN, "DELETE", `${cal}/calendars/${work}/feed`);
check("turn off", r.json?.feed === null, r.text);
r = await req(null, "GET", path2);
check("turned-off link is gone", r.status === 404, String(r.status));
r = await req(null, "GET", "/f/cal/not-a-real-token.ics");
check("made-up links get nothing", r.status === 404, String(r.status));

// A deleted calendar's link goes with it.
const extra = (await req(ADMIN, "POST", `${cal}/calendars`, { name: "Extra" })).json.id;
const p3 = new URL((await req(ADMIN, "POST", `${cal}/calendars/${extra}/feed`, {})).json.feed.url).pathname;
check("extra link works", (await req(null, "GET", p3)).status === 200);
await req(ADMIN, "DELETE", `${cal}/calendars/${extra}`);
check("deleted calendar's link is gone", (await req(null, "GET", p3)).status === 404);

console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
