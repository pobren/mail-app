// Mail App, 2026: the calendar. Each mailbox has its own calendars, kept in its database, and anyone
// who uses the mailbox can see them (a shared mailbox has a shared calendar). Events keep their
// wall-clock times ("2026-10-14T09:00") with the time zone they were made in, so a weekly 9 o'clock
// meeting stays at 9 o'clock after the clocks change. Repeats are worked out here, with no library.

import type { LabelColor } from "./labels";

/** Calendars and events use the same colours as labels (shared/labels.ts). */
export type CalendarColor = LabelColor;
const COLOUR_KEYS: readonly CalendarColor[] = ["red", "orange", "amber", "green", "teal", "blue", "indigo", "purple", "pink", "brown", "grey", "black"];

export function isCalendarColor(value: unknown): value is CalendarColor {
	return typeof value === "string" && (COLOUR_KEYS as readonly string[]).includes(value);
}

export interface Calendar {
	id: string;
	name: string;
	color: CalendarColor;
	/** A calendar from another website (UK bank holidays, a club's fixtures...): its .ics link. Read only. */
	sourceUrl?: string | null;
	/** When it was last brought up to date, and what went wrong if that didn't work. */
	refreshedAt?: string | null;
	refreshError?: string | null;
}

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Repeat {
	freq: "daily" | "weekly" | "monthly" | "yearly";
	/** Every 1, 2, 3 ... days, weeks, months or years. */
	interval: number;
	/** Weekly: the days it happens on. Empty means the day of the first event. */
	days?: Weekday[];
	/** Monthly: on the same date ("the 14th") or the same weekday ("the second Tuesday"). */
	monthlyBy?: "date" | "weekday";
	/** The last day it can happen on, "YYYY-MM-DD". */
	until?: string | null;
	/** Or how many times it happens in all. */
	count?: number | null;
}

/** How a guest has answered an invite. */
export type GuestStatus = "needs-action" | "accepted" | "tentative" | "declined";

/** Someone invited to an event. */
export interface Guest {
	email: string;
	name: string;
	status: GuestStatus;
}

/** Who sent an invite. Null on an event means it's one of ours, so its guests get our invites. */
export interface Organizer {
	email: string;
	name: string;
}

/** What the app sends to make or change an event. Times are wall-clock times in `timeZone`. */
export interface EventInput {
	calendarId: string;
	title: string;
	allDay: boolean;
	/** "YYYY-MM-DDTHH:mm", or "YYYY-MM-DD" for an all-day event. */
	start: string;
	/** Timed: when it finishes. All day: the day after the last day (so a one-day event ends the next day). */
	end: string;
	timeZone: string;
	location: string;
	notes: string;
	/** Its own colour, or null to use the calendar's. */
	color: CalendarColor | null;
	/** Only the person who made it sees what it is; everyone else sees "Busy". */
	private: boolean;
	repeat: Repeat | null;
	/** Minutes before the start to remind you (0 = when it starts). */
	reminders: number[];
	/** People invited. For an event of ours they're emailed an invite; for one we were invited to, the other guests. */
	guests: Guest[];
	/** A Teams, Zoom, Google Meet or other video call link, shown as a Join button. */
	meetingUrl: string;
}

export interface CalendarEvent extends EventInput {
	id: string;
	/** Start times of repeats that were removed or changed on their own, as wall-clock times. */
	exceptions: string[];
	createdBy: string | null;
	createdByName: string | null;
	createdAt: string;
	updatedAt: string;
	/** The invite's own id, for an event we were invited to. Ours use eventUid(). */
	uid: string | null;
	/** Who invited us, or null for our own events. */
	organizer: Organizer | null;
	/** Goes up each time we send guests a change, so their calendars know which is newest. */
	sequence: number;
	/**
	 * For one date of a repeating event with guests, changed on its own: which date it was, as an ISO
	 * moment (UTC) or, all day, a date. Its uid is then the series' uid.
	 */
	recurrenceId: string | null;
}

