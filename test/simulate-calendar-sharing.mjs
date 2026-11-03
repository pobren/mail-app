// Calendar sharing end to end against a local Mail App (npm run dev:local): the owner shares one
// calendar with Sam as busy times, one as see all, and makes a team calendar everyone can edit. Sam
// sees each the right way, can add to the team calendar, can't change the others, and loses them
// again when the sharing stops or the calendar is deleted.
//
//   node test/simulate-calendar-sharing.mjs [http://127.0.0.1:5173]
//
// Needs a fresh local store (delete .wrangler/state first).
const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const OWNER = "owner@example.com";
const SAM = "sam@gmail.com";
const JO = "jo@gmail.com";
const SAMBOX = "sam@example.com";
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
const cal = `/api/v1/mailboxes/${OWNER}/calendar`;
const range = "from=2026-11-02T00:00:00Z&to=2026-11-09T00:00:00Z";
const sharedEvents = (as) => req(as, "GET", `/api/v1/shared-calendars/events?${range}`);

let r = await req(OWNER, "POST", "/api/v1/mailboxes", { email: OWNER, name: "Owner" });
check("owner mailbox", r.status < 300, r.text);
r = await req(OWNER, "POST", "/api/v1/people", { email: SAM, name: "Sam", role: "member", mailboxes: [] });
check("add Sam", r.status < 300, r.text);
r = await req(OWNER, "POST", "/api/v1/mailboxes", { email: SAMBOX, name: "Sam", forPerson: SAM });
check("Sam's mailbox", r.status < 300, r.text);
r = await req(OWNER, "POST", "/api/v1/people", { email: JO, name: "Jo", role: "member", mailboxes: [] });
check("add Jo", r.status < 300, r.text);

// Three calendars: Work (busy times for Sam), Clients (see all for Sam), Team (everyone can edit).
r = await req(OWNER, "GET", `${cal}/calendars`);
const work = r.json[0].id;
const clients = (await req(OWNER, "POST", `${cal}/calendars`, { name: "Clients", color: "teal" })).json.id;
const team = (await req(OWNER, "POST", `${cal}/calendars`, { name: "Team", color: "pink" })).json.id;
const ev = (calendarId, title, start, extra = {}) => ({ calendarId, title, allDay: false, start, end: start.replace(/T(\d\d)/, (_, h) => `T${String(+h + 1).padStart(2, "0")}`), timeZone: "Europe/London", location: "Office", notes: "Secret notes", color: null, private: false, repeat: null, reminders: [10], guests: [], meetingUrl: "", ...extra });
await req(OWNER, "POST", `${cal}/events`, ev(work, "Dentist", "2026-11-03T09:00"));
await req(OWNER, "POST", `${cal}/events`, ev(clients, "Acme review", "2026-11-04T10:00"));
await req(OWNER, "POST", `${cal}/events`, ev(clients, "My private thing", "2026-11-04T14:00", { private: true }));
await req(OWNER, "POST", `${cal}/events`, ev(team, "Team lunch", "2026-11-05T12:00"));
r = await req(OWNER, "POST", `${cal}/events`, ev(team, "Board meeting", "2026-11-06T12:00", { guests: [{ email: "client@outside.com", name: "", status: "needs-action" }] }));
const board = r.json.id;

// Nothing is shared yet.
r = await req(SAM, "GET", "/api/v1/shared-calendars");
check("nothing shared at first", Array.isArray(r.json) && r.json.length === 0, r.text);

// Who can it be shared with? Sam and Jo, not the owner.
r = await req(OWNER, "GET", `${cal}/calendars/${work}/shares`);
check("share list offers the team", r.json?.people?.map((p) => p.email).sort().join() === [JO, SAM].sort().join(), r.text);
r = await req(SAM, "GET", `${cal}/calendars/${work}/shares`);
check("Sam can't manage the owner's sharing", r.status === 404, String(r.status));
r = await req(OWNER, "PUT", `${cal}/calendars/${work}/shares`, { shares: [{ with: "stranger@gmail.com", level: "view" }] });
check("only people on the team", r.status === 400, r.text);

r = await req(OWNER, "PUT", `${cal}/calendars/${work}/shares`, { shares: [{ with: SAM, level: "busy" }] });
check("share Work as busy", r.status === 200, r.text);
r = await req(OWNER, "PUT", `${cal}/calendars/${clients}/shares`, { shares: [{ with: SAM, level: "view" }] });
check("share Clients to see", r.status === 200, r.text);
r = await req(OWNER, "PUT", `${cal}/calendars/${team}/shares`, { shares: [{ with: "everyone", level: "edit" }] });
check("Team for everyone", r.status === 200, r.text);
r = await req(OWNER, "GET", `${cal}/shares`);
check("counts", r.json?.counts?.[work] === 1 && r.json?.counts?.[team] === 1, r.text);

