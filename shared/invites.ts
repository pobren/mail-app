// Mail App, 2026: calendar invites. Builds the invites we email to guests (and our answers to invites
// we're sent), and reads the ones that arrive from Outlook, Gmail, Apple Calendar and the rest. These
// follow iCalendar's invite rules (iTIP, RFC 5546): REQUEST invites people, REPLY answers, CANCEL calls off.
// Also finds Teams, Zoom, Google Meet and other video call links.

import {
	cleanGuests, eventUid, fold, formatWall, icsText, icsUtc, icsWall, isTimeZone, parseWall, utcToZoned, zonedToUtc,
	WEEKDAYS, type CalendarEvent, type EventInput, type Guest, type GuestStatus, type Organizer, type Repeat, type Weekday,
	repeatToRrule,
} from "./calendar.ts";

const DAY = 86_400_000;
const MINUTE = 60_000;

// ── Video call links ───────────────────────────────────────────────

export type MeetingKind = "teams" | "zoom" | "meet" | "jitsi" | "webex" | "video";

const MEETING_HOSTS: [RegExp, MeetingKind][] = [
	[/(^|\.)teams\.(microsoft|live)\.com$/i, "teams"],
	[/(^|\.)zoom\.(us|com)$/i, "zoom"],
	[/^meet\.google\.com$/i, "meet"],
	[/(^|\.)jit\.si$/i, "jitsi"],
	[/^8x8\.vc$/i, "jitsi"],
	[/(^|\.)webex\.com$/i, "webex"],
	[/(^|\.)whereby\.com$/i, "video"],
	[/(^|\.)gotomeeting\.com$/i, "video"],
	[/(^|\.)facetime\.apple\.com$/i, "video"],
];

/** Which video call service a link is for ("video" for one we don't know by name). */
export function meetingKind(url: string): MeetingKind {
	try {
		const host = new URL(url).hostname;
		return MEETING_HOSTS.find(([re]) => re.test(host))?.[1] ?? "video";
	} catch {
		return "video";
	}
}

/** "Join Teams meeting", "Join Zoom meeting", "Join video call" and so on. */
export function joinWords(url: string): string {
	return ({
		teams: "Join Teams meeting",
		zoom: "Join Zoom meeting",
		meet: "Join Google Meet",
		jitsi: "Join video call",
		webex: "Join Webex meeting",
		video: "Join video call",
	} as const)[meetingKind(url)];
}

/** The first link to a video call service we know, in any of these bits of text (a location, notes...). */
export function findMeetingLink(...texts: (string | null | undefined)[]): string {
	for (const text of texts) {
		for (const m of (text ?? "").matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
			const url = m[0].replace(/[.,;:!?]+$/, "");
			try {
				const host = new URL(url).hostname;
				if (MEETING_HOSTS.some(([re]) => re.test(host))) return url;
			} catch { /* not a link after all */ }
		}
	}
	return "";
}

/** A new free Jitsi Meet room with a name nobody will guess. */
export function newJitsiLink(): string {
	const letters = "abcdefghijkmnpqrstuvwxyz23456789";
	const bytes = crypto.getRandomValues(new Uint8Array(14));
	return `https://meet.jit.si/Mail-${[...bytes].map((b) => letters[b % letters.length]).join("")}`;
}

// ── Time zones in invites ──────────────────────────────────────────

