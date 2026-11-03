// Notes end to end against a local Mail App (npm run dev:local): two people sharing one mailbox. Each
// sees only their own notes until one is shared; only the writer can stop sharing; the Bin; reminders.
//
//   node test/simulate-notes.mjs [http://127.0.0.1:5173]
//
const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const OWNER = "owner@example.com";
const SAM = "sam.notes@example.org";
const BOX = "notes@example.com";
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

await req(OWNER, "GET", "/api/v1/me");
let r = await req(OWNER, "POST", "/api/v1/mailboxes", { email: BOX, name: "Notes" });
check("mailbox", r.status < 300 || r.status === 409, r.text);
const notes = `/api/v1/mailboxes/${BOX}/notes`;

// Clear out anything from an earlier run.
for (const as of [OWNER, SAM]) {
	const list = (await req(as, "GET", notes)).json?.notes ?? [];
	if (list.length) await req(as, "POST", `${notes}/bin`, { ids: list.map((n) => n.id) });
	await req(as, "POST", `${notes}/delete`, { all: true });
}

// On your own, there's nothing to share with.
r = await req(OWNER, "GET", notes);
check("list", r.status === 200 && Array.isArray(r.json?.notes), r.text);
const alone = r.json?.sharedMailbox === false;
r = await req(OWNER, "POST", notes, { title: "Ideas", body: "One\nTwo", shared: true });
check("note made", r.status === 201 && r.json?.title === "Ideas" && r.json.mine === true, r.text);
if (alone) check("can't share in a mailbox only you use", r.json?.shared === false, r.text);
const ideas = r.json?.id;
// On a second run Sam already uses the mailbox, so the note was shared: make it private again.
if (!alone) await req(OWNER, "PUT", `${notes}/${ideas}`, { shared: false });

// Bring Sam in.
r = await req(OWNER, "POST", "/api/v1/people", { email: SAM, name: "Sam", role: "member", mailboxes: [BOX] });
if (r.status === 400 && /already/.test(r.text)) r = await req(OWNER, "PATCH", `/api/v1/people/${SAM}`, { mailboxes: [BOX] });
check("Sam can use the mailbox", r.status < 300, r.text);
r = await req(SAM, "GET", notes);
check("Sam sees it's shared", r.json?.sharedMailbox === true, r.text);
check("Sam can't see the owner's private note", !r.json?.notes?.some((n) => n.id === ideas), r.text);
r = await req(SAM, "PUT", `${notes}/${ideas}`, { title: "Mine now" });
check("Sam can't change it", r.status === 404, r.text);
r = await req(SAM, "POST", `${notes}/bin`, { ids: [ideas] });
check("Sam can't bin it", r.json?.binned === 0, r.text);

// Sharing.
r = await req(OWNER, "PUT", `${notes}/${ideas}`, { shared: true, pinned: true, colour: "yellow" });
check("owner shares it", r.json?.shared === true && r.json.pinned && r.json.colour === "yellow", r.text);
r = await req(SAM, "GET", notes);
const seen = r.json?.notes?.find((n) => n.id === ideas);
check("Sam sees it now", seen?.mine === false && seen.ownerName && seen.body === "One\nTwo", r.text);
r = await req(SAM, "PUT", `${notes}/${ideas}`, { body: "One\nTwo\nThree from Sam" });
check("Sam can change a shared note", r.json?.body === "One\nTwo\nThree from Sam", r.text);
r = await req(SAM, "PUT", `${notes}/${ideas}`, { shared: false });
check("only the writer can stop sharing", r.status === 403, r.text);

// Checklists.
r = await req(SAM, "POST", notes, { title: "Shopping", checklist: true, items: [{ id: "a", text: "Milk" }, { id: "b", text: "Bread" }] });
check("checklist made", r.status === 201 && r.json?.checklist && r.json.items.length === 2 && r.json.items[0].done === false, r.text);
const shop = r.json?.id;
r = await req(SAM, "PUT", `${notes}/${shop}`, { items: [{ id: "a", text: "Milk", done: true }, { id: "b", text: "Bread" }] });
check("item ticked", r.json?.items?.[0]?.done === true && r.json.items[1].done === false, r.text);
r = await req(OWNER, "GET", notes);
check("owner can't see Sam's private list", !r.json?.notes?.some((n) => n.id === shop), r.text);

// Reminders.
r = await req(SAM, "PUT", `${notes}/${shop}`, { remindAt: Date.now() - 3_600_000 });
check("past reminder refused", r.status === 400, r.text);
r = await req(SAM, "PUT", `${notes}/${shop}`, { remindAt: Date.now() + 3_000 });
check("reminder set", typeof r.json?.remindAt === "number" && r.json.reminded === false, r.text);
await new Promise((ok) => setTimeout(ok, 6_000));
r = await req(SAM, "GET", notes);
check("reminder sent by the alarm", r.json?.notes?.find((n) => n.id === shop)?.reminded === true, r.text);
r = await req(SAM, "PUT", `${notes}/${shop}`, { remindAt: null });
check("reminder removed", r.json?.remindAt === null, r.text);

// Bad input.
r = await req(SAM, "PUT", `${notes}/not-an-id`, { title: "x" });
check("unknown note", r.status === 404, r.text);
r = await req(SAM, "POST", notes, "nope");
check("bad body", r.status === 400, r.text);

// The Bin.
r = await req(SAM, "POST", `${notes}/bin`, { ids: [shop, ideas] });
check("Sam bins both", r.json?.binned === 2, r.text);
r = await req(OWNER, "GET", `${notes}?bin=1`);
check("owner sees the shared one in the Bin, not Sam's", r.json?.notes?.map((n) => n.id).join() === ideas, r.text);
r = await req(OWNER, "POST", `${notes}/restore`, { ids: [ideas] });
check("owner puts it back", r.json?.restored === 1, r.text);
r = await req(SAM, "POST", `${notes}/delete`, { all: true });
check("Sam empties the Bin", r.json?.deleted === 1, r.text);
r = await req(SAM, "GET", notes);
check("only the shared note is left for Sam", r.json?.notes?.map((n) => n.id).join() === ideas, r.text);
r = await req(SAM, "POST", `${notes}/delete`, { ids: [ideas] });
check("can't delete for good what's not in the Bin", r.json?.deleted === 0, r.text);

// Someone who can't open the mailbox.
r = await req("stranger@example.net", "GET", notes);
check("others get nothing", r.status >= 400, r.text);

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
