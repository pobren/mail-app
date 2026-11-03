// Notes: cleaning what the app sends, checklists, search and reminder words (shared/notes.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MAX_ITEMS, cleanItems, cleanNoteInput, isEmptyNote, matchesSearch, noteText, reminderWords, sortNotes, toChecklist, toText,
} from "../shared/notes.ts";

const NOW = Date.UTC(2026, 9, 25, 12);

test("cleanNoteInput keeps only what was sent, cleaned", () => {
	assert.deepEqual(cleanNoteInput({ title: "Shop\nping", pinned: "yes", colour: "orange" }, NOW), { title: "Shop ping", pinned: false, colour: "none" });
	assert.deepEqual(cleanNoteInput({ colour: "green", shared: true, checklist: true }, NOW), { colour: "green", shared: true, checklist: true });
	assert.equal(typeof cleanNoteInput(null, NOW), "string");
	const long = cleanNoteInput({ body: "x".repeat(30_000) }, NOW);
	assert.equal(typeof long === "object" && long.body?.length, 20_000);
});

test("reminder times must be ahead and within two years", () => {
	assert.deepEqual(cleanNoteInput({ remindAt: NOW + 3_600_000 }, NOW), { remindAt: NOW + 3_600_000 });
	assert.deepEqual(cleanNoteInput({ remindAt: null }, NOW), { remindAt: null });
	assert.match(String(cleanNoteInput({ remindAt: NOW - 3_600_000 }, NOW)), /already passed/);
	assert.match(String(cleanNoteInput({ remindAt: NOW + 3 * 366 * 86_400_000 }, NOW)), /two years/);
	assert.equal(typeof cleanNoteInput({ remindAt: "soon" }, NOW), "string");
});

test("checklists are capped, get ids and lose line breaks", () => {
	const items = cleanItems([{ id: "a", text: "Milk\nand eggs", done: true }, { id: "a", text: "Bread" }, "junk", { text: "No id" }]);
	assert.equal(items.length, 3);
	assert.deepEqual(items[0], { id: "a", text: "Milk and eggs", done: true });
	assert.notEqual(items[1].id, "a");
	assert.ok(items[2].id);
	assert.equal(cleanItems(Array.from({ length: 500 }, (_, i) => ({ text: `${i}` }))).length, MAX_ITEMS);
	assert.deepEqual(cleanItems("nope"), []);
});

test("text turns into a checklist and back", () => {
	const items = toChecklist("- Milk\n\n* Bread\n[x] Eggs\n• Tea");
	assert.deepEqual(items.map((i) => i.text), ["Milk", "Bread", "Eggs", "Tea"]);
	assert.equal(toText(items), "Milk\nBread\nEggs\nTea");
});

test("empty notes, plain text and search", () => {
	assert.equal(isEmptyNote({ title: " ", body: "\n", items: [{ id: "a", text: " ", done: false }] }), true);
	assert.equal(isEmptyNote({ title: "", body: "", items: [{ id: "a", text: "x", done: false }] }), false);
	const list = { title: "Shopping", body: "", items: [{ id: "a", text: "Milk", done: true }, { id: "b", text: "Bread", done: false }], checklist: true };
	assert.equal(noteText(list), "Shopping\n\n☑ Milk\n☐ Bread");
	assert.equal(matchesSearch(list, "shop bread"), true);
	assert.equal(matchesSearch(list, "shop cheese"), false);
	assert.equal(matchesSearch(list, "  "), true);
});

test("pinned first, then the newest", () => {
	const sorted = sortNotes([
		{ id: "old", pinned: false, updatedAt: "2026-10-01" },
		{ id: "pin", pinned: true, updatedAt: "2026-09-01" },
		{ id: "new", pinned: false, updatedAt: "2026-10-20" },
	]);
	assert.deepEqual(sorted.map((n) => n.id), ["pin", "new", "old"]);
});

test("a private note in a shared mailbox keeps its words out of the notification", () => {
	const n = { title: "Payroll", body: "Pay Sam\nPay Jo", items: [], checklist: false, shared: false };
	assert.deepEqual(reminderWords(n, false), { title: "Payroll", body: "Pay Sam" });
	assert.deepEqual(reminderWords(n, true), { title: "Note reminder", body: "One of your private notes has a reminder." });
	assert.deepEqual(reminderWords({ ...n, shared: true }, true), { title: "Payroll", body: "Pay Sam" });
	assert.deepEqual(reminderWords({ ...n, title: "", body: "" }, false), { title: "Note reminder", body: "You asked to be reminded about this note." });
});
