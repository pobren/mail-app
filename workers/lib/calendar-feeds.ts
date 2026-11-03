// Mail App addition (not part of upstream Agentic Inbox).
// Calendar subscribe links (see shared/calendar-feeds.ts): reading and saving calendar-feeds.json,
// and the public /f/cal/<secret>.ics address calendar apps read. That address is the only calendar
// route open without signing in (a Cloudflare Access bypass rule exempts /f/ from sign-in).

import { Hono } from "hono";
import { cleanFeeds, dropFeeds, feedByToken, FEEDS_KEY, type FeedBook } from "../../shared/calendar-feeds";
import { vtimezone } from "../../shared/invites";
import type { Env } from "../types";

export async function loadFeeds(bucket: R2Bucket): Promise<{ book: FeedBook; etag: string | null }> {
	const obj = await bucket.get(FEEDS_KEY);
	if (!obj) return { book: cleanFeeds(null), etag: null };
	try {
		return { book: cleanFeeds(await obj.json()), etag: obj.etag };
	} catch {
		return { book: cleanFeeds(null), etag: obj.etag };
	}
}

/** Changes the links safely when two changes happen at once: only saves if nobody else saved in between. */
export async function updateFeeds(bucket: R2Bucket, change: (book: FeedBook) => FeedBook): Promise<FeedBook | string> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const { book, etag } = await loadFeeds(bucket);
		const next = change(book);
		const opts: R2PutOptions = { httpMetadata: { contentType: "application/json" } };
		// The very first save has nothing to compare with.
		if (etag) opts.onlyIf = { etagMatches: etag };
		if (await bucket.put(FEEDS_KEY, JSON.stringify(cleanFeeds(next)), opts)) return next;
	}
	return "Subscribe links are busy. Please try again.";
}

/** A deleted calendar (or mailbox) has no subscribe link any more. */
export async function forgetCalendarFeeds(env: Env, mailbox: string, calendarId?: string): Promise<void> {
	const { book } = await loadFeeds(env.BUCKET);
	const m = mailbox.toLowerCase();
	if (!book.feeds.some((f) => f.mailbox === m && (calendarId === undefined || f.calendarId === calendarId))) return;
	await updateFeeds(env.BUCKET, (b) => dropFeeds(b, m, calendarId));
}

/** Adds the time zones an .ics file's events use, which Outlook needs to place them. */
export function withTimeZones(ics: string, now = Date.now()): string {
	const zones = [...new Set([...ics.matchAll(/;TZID=([^:;\r\n]+)/g)].map((m) => m[1]))];
	if (!zones.length) return ics;
	const blocks = zones.flatMap((tz) => {
		try { return vtimezone(tz, now); } catch { return []; }
	});
	return ics.replace("BEGIN:VEVENT", `${blocks.join("\r\n")}\r\nBEGIN:VEVENT`);
}

const HEADERS = { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const gone = () => new Response("This calendar link has been turned off.", { status: 404, headers: { ...HEADERS, "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });

/** Mounted at /f/cal: the calendar behind a subscribe link, as an .ics file. */
export const publicFeeds = new Hono<{ Bindings: Env }>();

publicFeeds.get("/:file", async (c) => {
	const token = (c.req.param("file") ?? "").replace(/\.ics$/i, "");
	const { book } = await loadFeeds(c.env.BUCKET);
	const feed = feedByToken(book, token);
	if (!feed || !(await c.env.BUCKET.head(`mailboxes/${feed.mailbox}.json`))) return gone();
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(feed.mailbox));
	const found = await stub.feedCalendar(feed.calendarId, feed.level);
	if (!found) return gone();
	// Asks apps that listen (Apple Calendar, Outlook) to check back every hour.
	const ics = withTimeZones(found.ics).replace("CALSCALE:GREGORIAN", "CALSCALE:GREGORIAN\r\nREFRESH-INTERVAL;VALUE=DURATION:PT1H\r\nX-PUBLISHED-TTL:PT1H");
	return new Response(ics, {
		headers: {
			...HEADERS,
			"content-type": "text/calendar; charset=utf-8",
			"content-disposition": `inline; filename="${found.name.replace(/[^\w\- ]+/g, "").trim() || "calendar"}.ics"`,
			// Calendar apps check back every so often; a few minutes' caching keeps that light.
			"cache-control": "private, max-age=300",
		},
	});
});

publicFeeds.all("*", () => gone());