/** Outlook and Exchange name time zones their own way. The common ones, as the zones everyone else uses. */
const WINDOWS_ZONES: Record<string, string> = {
	"GMT Standard Time": "Europe/London",
	"Greenwich Standard Time": "Atlantic/Reykjavik",
	"W. Europe Standard Time": "Europe/Berlin",
	"Romance Standard Time": "Europe/Paris",
	"Central Europe Standard Time": "Europe/Budapest",
	"Central European Standard Time": "Europe/Warsaw",
	"E. Europe Standard Time": "Europe/Chisinau",
	"FLE Standard Time": "Europe/Kiev",
	"GTB Standard Time": "Europe/Bucharest",
	"Russian Standard Time": "Europe/Moscow",
	"Turkey Standard Time": "Europe/Istanbul",
	"Israel Standard Time": "Asia/Jerusalem",
	"South Africa Standard Time": "Africa/Johannesburg",
	"Egypt Standard Time": "Africa/Cairo",
	"Arabian Standard Time": "Asia/Dubai",
	"India Standard Time": "Asia/Kolkata",
	"China Standard Time": "Asia/Shanghai",
	"Singapore Standard Time": "Asia/Singapore",
	"Tokyo Standard Time": "Asia/Tokyo",
	"Korea Standard Time": "Asia/Seoul",
	"AUS Eastern Standard Time": "Australia/Sydney",
	"E. Australia Standard Time": "Australia/Brisbane",
	"W. Australia Standard Time": "Australia/Perth",
	"New Zealand Standard Time": "Pacific/Auckland",
	"Eastern Standard Time": "America/New_York",
	"Central Standard Time": "America/Chicago",
	"Mountain Standard Time": "America/Denver",
	"US Mountain Standard Time": "America/Phoenix",
	"Pacific Standard Time": "America/Los_Angeles",
	"Alaskan Standard Time": "America/Anchorage",
	"Hawaiian Standard Time": "Pacific/Honolulu",
	"Atlantic Standard Time": "America/Halifax",
	"Canada Central Standard Time": "America/Regina",
	"SA Pacific Standard Time": "America/Bogota",
	"E. South America Standard Time": "America/Sao_Paulo",
	"Argentina Standard Time": "America/Buenos_Aires",
	"Mexico Standard Time": "America/Mexico_City",
	"Central America Standard Time": "America/Guatemala",
	"UTC": "UTC",
	"Coordinated Universal Time": "UTC",
};

