import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAN, firstAdmin } from "../shared/people.ts";
import { USER_TEMPLATE_CSV, parseUsersCsv, planUserImport } from "../shared/user-import.ts";

const now = "2026-10-16T08:00:00.000Z";
const book = firstAdmin("paul@example.com", ["paul@example.com"], now);
const pro = PLAN;
const ctx = { book, plan: pro, mailboxes: ["paul@example.com", "sales@example.com"], domains: ["example.com"] };

test("the template reads back as three users", () => {
	const rows = parseUsersCsv(USER_TEMPLATE_CSV);
	assert.equal(rows.length, 3);
	assert.deepEqual(rows[0], { line: 2, name: "Anna Smith", email: "anna.smith@gmail.com", role: "member", mailbox: "anna@example.com" });
	assert.equal(rows[2].mailbox, "");
});

test("headers are matched loosely, with a BOM and semicolons", () => {
	const rows = parseUsersCsv("﻿Full Name;Email Address;Role\nAnna;ANNA@gmail.com;Admin\n");
	assert.deepEqual(rows, [{ line: 2, name: "Anna", email: "ANNA@gmail.com", role: "Admin", mailbox: "" }]);
});

test("a file without an email column is refused", () => {
	assert.throws(() => parseUsersCsv("name,phone\nAnna,123\n"), /no email column/);
});

test("rows are checked one by one", () => {
	const rows = parseUsersCsv([
		"name,email,role,mailbox",
		"Anna,anna@gmail.com,admin,anna@example.com",
		"Ben,ben@gmail.com,,ben",
		"Paul again,paul@example.com,member,",
		"Anna twin,ANNA@gmail.com,member,",
		",nobody@gmail.com,member,",
		"Chris,not-an-email,member,",
		"Dee,dee@gmail.com,boss,",
		"Ed,ed@gmail.com,member,ed@elsewhere.com",
		"Fay,fay@gmail.com,member,sales@example.com",
		"Gus,gus@gmail.com,member,anna@example.com",
	].join("\n"));
	const plan = planUserImport(rows, ctx);
	assert.deepEqual(plan.map((p) => [p.line, p.problem === null, p.mailboxKind]), [
		[2, true, "new"], [3, true, "new"], [4, false, "none"], [5, false, "none"], [6, false, "none"],
		[7, false, "none"], [8, false, "none"], [9, false, "none"], [10, true, "existing"], [11, true, "existing"],
	]);
	assert.equal(plan[0].role, "admin");
	assert.equal(plan[1].mailbox, "ben@example.com");
	assert.match(plan[2].problem!, /already a user/);
	assert.match(plan[3].problem!, /twice/);
	assert.match(plan[6].problem!, /admin or member/);
	assert.match(plan[7].problem!, /isn't one of your domains/);
});

test("a mailbox can go to two people (a shared mailbox)", () => {
	const rows = parseUsersCsv("name,email,mailbox\nAnna,anna@gmail.com,team@example.com\nBen,ben@gmail.com,team@example.com\n");
	const plan = planUserImport(rows, ctx);
	assert.equal(plan[0].problem, null);
	assert.equal(plan[1].problem, null);
});

test("the user limit stops the import part way", () => {
	const rows = parseUsersCsv("name,email\nA,a@gmail.com\nB,b@gmail.com\nC,c@gmail.com\n");
	const plan = planUserImport(rows, { ...ctx, plan: { ...pro, limit: 3 } });
	assert.deepEqual(plan.map((p) => p.problem === null), [true, true, false]);
	assert.match(plan[2].problem!, /past 3 users/);
});

test("a bare mailbox name needs the domain when there are several", () => {
	const rows = parseUsersCsv("name,email,mailbox\nAnna,anna@gmail.com,anna\n");
	assert.match(planUserImport(rows, { ...ctx, domains: ["example.com", "example.org.uk"] })[0].problem!, /whole mailbox address/);
});
