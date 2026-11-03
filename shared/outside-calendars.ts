// Mail App addition (not part of upstream Agentic Inbox).
// Calendars from other websites: someone pastes the link to an .ics calendar (UK bank holidays, a
// sports club's fixtures, a colleague's Google or Outlook calendar shared as a link) and Mail App
// shows it alongside their own, read only, bringing it up to date every few hours. The same reading
// brings in an .ics file someone imports (from Google Calendar, Outlook or Apple Calendar).
//
// Pure functions only, so the browser, the Worker and the tests can all use them.

import { parseWall, recurrenceWall, type EventInput } from "./calendar.ts";
import { eventFromInvite, exceptionsFromInvite, parseIcs, recurrenceIdFromInvite } from "./invites.ts";

/** How often a calendar from another website is brought up to date (when someone looks at the calendar). */
export const REFRESH_EVERY_MS = 6 * 60 * 60_000;
/** The biggest file and the most events we take in from one. */
export const MAX_OUTSIDE_BYTES = 5 * 1024 * 1024;
export const MAX_OUTSIDE_EVENTS = 5000;
/** One-off events that ended longer ago than this are left out, to keep big calendars light. */
const KEEP_PAST_MS = 400 * 86_400_000;
export const MAX_URL = 2000;

export const OUTSIDE_WORDS = "This calendar comes from another website, so it can't be changed here.";

/** UK bank holidays, from GOV.UK, offered as one-click choices. */
export const BANK_HOLIDAYS = [
	{ name: "Bank holidays (England and Wales)", url: "https://www.gov.uk/bank-holidays/england-and-wales.ics" },
	{ name: "Bank holidays (Scotland)", url: "https://www.gov.uk/bank-holidays/scotland.ics" },
	{ name: "Bank holidays (Northern Ireland)", url: "https://www.gov.uk/bank-holidays/northern-ireland.ics" },
] as const;

/**
 * The link as one we can fetch: webcal:// becomes https://. Null if it isn't a web address, or
 * points at this computer or a private network (which a calendar link never should).
 */
export function cleanSourceUrl(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const text = raw.trim().replace(/^webcals?:\/\//i, "https://");
	if (!text || text.length > MAX_URL) return null;
	let url: URL;
	try { url = new URL(text); } catch { return null; }
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.username || url.password) return null;
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
	// Addresses written as numbers: IPv6 ones, and IPv4 ones on a private or local network.
	if (host.startsWith("[")) return null;
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && /^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
	return url.toString();
}

/** One event from the file, ready to save: our kind of event, plus the file's own id for it. */
export interface OutsideEvent {
	input: EventInput;
	uid: string;
	exceptions: string[];
	recurrenceId: string | null;
}

/**
 * Reads an .ics file into events for the calendar `calendarId`. Floating times (no zone) are read in
 * `tz`. Cancelled events are left out, as are one-off events long past. Returns a sentence when the
 * file isn't a calendar.
 */
export function outsideEvents(text: string, calendarId: string, tz: string, now = Date.now(), keepPast = false): OutsideEvent[] | string {
	if (!/BEGIN:VCALENDAR/i.test(text)) return "That link isn't a calendar. Look for a link ending in .ics, or one called \"iCal\", \"subscribe\" or \"public address\".";
	const file = parseIcs(text);
	const out: OutsideEvent[] = [];
	const series = new Map<string, OutsideEvent>();
	const changed: { uid: string; rid: string }[] = [];
	for (const ev of file.events) {
		if (ev.status === "CANCELLED") continue;
		const input = { ...eventFromInvite(ev, file, tz, calendarId), reminders: [], guests: [] };
		const rid = recurrenceIdFromInvite(ev, file, tz);
		if (!keepPast && !input.repeat && !rid && parseWall(input.end) < now - KEEP_PAST_MS) continue;
		const item: OutsideEvent = { input, uid: ev.uid || crypto.randomUUID(), exceptions: rid ? [] : exceptionsFromInvite(ev, file, input), recurrenceId: rid };
		if (rid) changed.push({ uid: item.uid, rid });
		else if (input.repeat) series.set(item.uid, item);
		out.push(item);
		if (out.length >= MAX_OUTSIDE_EVENTS) break;
	}
	// A date of a series changed on its own: the series skips that date.
	for (const { uid, rid } of changed) {
		const s = series.get(uid);
		if (!s) continue;
		const skip = recurrenceWall(s.input, rid);
		if (!s.exceptions.includes(skip)) s.exceptions.push(skip);
	}
	return out;
}

/** "Updated 2 hours ago" style words, for the calendar window. */
export function refreshedWords(iso: string | null | undefined, now = Date.now()): string {
	if (!iso) return "Not updated yet";
	const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
	if (mins < 2) return "Updated just now";
	if (mins < 60) return `Updated ${mins} minutes ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `Updated ${hours === 1 ? "1 hour" : `${hours} hours`} ago`;
	return `Updated on ${new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`;
}