/** The time zone a TZID names, if we can tell. Handles Outlook's names and "/mozilla.org/..." style prefixes. */
export function zoneFromTzid(tzid: string | null | undefined): string | null {
	if (!tzid) return null;
	const name = tzid.replace(/^"|"$/g, "").trim();
	if (WINDOWS_ZONES[name]) return WINDOWS_ZONES[name];
	if (isTimeZone(name as unknown)) return name;
	// "/mozilla.org/20050126_1/Europe/London", "/Europe/London"
	const tail = String(name).match(/([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/)?.[1];
	if (tail && isTimeZone(tail)) return tail;
	// "(UTC+00:00) Dublin, Edinburgh, Lisbon, London"
	if (/London|Dublin|Edinburgh/i.test(String(name))) return "Europe/London";
	return null;
}

const offsetText = (ms: number) => {
	const sign = ms < 0 ? "-" : "+";
	const mins = Math.round(Math.abs(ms) / MINUTE);
	return `${sign}${String(Math.floor(mins / 60)).padStart(2, "0")}${String(mins % 60).padStart(2, "0")}`;
};
const zoneOffsetAt = (utcMs: number, tz: string) => utcToZoned(utcMs, tz) - utcMs;

/**
 * A VTIMEZONE block for a zone, listing each change of the clocks from a year before `aroundMs` to
 * five years after. Outlook needs one for invites with local times; Gmail and Apple are happy with it.
 */
export function vtimezone(tz: string, aroundMs: number): string[] {
	const from = aroundMs - 366 * DAY;
	const to = aroundMs + 5 * 366 * DAY;
	const changes: { at: number; before: number; after: number }[] = [];
	let prev = zoneOffsetAt(from, tz);
	for (let t = from + DAY; t <= to; t += DAY) {
		const now = zoneOffsetAt(t, tz);
		if (now === prev) continue;
		// Narrow down to the minute it happened.
		let lo = t - DAY;
		let hi = t;
		while (hi - lo > MINUTE) {
			const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE || lo + MINUTE;
			if (zoneOffsetAt(mid, tz) === prev) lo = mid;
			else hi = mid;
		}
		changes.push({ at: hi, before: prev, after: now });
		prev = now;
	}
	const lines = ["BEGIN:VTIMEZONE", `TZID:${tz}`];
	const first = zoneOffsetAt(from, tz);
	const kind = (before: number, after: number) => (after > before ? "DAYLIGHT" : "STANDARD");
	lines.push("BEGIN:STANDARD", "DTSTART:19700101T000000", `TZOFFSETFROM:${offsetText(first)}`, `TZOFFSETTO:${offsetText(first)}`, "END:STANDARD");
	for (const c of changes) {
		const local = formatWall(c.at + c.before).replace(/[-:]/g, "") + "00";
		const k = kind(c.before, c.after);
		lines.push(`BEGIN:${k}`, `DTSTART:${local}`, `TZOFFSETFROM:${offsetText(c.before)}`, `TZOFFSETTO:${offsetText(c.after)}`, `END:${k}`);
	}
	lines.push("END:VTIMEZONE");
	return lines;
}

// ── Writing invites ────────────────────────────────────────────────

const PARTSTAT: Record<GuestStatus, string> = { "needs-action": "NEEDS-ACTION", accepted: "ACCEPTED", tentative: "TENTATIVE", declined: "DECLINED" };
const STATUS_OF: Record<string, GuestStatus> = { "NEEDS-ACTION": "needs-action", ACCEPTED: "accepted", TENTATIVE: "tentative", DECLINED: "declined" };

const cn = (name: string) => (name ? `;CN="${name.replace(/["\r\n]/g, "").slice(0, 100)}"` : "");
const organizerLine = (o: Organizer) => `ORGANIZER${cn(o.name)}:mailto:${o.email}`;
const attendeeLine = (g: Guest, rsvp: boolean) =>
	`ATTENDEE${cn(g.name)};CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${PARTSTAT[g.status]}${rsvp ? ";RSVP=TRUE" : ""}:mailto:${g.email}`;

export type InviteMethod = "REQUEST" | "CANCEL" | "REPLY";

type InviteEvent = Pick<CalendarEvent, "id" | "uid" | "sequence" | "title" | "allDay" | "start" | "end" | "timeZone" | "location" | "notes" | "repeat" | "exceptions" | "meetingUrl" | "private"> & { recurrenceId?: string | null };

function timeLines(ev: InviteEvent): { lines: string[]; zones: string[] } {
	const kind = ev.allDay ? ";VALUE=DATE" : "";
	const tz = ev.allDay ? "" : `;TZID=${ev.timeZone}`;
	const lines = [`DTSTART${kind}${tz}:${icsWall(ev.start, ev.allDay)}`, `DTEND${kind}${tz}:${icsWall(ev.end, ev.allDay)}`];
	if (ev.repeat) {
		lines.push(`RRULE:${repeatToRrule(ev.repeat, ev)}`);
		for (const ex of ev.exceptions) lines.push(`EXDATE${kind}${tz}:${icsWall(ex, ev.allDay)}`);
	}
	// One date of a series, changed or cancelled on its own.
	if (ev.recurrenceId) {
		lines.push(/^\d{4}-\d{2}-\d{2}$/.test(ev.recurrenceId) ? `RECURRENCE-ID;VALUE=DATE:${icsWall(ev.recurrenceId, true)}` : `RECURRENCE-ID:${icsUtc(Date.parse(ev.recurrenceId))}`);
	}
	const zones = ev.allDay ? [] : vtimezone(ev.timeZone, zonedToUtc(parseWall(ev.start), ev.timeZone));
	return { lines, zones };
}

/**
 * The invite file for an event: REQUEST to invite guests (or tell them it changed), CANCEL to tell
 * them it's off, or REPLY with our answer to an invite we were sent (`guests` is then just us).
 */
export function inviteIcs(method: InviteMethod, ev: InviteEvent, organizer: Organizer, guests: Guest[], now = Date.now()): string {
	const { lines: times, zones } = timeLines(ev);
	const notes = [ev.notes, ev.meetingUrl && !ev.notes.includes(ev.meetingUrl) ? `${joinWords(ev.meetingUrl)}: ${ev.meetingUrl}` : ""].filter(Boolean).join("\n\n");
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mail App//Mail App//EN", "CALSCALE:GREGORIAN", `METHOD:${method}`, ...zones, "BEGIN:VEVENT",
		`UID:${eventUid(ev)}`, `SEQUENCE:${ev.sequence}`, `DTSTAMP:${icsUtc(now)}`, ...times, `SUMMARY:${icsText(ev.title)}`];
	if (method !== "REPLY") {
		if (ev.location || ev.meetingUrl) lines.push(`LOCATION:${icsText(ev.location || ev.meetingUrl)}`);
		if (notes) lines.push(`DESCRIPTION:${icsText(notes)}`);
		if (ev.meetingUrl) lines.push(`URL:${ev.meetingUrl}`);
		if (ev.private) lines.push("CLASS:PRIVATE");
	}
	lines.push(`STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`, organizerLine(organizer));
	for (const g of guests) lines.push(attendeeLine(g, method === "REQUEST"));
	lines.push("END:VEVENT", "END:VCALENDAR");
	return lines.map(fold).join("\r\n") + "\r\n";
}

/** "Tuesday 14 October 2026, 09:00 to 10:00 (Europe/London)", for the words in an invite email. */
export function whenText(ev: Pick<EventInput, "allDay" | "start" | "end" | "timeZone">): string {
	const s = parseWall(ev.start);
	const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).replace(",", "");
	if (ev.allDay) {
		const last = parseWall(ev.end) - DAY;
		return last > s ? `${day(s)} to ${day(last)}` : `${day(s)}, all day`;
	}
	const e = parseWall(ev.end);
	const sameDay = ev.start.slice(0, 10) === ev.end.slice(0, 10);
	const zone = ev.timeZone.replace(/_/g, " ");
	return sameDay
		? `${day(s)}, ${ev.start.slice(11, 16)} to ${ev.end.slice(11, 16)} (${zone})`
		: `${day(s)} at ${ev.start.slice(11, 16)} to ${day(e)} at ${ev.end.slice(11, 16)} (${zone})`;
}

