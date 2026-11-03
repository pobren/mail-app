// Mail App addition (not part of upstream Agentic Inbox).
// Calendar subscribe links: a private web address for one calendar, so Apple Calendar, Outlook or
// Google Calendar can show it (read only) and keep it up to date. Anyone holding the link can read
// the calendar, so each link is a long random secret that can be turned off or replaced at any time.
// The links for an install live in one small file in R2 (calendar-feeds.json).
//
// Pure functions only, so the browser, the Worker and the tests can all use them.

/** "all": every event (private ones as Busy). "busy": only when you're busy. */
export type FeedLevel = "all" | "busy";

export interface CalendarFeed {
	token: string;
	mailbox: string;
	calendarId: string;
	level: FeedLevel;
	by: string;
	at: string;
}

export interface FeedBook {
	feeds: CalendarFeed[];
}

export const FEEDS_KEY = "calendar-feeds.json";
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
const ADDRESS_RE = /^[a-z0-9.!#$%&'*/=?^_`{|}~+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export const isFeedLevel = (v: unknown): v is FeedLevel => v === "all" || v === "busy";
export const isFeedToken = (v: unknown): v is string => typeof v === "string" && TOKEN_RE.test(v);

/** A new secret: 32 random bytes, written with letters, numbers, - and _. */
export function newFeedToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function cleanFeeds(raw: unknown): FeedBook {
	const list = Array.isArray((raw as FeedBook | null)?.feeds) ? (raw as FeedBook).feeds : [];
	const seen = new Set<string>();
	const feeds: CalendarFeed[] = [];
	for (const f of list) {
		if (!f || typeof f !== "object") continue;
		const mailbox = typeof f.mailbox === "string" ? f.mailbox.trim().toLowerCase() : "";
		if (!isFeedToken(f.token) || !ADDRESS_RE.test(mailbox) || typeof f.calendarId !== "string" || !f.calendarId || !isFeedLevel(f.level)) continue;
		// One link per calendar: the newest wins.
		const key = `${mailbox}|${f.calendarId}`;
		if (seen.has(key) || seen.has(f.token)) continue;
		seen.add(key);
		seen.add(f.token);
		feeds.push({ token: f.token, mailbox, calendarId: f.calendarId, level: f.level, by: typeof f.by === "string" ? f.by : "", at: typeof f.at === "string" ? f.at : "" });
	}
	return { feeds };
}

export function feedOf(book: FeedBook, mailbox: string, calendarId: string): CalendarFeed | null {
	const m = mailbox.toLowerCase();
	return book.feeds.find((f) => f.mailbox === m && f.calendarId === calendarId) ?? null;
}

export function feedByToken(book: FeedBook, token: string): CalendarFeed | null {
	return isFeedToken(token) ? book.feeds.find((f) => f.token === token) ?? null : null;
}

/** Sets a calendar's link: a new secret when `token` is given (the old link stops working), or just a new level. */
export function setFeed(book: FeedBook, mailbox: string, calendarId: string, level: FeedLevel, by: string, now: string, token?: string): FeedBook {
	const m = mailbox.toLowerCase();
	const had = feedOf(book, m, calendarId);
	const feed: CalendarFeed = token || !had
		? { token: token ?? newFeedToken(), mailbox: m, calendarId, level, by, at: now }
		: { ...had, level };
	return { feeds: [feed, ...book.feeds.filter((f) => !(f.mailbox === m && f.calendarId === calendarId))] };
}

/** Turns off a calendar's link, or every link of a mailbox. */
export function dropFeeds(book: FeedBook, mailbox: string, calendarId?: string): FeedBook {
	const m = mailbox.toLowerCase();
	return { feeds: book.feeds.filter((f) => !(f.mailbox === m && (calendarId === undefined || f.calendarId === calendarId))) };
}

/** The web address calendar apps subscribe to. */
export function feedUrl(origin: string, token: string): string {
	return `${origin.replace(/\/+$/, "")}/f/cal/${token}.ics`;
}

/** Links that open the subscribe step in each app. */
export function subscribeLinks(url: string, name: string): { apple: string; google: string; outlook: string } {
	const webcal = url.replace(/^https?:/, "webcal:");
	return {
		apple: webcal,
		google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
		outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`,
	};
}