/** The id an event has in invites and .ics files. */
export function eventUid(ev: Pick<CalendarEvent, "id" | "uid">, host = "mail-app.local"): string {
	return ev.uid || `${ev.id}@${host}`;
}

/** One time an event happens, as the calendar shows it. */
export interface Occurrence extends EventInput {
	/** Unique on the page: the event id, plus the repeat's start for a repeating event. */
	id: string;
	eventId: string;
	/** For a repeat: its own start (wall-clock), used to change or remove just this one. */
	occurrence: string | null;
	/** Timed: exact moments (ISO, UTC). All day: dates, the end being the day after. */
	startAt: string;
	endAt: string;
	/** Can the person looking change it? False for someone else's private event. */
	canEdit: boolean;
	createdByName: string | null;
	/** Who invited us, for an event we were invited to. */
	organizer: Organizer | null;
	/** Only the time shows, as "Busy" (someone else's private event, or a calendar shared as busy times only). */
	busy?: boolean;
	/** For a calendar someone shared with you: the mailbox it belongs to. */
	owner?: string;
}

export type EditScope = "one" | "following" | "all";

export const MAX_TITLE = 200;
export const MAX_LOCATION = 300;
export const MAX_NOTES = 10_000;
export const MAX_CALENDAR_NAME = 40;
export const MAX_CALENDARS = 20;
export const MAX_REMINDERS = 5;
export const MAX_GUESTS = 50;
export const MAX_MEETING_URL = 1000;

