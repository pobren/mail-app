import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanFeeds, dropFeeds, feedByToken, feedOf, feedUrl, isFeedToken, newFeedToken, setFeed, subscribeLinks, type FeedBook } from "../shared/calendar-feeds.ts";

const now = "2026-10-25T14:00:00.000Z";
const empty: FeedBook = { feeds: [] };

test("a new link is a long random secret", () => {
	const a = newFeedToken();
	const b = newFeedToken();
	assert.ok(isFeedToken(a) && a.length >= 43);
	assert.notEqual(a, b);
	assert.equal(isFeedToken("short"), false);
	assert.equal(isFeedToken("../../etc/passwd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false);
});

test("one link per calendar; changing the level keeps it, renewing replaces it", () => {
	let book = setFeed(empty, "Alex@Shop.co.uk", "c1", "all", "alex@gmail.com", now);
	const first = feedOf(book, "alex@shop.co.uk", "c1")!;
	assert.equal(first.level, "all");
	book = setFeed(book, "alex@shop.co.uk", "c1", "busy", "alex@gmail.com", now);
	assert.equal(book.feeds.length, 1);
	assert.equal(feedOf(book, "alex@shop.co.uk", "c1")!.token, first.token);
	assert.equal(feedOf(book, "alex@shop.co.uk", "c1")!.level, "busy");
	book = setFeed(book, "alex@shop.co.uk", "c1", "busy", "alex@gmail.com", now, newFeedToken());
	assert.equal(book.feeds.length, 1);
	assert.notEqual(feedOf(book, "alex@shop.co.uk", "c1")!.token, first.token);
	assert.equal(feedByToken(book, first.token), null);
});

test("turning off one link or every link of a mailbox", () => {
	let book = setFeed(empty, "a@x.com", "c1", "all", "", now);
	book = setFeed(book, "a@x.com", "c2", "all", "", now);
	book = setFeed(book, "b@x.com", "c3", "all", "", now);
	assert.equal(dropFeeds(book, "a@x.com", "c1").feeds.length, 2);
	assert.equal(dropFeeds(book, "a@x.com").feeds.length, 1);
});

test("addresses for the apps", () => {
	const url = feedUrl("https://mail.shop.co.uk/", "abc");
	assert.equal(url, "https://mail.shop.co.uk/f/cal/abc.ics");
	const links = subscribeLinks(url, "Work & play");
	assert.equal(links.apple, "webcal://mail.shop.co.uk/f/cal/abc.ics");
	assert.ok(links.google.startsWith("https://calendar.google.com/calendar/r?cid=webcal%3A%2F%2F"));
	assert.ok(links.outlook.includes("name=Work%20%26%20play"));
});

test("a damaged file is cleaned up", () => {
	const t = newFeedToken();
	const book = cleanFeeds({ feeds: [
		{ token: t, mailbox: "a@x.com", calendarId: "c", level: "all" },
		{ token: newFeedToken(), mailbox: "a@x.com", calendarId: "c", level: "busy" },
		{ token: "bad", mailbox: "a@x.com", calendarId: "d", level: "all" },
		{ token: newFeedToken(), mailbox: "a@x.com", calendarId: "e", level: "everything" },
	] });
	assert.equal(book.feeds.length, 1);
	assert.equal(book.feeds[0].token, t);
});
