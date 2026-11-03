import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_PEOPLE, PLAN, addLog, canOpen, cleanPeople, findPerson, firstAdmin, invitePeopleProblem, isLastAdmin,
	logFor, isShared, ownerAddresses, mailboxesProblem, openable, setMailboxPeople, sharedFromName, shouldMarkSeen, signInList, usersOf, withPerson, type PeopleBook,
} from "../shared/people.ts";

const now = "2026-10-12T08:00:00.000Z";
const free = PLAN;
const pro = PLAN;

function household(): PeopleBook {
	const b = firstAdmin("Paul@Example.com", ["paul@example.com", "family@example.com"], now);
	return cleanPeople({ ...b, people: [...b.people, { email: "anna@gmail.com", name: "Anna", role: "member", mailboxes: ["anna@example.com"], status: "active", invitedAt: now }] });
}

test("the first person to sign in becomes the admin and keeps every mailbox", () => {
	const b = firstAdmin("Paul@Example.com", ["paul@example.com"], now);
	assert.equal(b.people[0].email, "paul@example.com");
	assert.equal(b.people[0].role, "admin");
	assert.deepEqual(b.people[0].mailboxes, ["paul@example.com"]);
});

test("cleans the stored file", () => {
	const b = cleanPeople({ people: [
		{ email: "A@x.com", name: "A", role: "admin", mailboxes: ["A@x.com", "bad"], adminAccess: ["b@x.com"], status: "active" },
		{ email: "a@x.com", name: "Dup" },
		{ email: "nope" },
		{ email: "m@x.com", role: "boss", adminAccess: ["b@x.com"], status: "weird" },
	], log: [{ at: now, mailbox: "a@x.com", action: "hacked", by: "a@x.com" }] });
	assert.equal(b.people.length, 2);
	assert.deepEqual(b.people[0].mailboxes, ["a@x.com"]);
	assert.equal(b.people[1].role, "member");
	assert.deepEqual(b.people[1].adminAccess, [], "only admins keep admin access");
	assert.equal(b.people[1].status, "invited");
	assert.equal(b.log.length, 0);
	assert.deepEqual(cleanPeople(null), { people: [], log: [] });
});

test("people only open their own mailboxes", () => {
	const b = household();
	const anna = findPerson(b, "ANNA@gmail.com")!;
	const paul = findPerson(b, "paul@example.com")!;
	assert.ok(canOpen(anna, "anna@example.com"));
	assert.ok(!canOpen(anna, "paul@example.com"));
	assert.ok(!canOpen(paul, "anna@example.com"), "an admin can't open someone's mailbox without asking");
	assert.ok(canOpen({ ...paul, adminAccess: ["anna@example.com"] }, "anna@example.com"));
	assert.deepEqual(openable({ ...anna, status: "suspended" }), []);
	assert.ok(!canOpen(undefined, "anna@example.com"));
});

test("an install allows up to 50 people", () => {
	const b = household();
	assert.equal(PLAN.limit, MAX_PEOPLE);
	const third = { email: "sam@gmail.com", name: "Sam", role: "member" as const, mailboxes: [] };
	assert.equal(invitePeopleProblem(b, PLAN, third, []), null);
	const many = cleanPeople({ ...b, people: [...b.people, ...Array.from({ length: MAX_PEOPLE - b.people.length }, (_, i) => ({ ...third, email: `p${i}@gmail.com`, status: "invited", invitedAt: now }))] });
	assert.match(invitePeopleProblem(many, PLAN, { ...third, email: "zoe@gmail.com" }, [])!, /the most this install allows/);
});

test("invites are checked", () => {
	const b = household();
	const boxes = ["paul@example.com", "family@example.com", "anna@example.com"];
	assert.match(invitePeopleProblem(b, free, { email: "anna@gmail.com", name: "A", role: "member", mailboxes: [] }, boxes)!, /already has access/);
	assert.match(invitePeopleProblem(b, free, { email: "not an email", name: "A", role: "member", mailboxes: [] }, boxes)!, /full email address/);
	assert.match(invitePeopleProblem(b, free, { email: "x@y.com", name: " ", role: "member", mailboxes: [] }, boxes)!, /their name/);
	assert.match(invitePeopleProblem(b, free, { email: "x@y.com", name: "X", role: "member", mailboxes: ["ghost@example.com"] }, boxes)!, /no mailbox called/);
});

test("a mailbox can be shared between people", () => {
	const b = household();
	const boxes = ["paul@example.com", "family@example.com", "anna@example.com"];
	assert.equal(mailboxesProblem(b, pro, "anna@gmail.com", ["family@example.com"], boxes), null);
	assert.equal(mailboxesProblem(b, free, "paul@example.com", ["paul@example.com", "family@example.com"], boxes), null, "their own are fine");
});

test("Cloudflare's sign-in list leaves out paused people", () => {
	const b = household();
	const anna = findPerson(b, "anna@gmail.com")!;
	assert.deepEqual(signInList(b), ["anna@gmail.com", "paul@example.com"]);
	assert.deepEqual(signInList(withPerson(b, { ...anna, status: "suspended" })), ["paul@example.com"]);
	assert.deepEqual(usersOf(withPerson(b, { ...anna, status: "suspended" }), "anna@example.com"), []);
});