const GUEST_STATUSES: readonly GuestStatus[] = ["needs-action", "accepted", "tentative", "declined"];
const EMAIL_RE = /^[^\s@<>",;:]+@[^\s@<>",;:]+\.[^\s@<>",;:]+$/;

/** Tidies a guest list: real addresses only, each once, at most MAX_GUESTS. */
export function cleanGuests(raw: unknown): Guest[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: Guest[] = [];
	for (const g of raw) {
		const r = (typeof g === "string" ? { email: g } : g) as Record<string, unknown> | null;
		const email = typeof r?.email === "string" ? r.email.trim().toLowerCase() : "";
		if (!EMAIL_RE.test(email) || email.length > 254 || seen.has(email)) continue;
		seen.add(email);
		const name = typeof r?.name === "string" ? r.name.replace(/[\r\n"]/g, " ").trim().slice(0, 100) : "";
		const status = GUEST_STATUSES.includes(r?.status as GuestStatus) ? (r!.status as GuestStatus) : "needs-action";
		out.push({ email, name, status });
		if (out.length >= MAX_GUESTS) break;
	}
	return out;
}

/** A web link for a video call, or "" when it isn't one. */
export function cleanMeetingUrl(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const text = raw.trim();
	if (!text || text.length > MAX_MEETING_URL) return "";
	try {
		const url = new URL(text);
		return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
	} catch {
		return "";
	}
}
/** Reminder choices, in minutes before the start. */
export const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080] as const;

const MINUTE = 60_000;
const DAY = 86_400_000;

// ── Wall-clock times ────────────────────────────────────────────────
// A wall-clock time is handled as if it were UTC ("floating"), which makes date sums simple;
// zonedToUtc turns it into a real moment in its time zone.

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

/** "2026-10-14T09:00" or "2026-10-14" as floating milliseconds, or NaN. */
export function parseWall(text: string): number {
	const m = WALL_RE.exec(text ?? "");
	if (!m) return NaN;
	const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0));
	const d = new Date(ms);
	// Rejects dates such as 31 February, which Date.UTC would quietly roll over.
	if (d.getUTCDate() !== +m[3] || d.getUTCMonth() !== +m[2] - 1) return NaN;
	if (m[4] !== undefined && (+m[4] > 23 || +m[5] > 59)) return NaN;
	return ms;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatWallDate(ms: number): string {
	const d = new Date(ms);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function formatWall(ms: number, allDay = false): string {
	if (allDay) return formatWallDate(ms);
	const d = new Date(ms);
	return `${formatWallDate(ms)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

export function isTimeZone(tz: unknown): tz is string {
	if (typeof tz !== "string" || !tz || tz.length > 64) return false;
	try {
		new Intl.DateTimeFormat("en-GB", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** How far ahead of UTC the zone is at this moment, in milliseconds. */
function zoneOffset(utcMs: number, tz: string): number {
	let f = zoneFormats.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
			hour: "2-digit", minute: "2-digit", second: "2-digit",
		});
		zoneFormats.set(tz, f);
	}
	const p: Record<string, number> = {};
	for (const part of f.formatToParts(new Date(utcMs))) if (part.type !== "literal") p[part.type] = Number(part.value);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
	return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The real moment a wall-clock time happens in a time zone. A time skipped when clocks go forward moves on an hour. */
export function zonedToUtc(wallMs: number, tz: string): number {
	const first = wallMs - zoneOffset(wallMs, tz);
	const second = wallMs - zoneOffset(first, tz);
	return second;
}

/** The wall-clock time in a zone at a real moment. */
export function utcToZoned(utcMs: number, tz: string): number {
	return utcMs + zoneOffset(utcMs, tz);
}

// ── Repeats ─────────────────────────────────────────────────────────

const weekdayOf = (ms: number) => (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Which week of the month a date falls in: 1 to 4, or -1 for the last one. */
export function weekOfMonth(ms: number): number {
	const n = Math.ceil(new Date(ms).getUTCDate() / 7);
	return n >= 5 ? -1 : n;
}

function nthWeekday(y: number, m: number, weekday: number, nth: number): number | null {
	if (nth > 0) {
		const first = Date.UTC(y, m, 1);
		const day = 1 + ((weekday - weekdayOf(first) + 7) % 7) + (nth - 1) * 7;
		return day <= daysInMonth(y, m) ? Date.UTC(y, m, day) : null;
	}
	const lastDay = daysInMonth(y, m);
	const last = Date.UTC(y, m, lastDay);
	return Date.UTC(y, m, lastDay - ((weekdayOf(last) - weekday + 7) % 7));
}

/**
 * Start times (floating ms) of a repeating series, in order, from `startMs`. Calls `visit` for each;
 * stop by returning false. `fromMs` lets daily and weekly repeats without a count skip ahead.
 */
export function eachRepeat(startMs: number, repeat: Repeat, visit: (ms: number) => boolean, fromMs = -Infinity): void {
	const interval = Math.max(1, Math.floor(repeat.interval || 1));
	const untilMs = repeat.until ? parseWall(repeat.until) + DAY - 1 : Infinity;
	const count = repeat.count && repeat.count > 0 ? repeat.count : Infinity;
	const timeOfDay = ((startMs % DAY) + DAY) % DAY;
	const s = new Date(startMs);
	let made = 0;
	const emit = (ms: number): boolean => {
		if (ms < startMs) return true;
		if (ms > untilMs || made >= count) return false;
		made++;
		return visit(ms);
	};
	const skipAhead = count === Infinity && fromMs > startMs;
	const LIMIT = 100_000;

	if (repeat.freq === "daily") {
		let k = skipAhead ? Math.max(0, Math.floor((fromMs - startMs) / (interval * DAY)) - 1) : 0;
		for (let i = 0; i < LIMIT; i++, k++) if (!emit(startMs + k * interval * DAY)) return;
		return;
	}
	if (repeat.freq === "weekly") {
		const days = (repeat.days?.length ? repeat.days : [WEEKDAYS[weekdayOf(startMs)]])
			.map((d) => WEEKDAYS.indexOf(d)).filter((d) => d >= 0).sort((a, b) => a - b);
		const weekStart = startMs - weekdayOf(startMs) * DAY; // Monday, same time of day
		let w = skipAhead ? Math.max(0, Math.floor((fromMs - weekStart) / (interval * 7 * DAY)) - 1) : 0;
		for (let i = 0; i < LIMIT; i++, w++) {
			for (const d of days) if (!emit(weekStart + (w * interval * 7 + d) * DAY)) return;
		}
		return;
	}
	if (repeat.freq === "monthly") {
		const byWeekday = repeat.monthlyBy === "weekday";
		const nth = weekOfMonth(startMs);
		const weekday = weekdayOf(startMs);
		for (let k = 0; k < LIMIT; k++) {
			const total = s.getUTCMonth() + k * interval;
			const y = s.getUTCFullYear() + Math.floor(total / 12);
			const m = total % 12;
			let day: number | null;
			if (byWeekday) day = nthWeekday(y, m, weekday, nth);
			else day = s.getUTCDate() <= daysInMonth(y, m) ? Date.UTC(y, m, s.getUTCDate()) : null;
			if (day === null) {
				if (Date.UTC(y, m, 1) > untilMs) return;
				continue;
			}
			if (!emit(day + timeOfDay)) return;
		}
		return;
	}
	// Yearly. 29 February only happens in leap years.
	for (let k = 0; k < LIMIT; k++) {
		const y = s.getUTCFullYear() + k * interval;
		if (s.getUTCDate() > daysInMonth(y, s.getUTCMonth())) {
			if (Date.UTC(y, 0, 1) > untilMs) return;
			continue;
		}
		if (!emit(Date.UTC(y, s.getUTCMonth(), s.getUTCDate()) + timeOfDay)) return;
	}
}

/** How many times a series happens before a given start (floating ms). */
export function countBefore(startMs: number, repeat: Repeat, beforeMs: number): number {
	let n = 0;
	eachRepeat(startMs, repeat, (ms) => {
		if (ms >= beforeMs) return false;
		n++;
		return true;
	});
	return n;
}

/** The start of the last repeat (floating ms), or null if it goes on for ever. */
export function lastRepeatStart(startMs: number, repeat: Repeat): number | null {
	if (!repeat.until && !repeat.count) return null;
	let last = startMs;
	eachRepeat(startMs, repeat, (ms) => {
		last = ms;
		return true;
	});
	return last;
}

/** The event's real start and end in its zone (all-day events run midnight to midnight there). */
function momentsOf(ev: Pick<EventInput, "timeZone">, wallStart: number, wallEnd: number) {
	return { start: zonedToUtc(wallStart, ev.timeZone), end: zonedToUtc(wallEnd, ev.timeZone) };
}

/**
 * Every time an event happens that overlaps [fromMs, toMs), as real moments. All-day events are
 * placed in their own time zone, which is close enough for showing them.
 */
export function occurrencesOf(ev: CalendarEvent, fromMs: number, toMs: number, max = 1000): { wallStart: number; wallEnd: number; start: number; end: number; occurrence: string | null }[] {
	const wallStart = parseWall(ev.start);
	const wallEnd = parseWall(ev.end);
	if (Number.isNaN(wallStart) || Number.isNaN(wallEnd)) return [];
	const length = Math.max(0, wallEnd - wallStart);
	const out: { wallStart: number; wallEnd: number; start: number; end: number; occurrence: string | null }[] = [];
	const overlaps = (start: number, end: number) => start < toMs && (end > fromMs || (end === start && start >= fromMs));
	if (!ev.repeat) {
		const m = momentsOf(ev, wallStart, wallEnd);
		if (overlaps(m.start, m.end)) out.push({ wallStart, wallEnd, ...m, occurrence: null });
		return out;
	}
	const skipped = new Set(ev.exceptions);
	// Floating times can be up to 14 hours either side of UTC, so look a little wider.
	const fromWall = fromMs - length - 2 * DAY;
	const toWall = toMs + 2 * DAY;
	eachRepeat(wallStart, ev.repeat, (ms) => {
		if (ms >= toWall) return false;
		if (ms + length < fromWall) return true;
		const key = formatWall(ms, ev.allDay);
		if (skipped.has(key)) return true;
		const m = momentsOf(ev, ms, ms + length);
		if (overlaps(m.start, m.end)) out.push({ wallStart: ms, wallEnd: ms + length, ...m, occurrence: key });
		return out.length < max;
	}, fromWall - length);
	return out;
}

/** The earliest real start and latest real end of an event, for finding it by date (null end = for ever). */
export function spanOf(ev: EventInput): { first: number; last: number | null } {
	const wallStart = parseWall(ev.start);
	const wallEnd = parseWall(ev.end);
	const first = zonedToUtc(wallStart, ev.timeZone);
	if (!ev.repeat) return { first, last: zonedToUtc(wallEnd, ev.timeZone) };
	const lastStart = lastRepeatStart(wallStart, ev.repeat);
	if (lastStart === null) return { first, last: null };
	return { first, last: zonedToUtc(lastStart + (wallEnd - wallStart), ev.timeZone) };
}

// ── Checking what the app sends ─────────────────────────────────────

const tidy = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, max) : "");

export function cleanCalendarName(name: unknown): string {
	return typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, MAX_CALENDAR_NAME) : "";
}

export function cleanRepeat(raw: unknown): Repeat | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (!["daily", "weekly", "monthly", "yearly"].includes(r.freq as string)) return null;
	const interval = Math.min(99, Math.max(1, Math.floor(Number(r.interval) || 1)));
	const out: Repeat = { freq: r.freq as Repeat["freq"], interval };
	if (out.freq === "weekly" && Array.isArray(r.days)) {
		const days = WEEKDAYS.filter((d) => (r.days as unknown[]).includes(d));
		if (days.length) out.days = days;
	}
	if (out.freq === "monthly") out.monthlyBy = r.monthlyBy === "weekday" ? "weekday" : "date";
	if (typeof r.until === "string" && !Number.isNaN(parseWall(r.until)) && r.until.length === 10) out.until = r.until;
	else if (Number(r.count) >= 1) out.count = Math.min(999, Math.floor(Number(r.count)));
	return out;
}

/** Checks an event from the app. Returns the tidied event, or a sentence saying what's wrong. */
export function cleanEventInput(raw: unknown): EventInput | string {
	if (!raw || typeof raw !== "object") return "Something was missing. Please try again.";
	const r = raw as Record<string, unknown>;
	const allDay = !!r.allDay;
	const start = typeof r.start === "string" ? r.start : "";
	const end = typeof r.end === "string" ? r.end : "";
	const wantLength = allDay ? 10 : 16;
	const startMs = parseWall(start);
	const endMs = parseWall(end);
	if (start.length !== wantLength || end.length !== wantLength || Number.isNaN(startMs) || Number.isNaN(endMs)) return "Please check the start and end times.";
	if (endMs < startMs || (allDay && endMs === startMs)) return "The event has to end after it starts.";
	if (endMs - startMs > 366 * DAY) return "An event can last up to a year.";
	const timeZone = isTimeZone(r.timeZone) ? r.timeZone : "Europe/London";
	const reminders = Array.isArray(r.reminders)
		? [...new Set(r.reminders.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 4 * 7 * 24 * 60))].sort((a, b) => a - b).slice(0, MAX_REMINDERS)
		: [];
	const repeat = cleanRepeat(r.repeat);
	if (repeat?.until && parseWall(repeat.until) < parseWall(start.slice(0, 10))) return "The repeat has to end after the first event.";
	return {
		calendarId: typeof r.calendarId === "string" ? r.calendarId : "",
		title: tidy(r.title, MAX_TITLE) || "(No title)",
		allDay,
		start,
		end,
		timeZone,
		location: tidy(r.location, MAX_LOCATION),
		notes: tidy(r.notes, MAX_NOTES),
		color: isCalendarColor(r.color) ? r.color : null,
		private: !!r.private,
		repeat,
		reminders,
		guests: cleanGuests(r.guests),
		meetingUrl: cleanMeetingUrl(r.meetingUrl),
	};
}

// ── Words ───────────────────────────────────────────────────────────

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ORDINAL_WEEK = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" } as Record<number, string>;

export function ordinal(n: number): string {
	const t = n % 100;
	if (t >= 11 && t <= 13) return `${n}th`;
	return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

function listWords(items: string[]): string {
	return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const longDate = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** "Every 2 weeks on Monday and Wednesday, until 3 March 2027", in plain UK English. */
export function describeRepeat(repeat: Repeat, start: string): string {
	const startMs = parseWall(start);
	const n = repeat.interval || 1;
	const every = (unit: string) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);
	let text: string;
	if (repeat.freq === "daily") text = n === 1 ? "Every day" : `Every ${n} days`;
	else if (repeat.freq === "weekly") {
		const days = (repeat.days?.length ? repeat.days : [WEEKDAYS[weekdayOf(startMs)]]).map((d) => WEEKDAYS.indexOf(d));
		const weekdays = days.length === 5 && [0, 1, 2, 3, 4].every((d) => days.includes(d));
		text = weekdays && n === 1 ? "Every weekday (Monday to Friday)" : `${every("week")} on ${listWords(days.sort().map((d) => DAY_NAMES[d]))}`;
	} else if (repeat.freq === "monthly") {
		const d = new Date(startMs);
		text = repeat.monthlyBy === "weekday"
			? `${every("month")} on the ${ORDINAL_WEEK[weekOfMonth(startMs)]} ${DAY_NAMES[weekdayOf(startMs)]}`
			: `${every("month")} on the ${ordinal(d.getUTCDate())}`;
	} else {
		text = `${every("year")} on ${new Date(startMs).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })}`;
	}
	if (repeat.until) text += `, until ${longDate(parseWall(repeat.until))}`;
	else if (repeat.count) text += repeat.count === 1 ? ", once" : `, ${repeat.count} times`;
	return text;
}

/** All-day events remind you at 9 in the morning, on the day or the days before. */
export const ALL_DAY_REMINDER_HOUR = 9;
export const ALL_DAY_REMINDER_CHOICES = [0, 1440, 2880, 10080] as const;

/** "10 minutes before", "1 day before", "When it starts"; for all-day events, "On the day at 9am". */
export function describeReminder(minutes: number, allDay = false): string {
	if (allDay) {
		const days = Math.round(minutes / 1440);
		if (days === 0) return "On the day at 9am";
		if (days === 1) return "The day before at 9am";
		if (days === 7) return "1 week before at 9am";
		return `${days} days before at 9am`;
	}
	if (minutes === 0) return "When it starts";
	const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} before`;
	if (minutes % 10080 === 0) return unit(minutes / 10080, "week");
	if (minutes % 1440 === 0) return unit(minutes / 1440, "day");
	if (minutes % 60 === 0) return unit(minutes / 60, "hour");
	return unit(minutes, "minute");
}

