import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanShares, dropShares, EVERYONE, levelFor, setSharesOf, sharedWith, sharesOf, type ShareBook } from "../shared/calendar-shares.ts";

const now = "2026-10-25T13:00:00.000Z";
const empty: ShareBook = { shares: [] };

test("sharing a calendar with people and everyone", () => {
	const book = setSharesOf(empty, "Alex@Shop.co.uk", "cal1", [{ with: "jo@gmail.com", level: "view" }, { with: EVERYONE, level: "busy" }], "alex@gmail.com", now);
	assert.ok(typeof book !== "string");
	assert.equal(sharesOf(book, "alex@shop.co.uk", "cal1").length, 2);
	assert.equal(levelFor(book, "jo@gmail.com", "alex@shop.co.uk", "cal1"), "view");
	assert.equal(levelFor(book, "sam@gmail.com", "alex@shop.co.uk", "cal1"), "busy");
	assert.equal(levelFor(book, "sam@gmail.com", "alex@shop.co.uk", "cal2"), null);
});

test("the higher of a personal share and an everyone share wins", () => {
	const book = setSharesOf(empty, "a@x.com", "c", [{ with: "jo@x.com", level: "busy" }, { with: EVERYONE, level: "edit" }], "a@x.com", now) as ShareBook;
	assert.equal(levelFor(book, "jo@x.com", "a@x.com", "c"), "edit");
	assert.deepEqual(sharedWith(book, "jo@x.com", []).map((s) => s.level), ["edit"]);
});

test("calendars in your own mailboxes aren't listed as shared with you", () => {
	const book = setSharesOf(empty, "team@x.com", "c", [{ with: EVERYONE, level: "edit" }], "a@x.com", now) as ShareBook;
	assert.equal(sharedWith(book, "jo@x.com", ["team@x.com"]).length, 0);
	assert.equal(sharedWith(book, "jo@x.com", ["jo@x.com"]).length, 1);
});

test("replacing shares keeps unchanged ones as they were and drops the rest", () => {
	const first = setSharesOf(empty, "a@x.com", "c", [{ with: "jo@x.com", level: "view" }, { with: "sam@x.com", level: "view" }], "a@x.com", now) as ShareBook;
	const later = setSharesOf(first, "a@x.com", "c", [{ with: "jo@x.com", level: "view" }], "b@x.com", "2026-10-26T00:00:00.000Z") as ShareBook;
	const list = sharesOf(later, "a@x.com", "c");
	assert.equal(list.length, 1);
	assert.equal(list[0].by, "a@x.com");
	assert.equal(list[0].at, now);
});

test("bad shares are refused", () => {
	assert.equal(typeof setSharesOf(empty, "a@x.com", "c", [{ with: "not an address", level: "view" }], "a@x.com", now), "string");
	assert.equal(typeof setSharesOf(empty, "a@x.com", "c", [{ with: "jo@x.com", level: "owner" as never }], "a@x.com", now), "string");
});

test("deleting a calendar or a mailbox takes its shares away", () => {
	let book = setSharesOf(empty, "a@x.com", "c1", [{ with: "jo@x.com", level: "view" }], "a@x.com", now) as ShareBook;
	book = setSharesOf(book, "a@x.com", "c2", [{ with: "jo@x.com", level: "view" }], "a@x.com", now) as ShareBook;
	book = setSharesOf(book, "b@x.com", "c3", [{ with: "jo@x.com", level: "view" }], "b@x.com", now) as ShareBook;
	assert.equal(dropShares(book, "a@x.com", "c1").shares.length, 2);
	assert.equal(dropShares(book, "a@x.com").shares.length, 1);
});

test("a damaged file is cleaned up rather than trusted", () => {
	const book = cleanShares({ shares: [
		{ owner: "a@x.com", calendarId: "c", with: "jo@x.com", level: "view" },
		{ owner: "a@x.com", calendarId: "c", with: "jo@x.com", level: "edit" },
		{ owner: "nope", calendarId: "c", with: "jo@x.com", level: "view" },
		{ owner: "a@x.com", calendarId: "c", with: "jo@x.com", level: "admin" },
		null,
	] });
	assert.equal(book.shares.length, 1);
	assert.deepEqual(cleanShares("rubbish"), { shares: [] });
});