r = await req(SAM, "GET", "/api/v1/shared-calendars");
check("Sam sees three calendars", r.json?.length === 3, r.text);
check("with levels", r.json?.map((c) => `${c.name}:${c.level}`).sort().join() === "Calendar:busy,Clients:view,Team:edit", r.text);
check("and whose they are", r.json?.every((c) => c.owner === OWNER && c.ownerName), r.text);
r = await req(JO, "GET", "/api/v1/shared-calendars");
check("Jo sees only the team calendar", r.json?.length === 1 && r.json[0].name === "Team", r.text);

r = await sharedEvents(SAM);
const byTitle = Object.fromEntries((r.json ?? []).map((o) => [o.title + "@" + o.start, o]));
const dentist = r.json?.find((o) => o.start === "2026-11-03T09:00");
check("busy-only calendar hides the details", dentist?.title === "Busy" && dentist.location === "" && dentist.notes === "" && dentist.busy && !dentist.canEdit, JSON.stringify(dentist));
check("see-all calendar shows details", byTitle["Acme review@2026-11-04T10:00"]?.notes === "Secret notes" && !byTitle["Acme review@2026-11-04T10:00"].canEdit, r.text);
check("private events still Busy", byTitle["Busy@2026-11-04T14:00"]?.busy === true, r.text);
check("reminders aren't shared", r.json?.every((o) => o.reminders.length === 0), r.text);
check("team calendar editable", byTitle["Team lunch@2026-11-05T12:00"]?.canEdit === true, r.text);
check("but not an event with guests", byTitle["Board meeting@2026-11-06T12:00"]?.canEdit === false, r.text);
check("each says whose it is", r.json?.every((o) => o.owner === OWNER), r.text);

// Sam adds to the team calendar.
r = await req(SAM, "POST", `/api/v1/shared-calendars/${OWNER}/events`, ev(team, "Sam's training", "2026-11-07T09:00"));
check("Sam adds to the team calendar", r.status === 201 && r.json.createdBy === SAM && r.json.reminders.length === 0, r.text);
const training = r.json?.id;
r = await req(OWNER, "GET", `${cal}/events?${range}`);
check("owner sees Sam's event", r.json?.some((o) => o.title === "Sam's training"), r.text);
r = await req(SAM, "PUT", `/api/v1/shared-calendars/${OWNER}/events/${training}`, { event: ev(team, "Sam's training (moved)", "2026-11-07T11:00"), scope: "all" });
check("Sam changes it", r.status === 200 && r.json.title === "Sam's training (moved)", r.text);
r = await req(SAM, "PUT", `/api/v1/shared-calendars/${OWNER}/events/${training}`, { event: ev(work, "Sneaky move", "2026-11-07T11:00"), scope: "all" });
check("can't move it into a calendar Sam can't edit", r.status === 403, r.text);
r = await req(SAM, "POST", `/api/v1/shared-calendars/${OWNER}/events`, ev(clients, "Not allowed", "2026-11-07T09:00"));
check("can't add to a see-only calendar", r.status === 403, r.text);
r = await req(SAM, "POST", `/api/v1/shared-calendars/${OWNER}/events`, ev(team, "With guests", "2026-11-07T15:00", { guests: [{ email: "x@y.com", name: "", status: "needs-action" }] }));
check("can't invite guests from a shared calendar", r.status === 400, r.text);
r = await req(SAM, "PUT", `/api/v1/shared-calendars/${OWNER}/events/${board}`, { event: ev(team, "Board (changed)", "2026-11-06T12:00"), scope: "all" });
check("can't change an event with guests", r.status === 403, r.text);
r = await req(SAM, "DELETE", `/api/v1/shared-calendars/${OWNER}/events/${board}`);
check("or delete it", r.status === 403, r.text);
r = await req(JO, "DELETE", `/api/v1/shared-calendars/${OWNER}/events/${training}?scope=all`);
check("Jo (everyone) can delete from the team calendar", r.status === 200, r.text);
r = await req("stranger@gmail.com", "GET", `/api/v1/shared-calendars/events?${range}`);
check("strangers get nothing", r.status === 403 || (Array.isArray(r.json) && r.json.length === 0), r.text);

// Stop sharing Clients, delete Team.
r = await req(OWNER, "PUT", `${cal}/calendars/${clients}/shares`, { shares: [] });
check("stop sharing", r.status === 200, r.text);
r = await req(OWNER, "DELETE", `${cal}/calendars/${team}`);
check("delete the team calendar", r.status === 200, r.text);
r = await req(SAM, "GET", "/api/v1/shared-calendars");
check("Sam is left with the busy one", r.json?.length === 1 && r.json[0].level === "busy", r.text);
r = await req(JO, "GET", "/api/v1/shared-calendars");
check("Jo has none", r.json?.length === 0, r.text);

console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