/** When a reminder goes off, as a real moment, for one time an event happens (its real start). */
export function reminderMoment(ev: Pick<EventInput, "allDay" | "timeZone">, wallStart: number, realStart: number, minutes: number): number {
	if (!ev.allDay) return realStart - minutes * MINUTE;
	return zonedToUtc(wallStart + ALL_DAY_REMINDER_HOUR * 3_600_000 - minutes * MINUTE, ev.timeZone);
}

// ── .ics (iCalendar) export ─────────────────────────────────────────

export function icsText(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

/** Long lines are folded at 75 bytes, as the standard asks. */
export function fold(line: string): string {
	const out: string[] = [];
	let rest = line;
	while (new TextEncoder().encode(rest).length > 75) {
		let cut = 74;
		while (new TextEncoder().encode(rest.slice(0, cut)).length > 74) cut--;
		out.push(rest.slice(0, cut));
		rest = " " + rest.slice(cut);
	}
	out.push(rest);
	return out.join("\r\n");
}

export const icsWall = (wall: string, allDay: boolean) => (allDay ? wall.replace(/-/g, "") : `${wall.replace(/[-:]/g, "")}00`);
export const icsUtc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export function repeatToRrule(repeat: Repeat, ev: Pick<EventInput, "start" | "allDay" | "timeZone">): string {
	const parts = [`FREQ=${repeat.freq.toUpperCase()}`];
	if (repeat.interval > 1) parts.push(`INTERVAL=${repeat.interval}`);
	const startMs = parseWall(ev.start);
	if (repeat.freq === "weekly") parts.push(`BYDAY=${(repeat.days?.length ? repeat.days : [WEEKDAYS[weekdayOf(startMs)]]).join(",")}`);
	if (repeat.freq === "monthly" && repeat.monthlyBy === "weekday") parts.push(`BYDAY=${weekOfMonth(startMs)}${WEEKDAYS[weekdayOf(startMs)]}`);
	if (repeat.until) {
		const end = parseWall(repeat.until) + DAY - MINUTE;
		parts.push(`UNTIL=${ev.allDay ? repeat.until.replace(/-/g, "") : icsUtc(zonedToUtc(end, ev.timeZone))}`);
	} else if (repeat.count) parts.push(`COUNT=${repeat.count}`);
	return parts.join(";");
}

/** A whole calendar as an .ics file that Apple Calendar, Outlook and Google Calendar can import. */
export function toIcs(name: string, events: CalendarEvent[], host = "mail-app.local"): string {
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mail App//Mail App//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${icsText(name)}`];
	for (const ev of events) {
		const tz = ev.allDay ? "" : `;TZID=${ev.timeZone}`;
		const kind = ev.allDay ? ";VALUE=DATE" : "";
		lines.push(
			"BEGIN:VEVENT",
			`UID:${eventUid(ev, host)}`,
			`DTSTAMP:${icsUtc(Date.parse(ev.updatedAt) || Date.now())}`,
			`DTSTART${kind}${tz}:${icsWall(ev.start, ev.allDay)}`,
			`DTEND${kind}${tz}:${icsWall(ev.end, ev.allDay)}`,
			`SUMMARY:${icsText(ev.title)}`,
		);
		if (ev.location) lines.push(`LOCATION:${icsText(ev.location)}`);
		if (ev.meetingUrl) lines.push(`URL:${ev.meetingUrl}`);
		if (ev.notes) lines.push(`DESCRIPTION:${icsText(ev.notes)}`);
		if (ev.private) lines.push("CLASS:PRIVATE");
		if (ev.repeat) {
			lines.push(`RRULE:${repeatToRrule(ev.repeat, ev)}`);
			for (const ex of ev.exceptions) lines.push(`EXDATE${kind}${tz}:${icsWall(ex, ev.allDay)}`);
		}
		for (const r of ev.reminders) {
			const trigger = ev.allDay ? (r === 0 ? `PT${ALL_DAY_REMINDER_HOUR}H` : `-PT${r - ALL_DAY_REMINDER_HOUR * 60}M`) : `-PT${r}M`;
			lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(ev.title)}`, `TRIGGER:${trigger}`, "END:VALARM");
		}
		lines.push("END:VEVENT");
	}
	lines.push("END:VCALENDAR");
	return lines.map(fold).join("\r\n") + "\r\n";
}

/** Which date of a series a repeat is, as invites name it: an ISO moment (UTC), or a date for all day. */
export function recurrenceIdOf(series: Pick<EventInput, "allDay" | "timeZone">, occurrence: string): string {
	return series.allDay ? occurrence.slice(0, 10) : new Date(zonedToUtc(parseWall(occurrence), series.timeZone)).toISOString();
}

/** A recurrence id back as the series' own wall-clock time (how its exceptions are kept). */
export function recurrenceWall(series: Pick<EventInput, "allDay" | "timeZone">, recurrenceId: string): string {
	if (/^\d{4}-\d{2}-\d{2}$/.test(recurrenceId)) return series.allDay ? recurrenceId : `${recurrenceId}T00:00`;
	const wall = formatWall(utcToZoned(Date.parse(recurrenceId), series.timeZone));
	return series.allDay ? wall.slice(0, 10) : wall;
}