test("there is always an admin", () => {
	const b = household();
	assert.ok(isLastAdmin(b, "paul@example.com"));
	assert.ok(!isLastAdmin(b, "anna@gmail.com"));
	const anna = findPerson(b, "anna@gmail.com")!;
	assert.ok(!isLastAdmin(withPerson(b, { ...anna, role: "admin" }), "paul@example.com"));
});

test("a mailbox's log shows what admins did, newest first, and stays short", () => {
	let b = household();
	b = addLog(b, { at: "1", mailbox: "anna@example.com", action: "admin-opened", by: "paul@example.com" });
	b = addLog(b, { at: "2", mailbox: "paul@example.com", action: "given", by: "paul@example.com", who: "anna@gmail.com" });
	b = addLog(b, { at: "3", mailbox: "anna@example.com", action: "admin-closed", by: "paul@example.com" });
	assert.deepEqual(logFor(b, "anna@example.com").map((l) => l.at), ["3", "1"]);
	for (let i = 0; i < 600; i++) b = addLog(b, { at: String(i), mailbox: "x@example.com", action: "given", by: "p@x.com" });
	assert.equal(b.log.length, 500);
});

test("last signed in is written at most hourly", () => {
	const p = household().people[0];
	const t = Date.parse(now);
	assert.ok(!shouldMarkSeen(p, t + 1000));
	assert.ok(shouldMarkSeen(p, t + 61 * 60 * 1000));
	assert.ok(shouldMarkSeen({ ...p, status: "invited" }, t), "first sign-in always counts");
});

test("emails from a shared mailbox are signed with the sender's own name", () => {
	assert.equal(sharedFromName("Paul", "Acme Sales"), "Paul at Acme Sales");
	assert.equal(sharedFromName("  ", "Acme Sales"), "Acme Sales");
	assert.equal(sharedFromName("Paul", ""), "Paul");
	assert.equal(sharedFromName("Paul", "paul"), "Paul");
	assert.equal(sharedFromName("Pa\u0000ul", "Sales"), "Paul at Sales");
});

test("a personal signature is kept, tidied and capped", () => {
	const b = cleanPeople({ people: [
		{ email: "a@x.com", name: "A", role: "member", mailboxes: [], status: "active", invitedAt: now, signature: "  Paul\r\nSales team\u0007  " },
		{ email: "b@x.com", name: "B", role: "member", mailboxes: [], status: "active", invitedAt: now, signature: "x".repeat(5000) },
		{ email: "c@x.com", name: "C", role: "member", mailboxes: [], status: "active", invitedAt: now, signature: 42 },
	] });
	assert.equal(b.people[0].signature, "Paul\nSales team");
	assert.equal(b.people[1].signature?.length, 2000);
	assert.equal("signature" in b.people[2], false);
});

test("an admin can mark a mailbox shared and choose who has it, with each change logged", () => {
	const b = cleanPeople({ ...household(), people: [...household().people, { email: "sam@gmail.com", name: "Sam", role: "member", mailboxes: [], status: "active", invitedAt: now }] });
	const shared = setMailboxPeople(b, pro, "family@example.com", ["paul@example.com", "sam@gmail.com"], true, "paul@example.com", now);
	assert.ok(typeof shared !== "string");
	assert.ok(isShared(shared, "family@example.com"));
	assert.ok(findPerson(shared, "sam@gmail.com")!.mailboxes.includes("family@example.com"));
	assert.deepEqual(logFor(shared, "family@example.com").map((l) => [l.action, l.who]), [["given", "sam@gmail.com"]]);
	// Marked shared even with one person, until it's switched off.
	const alone = setMailboxPeople(shared, pro, "family@example.com", ["paul@example.com"], true, "paul@example.com", now);
	assert.ok(typeof alone !== "string" && isShared(alone, "family@example.com"));
	const off = setMailboxPeople(alone as PeopleBook, pro, "family@example.com", ["paul@example.com"], false, "paul@example.com", now);
	assert.ok(typeof off !== "string" && !isShared(off, "family@example.com") && !("shared" in off));
	// The flag survives being saved and read back.
	assert.deepEqual(cleanPeople(JSON.parse(JSON.stringify(alone))).shared, ["family@example.com"]);
});

test("sharing needs everyone on the People list", () => {
	assert.match(setMailboxPeople(household(), pro, "family@example.com", ["stranger@x.com"], true, "paul@example.com", now) as string, /isn't on the Users list/);
});

test("ownerAddresses keeps the sign-in and backup addresses, tidied", () => {
	assert.deepEqual(ownerAddresses(" Owner@Example.com", "backup@gmail.com"), ["owner@example.com", "backup@gmail.com"]);
	assert.deepEqual(ownerAddresses("owner@example.com", undefined), ["owner@example.com"]);
	assert.deepEqual(ownerAddresses(undefined, ""), []);
});