// ── Reading invites ────────────────────────────────────────────────

interface Prop {
	name: string;
	params: Record<string, string>;
	value: string;
}

/** A date or time as an invite gives it. */
export type IcsTime =
	| { date: true; value: string } // "YYYY-MM-DD"
	| { date: false; wall: string; utc: boolean; tzid: string | null }; // wall "YYYY-MM-DDTHH:mm"

export interface IcsEvent {
	uid: string;
	sequence: number;
	recurrenceId: IcsTime | null;
	title: string;
	notes: string;
	location: string;
	url: string;
	status: string;
	start: IcsTime;
	end: IcsTime | null;
	durationMs: number | null;
	rrule: string | null;
	exdates: IcsTime[];
	organizer: Organizer | null;
	attendees: Guest[];
	/** Links an app gave for the video call (Google's X-GOOGLE-CONFERENCE, Teams' own line...). */
	conference: string;
}

export interface IcsFile {
	method: string;
	events: IcsEvent[];
	/** Fixed offsets (ms ahead of UTC) of time zones the file defined itself, by TZID, for zones we don't know. */
	zoneOffsets: Record<string, number>;
}

function unescapeText(v: string): string {
	return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function parseLine(line: string): Prop | null {
	// NAME;PARAM=value;PARAM="quoted:value":VALUE
	let i = 0;
	let inQuote = false;
	for (; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') inQuote = !inQuote;
		else if (ch === ":" && !inQuote) break;
	}
	if (i >= line.length) return null;
	const head = line.slice(0, i);
	const value = line.slice(i + 1);
	const parts = head.match(/(?:[^;"]+|"[^"]*")+/g) ?? [];
	const name = (parts.shift() ?? "").toUpperCase();
	const params: Record<string, string> = {};
	for (const p of parts) {
		const eq = p.indexOf("=");
		if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
	}
	return { name, params, value };
}

function parseTime(p: Prop): IcsTime | null {
	const v = p.value.trim().split(",")[0];
	const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
	if (!m) return null;
	if (!m[4] || p.params.VALUE === "DATE") return { date: true, value: `${m[1]}-${m[2]}-${m[3]}` };
	return { date: false, wall: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`, utc: !!m[7], tzid: p.params.TZID ?? null };
}

function parseDuration(v: string): number | null {
	const m = v.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
	if (!m) return null;
	const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 * 60 + +(m[4] ?? 0) * 60 + +(m[5] ?? 0)) * MINUTE + +(m[6] ?? 0) * 1000;
	return m[1] === "-" ? -ms : ms;
}

const mailto = (v: string) => v.replace(/^mailto:/i, "").trim().toLowerCase();

/** Reads an .ics file: its METHOD, its events, and any time zones it defined. Never throws. */
export function parseIcs(text: string): IcsFile {
	const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
	const file: IcsFile = { method: "", events: [], zoneOffsets: {} };
	const stack: string[] = [];
	let ev: Partial<IcsEvent> & { attendees: Guest[]; exdates: IcsTime[] } | null = null;
	let tz: { id: string; standard: number | null; any: number | null } | null = null;
	let inStandard = false;
	for (const raw of lines) {
		if (!raw.trim()) continue;
		const p = parseLine(raw);
		if (!p) continue;
		if (p.name === "BEGIN") {
			const what = p.value.trim().toUpperCase();
			stack.push(what);
			if (what === "VEVENT" && stack.length === 2) ev = { attendees: [], exdates: [] };
			if (what === "VTIMEZONE") tz = { id: "", standard: null, any: null };
			if (what === "STANDARD") inStandard = true;
			continue;
		}
		if (p.name === "END") {
			const what = stack.pop();
			if (what === "VEVENT" && ev && stack.length === 1) {
				if (ev.start && ev.uid) {
					file.events.push({
						uid: ev.uid, sequence: ev.sequence ?? 0, recurrenceId: ev.recurrenceId ?? null, title: ev.title ?? "",
						notes: ev.notes ?? "", location: ev.location ?? "", url: ev.url ?? "", status: ev.status ?? "",
						start: ev.start, end: ev.end ?? null, durationMs: ev.durationMs ?? null, rrule: ev.rrule ?? null,
						exdates: ev.exdates, organizer: ev.organizer ?? null, attendees: ev.attendees, conference: ev.conference ?? "",
					});
				}
				ev = null;
			}
			if (what === "VTIMEZONE" && tz) {
				const off = tz.standard ?? tz.any;
				if (tz.id && off !== null) file.zoneOffsets[tz.id] = off;
				tz = null;
			}
			if (what === "STANDARD") inStandard = false;
			continue;
		}
		const where = stack[stack.length - 1];
		if (where === "VCALENDAR" && p.name === "METHOD") file.method = p.value.trim().toUpperCase();
		if (tz && p.name === "TZID" && where === "VTIMEZONE") tz.id = p.value.trim();
		if (tz && p.name === "TZOFFSETTO") {
			const m = p.value.trim().match(/^([+-])(\d{2})(\d{2})/);
			if (m) {
				const off = (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) * MINUTE;
				if (inStandard) tz.standard = off;
				else tz.any ??= off;
			}
		}
		if (!ev || where !== "VEVENT") continue;
		switch (p.name) {
			case "UID": ev.uid = p.value.trim(); break;
			case "SEQUENCE": ev.sequence = Number.parseInt(p.value, 10) || 0; break;
			case "SUMMARY": ev.title = unescapeText(p.value).trim(); break;
			case "DESCRIPTION": ev.notes = unescapeText(p.value).trim(); break;
			case "LOCATION": ev.location = unescapeText(p.value).trim(); break;
			case "URL": ev.url = p.value.trim(); break;
			case "STATUS": ev.status = p.value.trim().toUpperCase(); break;
			case "DTSTART": ev.start = parseTime(p) ?? undefined; break;
			case "DTEND": ev.end = parseTime(p) ?? undefined; break;
			case "DURATION": ev.durationMs = parseDuration(p.value); break;
			case "RRULE": ev.rrule = p.value.trim(); break;
			case "EXDATE": for (const v of p.value.split(",")) { const t = parseTime({ ...p, value: v }); if (t) ev.exdates.push(t); } break;
			case "RECURRENCE-ID": ev.recurrenceId = parseTime(p); break;
			case "ORGANIZER": ev.organizer = { email: mailto(p.value), name: (p.params.CN ?? "").trim() }; break;
			case "ATTENDEE": {
				const email = mailto(p.value);
				if (email.includes("@")) ev.attendees.push({ email, name: (p.params.CN ?? "").trim(), status: STATUS_OF[(p.params.PARTSTAT ?? "").toUpperCase()] ?? "needs-action" });
				break;
			}
			case "X-GOOGLE-CONFERENCE":
			case "X-MICROSOFT-SKYPETEAMSMEETINGURL":
			case "X-MICROSOFT-ONLINEMEETINGCONFLINK":
				ev.conference ||= p.value.trim();
				break;
		}
	}
	return file;
}

/** The real moment an invite's time is, as ms. Floating times (no zone) are read in `fallbackTz`. */
export function icsMoment(t: IcsTime, file: Pick<IcsFile, "zoneOffsets">, fallbackTz: string): number {
	if (t.date) return zonedToUtc(parseWall(t.value), fallbackTz);
	const wall = parseWall(t.wall);
	if (t.utc) return wall;
	const zone = zoneFromTzid(t.tzid);
	if (zone) return zonedToUtc(wall, zone);
	if (t.tzid && file.zoneOffsets[t.tzid] !== undefined) return wall - file.zoneOffsets[t.tzid];
	return zonedToUtc(wall, fallbackTz);
}

const RRULE_FREQ: Record<string, Repeat["freq"]> = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" };

/** An invite's RRULE as our kind of repeat. Rules we can't show exactly are kept as near as we can. */
export function repeatFromRrule(rrule: string): Repeat | null {
	const parts = Object.fromEntries(rrule.split(";").map((kv) => kv.split("=")).filter((kv) => kv.length === 2).map(([k, v]) => [k.toUpperCase(), v.toUpperCase()]));
	const freq = RRULE_FREQ[parts.FREQ];
	if (!freq) return null;
	const repeat: Repeat = { freq, interval: Math.min(99, Math.max(1, Number.parseInt(parts.INTERVAL ?? "1", 10) || 1)) };
	if (freq === "weekly" && parts.BYDAY) {
		const days = parts.BYDAY.split(",").map((d: string) => d.replace(/^[+-]?\d+/, "")).filter((d: string): d is Weekday => (WEEKDAYS as readonly string[]).includes(d));
		if (days.length) repeat.days = WEEKDAYS.filter((d) => days.includes(d));
	}
	if (freq === "monthly") repeat.monthlyBy = /^[+-]?\d+[A-Z]{2}$/.test(parts.BYDAY ?? "") ? "weekday" : "date";
	if (parts.UNTIL) {
		const m = parts.UNTIL.match(/^(\d{4})(\d{2})(\d{2})/);
		if (m) repeat.until = `${m[1]}-${m[2]}-${m[3]}`;
	} else if (parts.COUNT) repeat.count = Math.min(999, Math.max(1, Number.parseInt(parts.COUNT, 10) || 1));
	return repeat;
}

/**
 * An invite's event as one of ours, ready to go in the calendar. Times stay in the invite's own zone
 * when we know it; otherwise they're moved into `tz` (the person's own).
 */
export function eventFromInvite(ev: IcsEvent, file: Pick<IcsFile, "zoneOffsets">, tz: string, calendarId: string): EventInput {
	const allDay = ev.start.date;
	const zone = !ev.start.date && !ev.start.utc ? zoneFromTzid(ev.start.tzid) : null;
	const timeZone = zone ?? tz;
	const wallOf = (t: IcsTime): string => {
		if (t.date) return t.value;
		if (zone && !t.utc && zoneFromTzid(t.tzid) === zone) return t.wall;
		return formatWall(utcToZoned(icsMoment(t, file, tz), timeZone));
	};
	const start = wallOf(ev.start);
	let end: string;
	if (ev.end && ev.end.date === allDay) end = wallOf(ev.end);
	else if (ev.durationMs !== null) end = formatWall(parseWall(start) + Math.max(0, ev.durationMs), allDay);
	else end = allDay ? formatWall(parseWall(start) + DAY, true) : start;
	if (parseWall(end) < parseWall(start) || (allDay && parseWall(end) <= parseWall(start))) end = allDay ? formatWall(parseWall(start) + DAY, true) : start;
	const meetingUrl = findMeetingLink(ev.conference, ev.url, ev.location, ev.notes) || (/^https?:\/\//i.test(ev.url) ? ev.url : "");
	return {
		calendarId,
		title: ev.title.slice(0, 200) || "(No title)",
		allDay,
		start,
		end,
		timeZone,
		location: ev.location.slice(0, 300),
		notes: ev.notes.slice(0, 10_000),
		color: null,
		private: false,
		repeat: ev.rrule && !ev.recurrenceId ? repeatFromRrule(ev.rrule) : null,
		reminders: allDay ? [] : [10],
		guests: cleanGuests(ev.attendees),
		meetingUrl,
	};
}

/** Which date of a series an invite is about, when it's just one (see CalendarEvent.recurrenceId). */
export function recurrenceIdFromInvite(ev: IcsEvent, file: Pick<IcsFile, "zoneOffsets">, tz: string): string | null {
	const t = ev.recurrenceId;
	if (!t) return null;
	return t.date ? t.value : new Date(icsMoment(t, file, tz)).toISOString();
}

/** Exceptions (removed repeats) from an invite's EXDATEs, as wall-clock times in the event's zone. */
export function exceptionsFromInvite(ev: IcsEvent, file: Pick<IcsFile, "zoneOffsets">, input: Pick<EventInput, "allDay" | "timeZone">): string[] {
	return ev.exdates.map((t) => (t.date ? t.value : formatWall(utcToZoned(icsMoment(t, file, input.timeZone), input.timeZone)))).filter((w) => w.length === (input.allDay ? 10 : 16));
}

/** Words for a guest's answer: "Accepted", "Maybe", "Declined", "Not answered yet". */
export const STATUS_WORDS: Record<GuestStatus, string> = { accepted: "Accepted", tentative: "Maybe", declined: "Declined", "needs-action": "Not answered yet" };

/** Subject lines for the emails that carry invites and answers. */
export function inviteSubject(method: InviteMethod, ev: Pick<EventInput, "title" | "allDay" | "start" | "end" | "timeZone">, opts: { update?: boolean; answer?: GuestStatus } = {}): string {
	const s = parseWall(ev.start);
	const when = new Date(s).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).replace(",", "") + (ev.allDay ? "" : ` ${ev.start.slice(11, 16)}`);
	if (method === "CANCEL") return `Cancelled: ${ev.title} @ ${when}`;
	if (method === "REPLY") return `${STATUS_WORDS[opts.answer ?? "accepted"] === "Maybe" ? "Tentative" : STATUS_WORDS[opts.answer ?? "accepted"]}: ${ev.title} @ ${when}`;
	return `${opts.update ? "Updated invitation" : "Invitation"}: ${ev.title} @ ${when}`;
}

// ── The email an invite travels in ─────────────────────────────────

const utf8Base64 = (text: string): string => {
	const bytes = new TextEncoder().encode(text);
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin).replace(/.{76}(?=.)/g, "$&\r\n");
};
const plain = (s: string) => /^[\x20-\x7e]*$/.test(s);
/** A header word: as it is when plain, else UTF-8 encoded so any name or title survives. */
const headerWord = (s: string) => (plain(s) ? s : `=?UTF-8?B?${utf8Base64(s).replace(/\r\n/g, "")}?=`);
const mailbox = (who: { email: string; name?: string }) => {
	const name = (who.name ?? "").replace(/[\r\n"\\]/g, "").trim();
	if (!name || name === who.email) return who.email;
	return `${plain(name) ? `"${name}"` : headerWord(name)} <${who.email}>`;
};

/**
 * A whole invite email (RFC 5322), laid out the way Outlook and Gmail send theirs: the words, then the
 * invite itself as a calendar part alongside them (which is what makes Apple Mail, iCloud, Outlook and
 * Gmail show Yes / Maybe / No), plus the same invite as an invite.ics file for anything else.
 */
export function inviteMime(opts: {
	from: { email: string; name?: string };
	to: { email: string; name?: string };
	subject: string;
	text: string;
	html: string;
	ics: string;
	method: InviteMethod;
	now?: Date;
	id?: string;
}): string {
	const id = opts.id ?? crypto.randomUUID();
	const mixed = `app-mixed-${id}`;
	const alt = `app-alt-${id}`;
	const domain = opts.from.email.split("@")[1] || "mail-app.local";
	const part = (type: string, body: string, extra: string[] = []) =>
		[`Content-Type: ${type}`, "Content-Transfer-Encoding: base64", ...extra, "", utf8Base64(body)].join("\r\n");
	return [
		`From: ${mailbox(opts.from)}`,
		`To: ${mailbox(opts.to)}`,
		`Subject: ${headerWord(opts.subject)}`,
		`Date: ${(opts.now ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
		`Message-ID: <${id}@${domain}>`,
		"MIME-Version: 1.0",
		"Auto-Submitted: auto-generated",
		`Content-Type: multipart/mixed; boundary="${mixed}"`,
		"",
		`--${mixed}`,
		`Content-Type: multipart/alternative; boundary="${alt}"`,
		"",
		`--${alt}`,
		part('text/plain; charset="UTF-8"', opts.text),
		`--${alt}`,
		part('text/html; charset="UTF-8"', opts.html),
		`--${alt}`,
		part(`text/calendar; charset="UTF-8"; method=${opts.method}`, opts.ics),
		`--${alt}--`,
		`--${mixed}`,
		part(`application/ics; name="invite.ics"`, opts.ics, ['Content-Disposition: attachment; filename="invite.ics"']),
		`--${mixed}--`,
		"",
	].join("\r\n");
}
