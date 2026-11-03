// Mail App, 2026: the mailbox's calendars, kept in its own database next to its mail. Everyone who
// can open the mailbox shares them; a private event shows as "Busy" to everyone but the person who
// made it. Reminders go out as notifications from the Durable Object's alarm (see MailboxDO.alarm).

import {
	countBefore, eventUid, formatWall, occurrencesOf, parseWall, recurrenceIdOf, recurrenceWall, reminderMoment, spanOf, toIcs, utcToZoned,
	type Calendar, type CalendarColor, type CalendarEvent, type EditScope, type EventInput, type Guest, type GuestStatus, type Occurrence, type Organizer, MAX_CALENDARS,
} from "../../shared/calendar";
import type { ShareLevel } from "../../shared/calendar-shares";
import { notifyDevices } from "../lib/push";
import type { Env } from "../types";

export interface Viewer {
	email: string;
	name: string;
}

/** Reminders more than this late (the Worker was asleep, say) are dropped rather than sent. */
const STALE_MS = 60 * 60_000;
/** How far ahead to look for the next reminder; past this, the alarm just checks again. */
const LOOK_AHEAD_MS = 35 * 86_400_000;
const DAY = 86_400_000;

type Row = Record<string, SqlStorageValue>;

function toEvent(row: Row): CalendarEvent {
	const json = <T>(v: SqlStorageValue, fallback: T): T => {
		try { return v ? (JSON.parse(String(v)) as T) : fallback; } catch { return fallback; }
	};
	return {
		id: String(row.id),
		calendarId: String(row.calendar_id),
		title: String(row.title),
		allDay: !!row.all_day,
		start: String(row.start),
		end: String(row.end),
		timeZone: String(row.time_zone),
		location: String(row.location ?? ""),
		notes: String(row.notes ?? ""),
		color: (row.color ? String(row.color) : null) as CalendarColor | null,
		private: !!row.private,
		repeat: json(row.repeat, null),
		exceptions: json(row.exceptions, [] as string[]),
		reminders: json(row.reminders, [] as number[]),
		createdBy: row.created_by ? String(row.created_by) : null,
		createdByName: row.created_by_name ? String(row.created_by_name) : null,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		uid: row.uid ? String(row.uid) : null,
		organizer: json(row.organizer, null as Organizer | null),
		guests: json(row.guests, [] as Guest[]),
		sequence: Number(row.sequence ?? 0) || 0,
		meetingUrl: String(row.meeting_url ?? ""),
		recurrenceId: row.recurrence_id ? String(row.recurrence_id) : null,
	};
}

/** What someone else sees of a private event: just that the time is taken. */
const busyOnly = { title: "Busy", location: "", notes: "", reminders: [] as number[], guests: [] as Guest[], meetingUrl: "" };

/** Changes guests would want to hear about (not colours, reminders or which calendar it's in). */
function guestsCare(a: EventInput, b: EventInput): boolean {
	const pick = (e: EventInput) => JSON.stringify([e.title, e.allDay, e.start, e.end, e.timeZone, e.location, e.notes, e.repeat, e.meetingUrl]);
	return pick(a) !== pick(b);
}

/** One date of a series as an event of its own (before anything about it was changed). */
function instanceOf(ev: CalendarEvent, occurrence: string): CalendarEvent {
	const length = parseWall(ev.end) - parseWall(ev.start);
	return { ...ev, start: occurrence, end: formatWall(parseWall(occurrence) + length, ev.allDay), repeat: null, exceptions: [] };
}

export class Calendars {
	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
	) {}

	private get sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	// ── Calendars ──────────────────────────────────────────────────

	/** The mailbox's calendars. A mailbox always has at least one, made the first time it's needed. */
	list(): Calendar[] {
		const rows = [...this.sql.exec(`SELECT id, name, color, source_url, refreshed_at, refresh_error FROM calendars ORDER BY position, created_at`)];
		if (!rows.some((r) => !r.source_url)) {
			// Always one calendar of its own (calendars from other websites are read only).
			const first = { id: crypto.randomUUID(), name: "Calendar", color: "blue" as CalendarColor };
			this.sql.exec(`INSERT INTO calendars (id, name, color, position, created_at) VALUES (?1, ?2, ?3, -1, ?4)`, first.id, first.name, first.color, new Date().toISOString());
			return this.list();
		}
		return rows.map((r) => r.source_url
			? { id: String(r.id), name: String(r.name), color: String(r.color) as CalendarColor, sourceUrl: String(r.source_url), refreshedAt: r.refreshed_at ? String(r.refreshed_at) : null, refreshError: r.refresh_error ? String(r.refresh_error) : null }
			: { id: String(r.id), name: String(r.name), color: String(r.color) as CalendarColor });
	}

	/** Calendars from other websites, which can't be changed here. */
	private outsideIds(): Set<string> {
		return new Set([...this.sql.exec(`SELECT id FROM calendars WHERE source_url IS NOT NULL`)].map((r) => String(r.id)));
	}

	createCalendar(name: string, color: CalendarColor, source?: { url: string; tz: string }): Calendar | "full" {
		if (this.list().length >= MAX_CALENDARS) return "full";
		const cal = { id: crypto.randomUUID(), name, color };
		this.sql.exec(
			`INSERT INTO calendars (id, name, color, position, created_at, source_url, source_tz) VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(position), -1) + 1 FROM calendars), ?4, ?5, ?6)`,
			cal.id, name, color, new Date().toISOString(), source?.url ?? null, source?.tz ?? null,
		);
		return source ? { ...cal, sourceUrl: source.url, refreshedAt: null, refreshError: null } : cal;
	}

	/**
	 * Adds the events from an imported .ics file to one of the mailbox's own calendars. Events already
	 * there from an earlier import of the same file (same id) are left as they are, so importing twice
	 * doesn't double up.
	 */
	async importEvents(calendarId: string, items: { input: EventInput; uid: string; exceptions: string[]; recurrenceId: string | null }[], viewer: Viewer): Promise<{ added: number; skipped: number } | null> {
		const cal = this.list().find((c) => c.id === calendarId && !c.sourceUrl);
		if (!cal) return null;
		const have = new Set([...this.sql.exec(`SELECT uid, recurrence_id FROM calendar_events WHERE calendar_id = ?1 AND uid IS NOT NULL`, cal.id)].map((r) => `${r.uid}|${r.recurrence_id ?? ""}`));
		const now = new Date().toISOString();
		let added = 0;
		let skipped = 0;
		this.ctx.storage.transactionSync(() => {
			for (const e of items) {
				const key = `${e.uid}|${e.recurrenceId ?? ""}`;
				if (have.has(key)) { skipped++; continue; }
				have.add(key);
				this.write({
					...e.input, calendarId: cal.id, guests: [],
					id: crypto.randomUUID(), exceptions: e.exceptions, createdBy: viewer.email || null, createdByName: viewer.name || null, createdAt: now, updatedAt: now,
					uid: e.uid, organizer: null, sequence: 0, recurrenceId: e.recurrenceId,
				});
				added++;
			}
		});
		await this.refreshNextReminder();
		return { added, skipped };
	}

	/** Where a calendar from another website comes from, to bring it up to date. */
	outsideSource(id: string): { url: string; tz: string; refreshedAt: string | null } | null {
		const row = [...this.sql.exec(`SELECT source_url, source_tz, refreshed_at FROM calendars WHERE id = ?1 AND source_url IS NOT NULL`, id)][0];
		return row ? { url: String(row.source_url), tz: String(row.source_tz || "Europe/London"), refreshedAt: row.refreshed_at ? String(row.refreshed_at) : null } : null;
	}

	/** Puts a fresh copy of a calendar from another website in place of the old one (or notes why it couldn't). */
	replaceOutside(id: string, result: { events: { input: EventInput; uid: string; exceptions: string[]; recurrenceId: string | null }[] } | { error: string }): void {
		if (!this.outsideSource(id)) return;
		const now = new Date().toISOString();
		if ("error" in result) {
			this.sql.exec(`UPDATE calendars SET refreshed_at = ?2, refresh_error = ?3 WHERE id = ?1`, id, now, result.error);
			return;
		}
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(`DELETE FROM calendar_events WHERE calendar_id = ?1`, id);
			for (const e of result.events) {
				this.write({
					...e.input, calendarId: id, reminders: [], guests: [],
					id: crypto.randomUUID(), exceptions: e.exceptions, createdBy: null, createdByName: null, createdAt: now, updatedAt: now,
					uid: e.uid, organizer: null, sequence: 0, recurrenceId: e.recurrenceId,
				});
			}
			this.sql.exec(`UPDATE calendars SET refreshed_at = ?2, refresh_error = NULL WHERE id = ?1`, id, now);
		});
	}

	updateCalendar(id: string, changes: { name?: string; color?: CalendarColor }): Calendar | null {
		const cal = this.list().find((c) => c.id === id);
		if (!cal) return null;
		const next = { ...cal, ...changes };
		this.sql.exec(`UPDATE calendars SET name = ?2, color = ?3 WHERE id = ?1`, id, next.name, next.color);
		return next;
	}

	// ── Events ─────────────────────────────────────────────────────

	get(id: string): CalendarEvent | null {
		const row = [...this.sql.exec(`SELECT * FROM calendar_events WHERE id = ?1`, id)][0];
		return row ? toEvent(row) : null;
	}

	private canEdit(ev: CalendarEvent, viewer: Viewer): boolean {
		return !ev.private || !ev.createdBy || ev.createdBy === viewer.email;
	}

	/** Is this calendar from another website (so nothing in it can change here)? */
	isOutside(calendarId: string): boolean {
		return [...this.sql.exec(`SELECT 1 FROM calendars WHERE id = ?1 AND source_url IS NOT NULL`, calendarId)].length > 0;
	}

	/**
	 * Everything that happens between two moments, as this person may see it. With `shared`, just one
	 * calendar, for someone it's shared with: "busy" shows only the times, "view" every event but
	 * nothing can change, "edit" lets them change events, apart from ones with guests (only the
	 * calendar's own people can email guests).
	 */
	occurrences(fromMs: number, toMs: number, viewer: Viewer, shared?: { calendarId: string; level: ShareLevel }): Occurrence[] {
		const rows = shared
			? this.sql.exec(
				`SELECT * FROM calendar_events WHERE calendar_id = ?3 AND first_start_ms < ?2 AND (last_end_ms IS NULL OR last_end_ms >= ?1)`,
				fromMs, toMs, shared.calendarId,
			)
			: this.sql.exec(
				`SELECT * FROM calendar_events WHERE first_start_ms < ?2 AND (last_end_ms IS NULL OR last_end_ms >= ?1)`,
				fromMs, toMs,
			);
		const out: Occurrence[] = [];
		const outside = this.outsideIds();
		for (const row of rows) {
			const ev = toEvent(row);
			const visible = this.canEdit(ev, viewer) && shared?.level !== "busy";
			const editable = visible && !outside.has(ev.calendarId) && (!shared || (shared.level === "edit" && !this.linked(ev)));
			// Someone else's private event (or a calendar shared as busy times only): just the time, as "Busy".
			const shown: EventInput = visible ? (shared ? { ...ev, reminders: [] } : ev) : { ...ev, ...busyOnly, color: "grey" };
			for (const o of occurrencesOf(ev, fromMs, toMs)) {
				out.push({
					...shown,
					id: o.occurrence ? `${ev.id}|${o.occurrence}` : ev.id,
					eventId: ev.id,
					occurrence: o.occurrence,
					// The start and end of this time it happens (the series keeps its first ones).
					start: formatWall(o.wallStart, ev.allDay),
					end: formatWall(o.wallEnd, ev.allDay),
					startAt: ev.allDay ? formatWall(o.wallStart, true) : new Date(o.start).toISOString(),
					endAt: ev.allDay ? formatWall(o.wallEnd, true) : new Date(o.end).toISOString(),
					canEdit: editable,
					busy: !visible,
					createdByName: visible || !shared ? ev.createdByName : null,
					organizer: visible ? ev.organizer : null,
				});
			}
		}
		return out.sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
	}

	private write(ev: CalendarEvent): void {
		const span = spanOf(ev);
		this.sql.exec(
			`INSERT OR REPLACE INTO calendar_events
			 (id, calendar_id, title, all_day, start, end, time_zone, location, notes, color, private, repeat, exceptions, reminders,
			  created_by, created_by_name, created_at, updated_at, first_start_ms, last_end_ms, uid, organizer, guests, sequence, meeting_url, recurrence_id)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)`,
			ev.id, ev.calendarId, ev.title, ev.allDay ? 1 : 0, ev.start, ev.end, ev.timeZone, ev.location, ev.notes, ev.color,
			ev.private ? 1 : 0, ev.repeat ? JSON.stringify(ev.repeat) : null, JSON.stringify(ev.exceptions), JSON.stringify(ev.reminders),
			ev.createdBy, ev.createdByName, ev.createdAt, ev.updatedAt, span.first, span.last,
			ev.uid, ev.organizer ? JSON.stringify(ev.organizer) : null, JSON.stringify(ev.guests ?? []), ev.sequence ?? 0, ev.meetingUrl ?? "", ev.recurrenceId ?? null,
		);
	}

	private knownCalendar(id: string): string {
		const all = this.list().filter((c) => !c.sourceUrl);
		return all.find((c) => c.id === id)?.id ?? all[0].id;
	}

	async createEvent(input: EventInput, viewer: Viewer): Promise<CalendarEvent> {
		const now = new Date().toISOString();
		const ev: CalendarEvent = {
			...input,
			calendarId: this.knownCalendar(input.calendarId),
			id: crypto.randomUUID(),
			exceptions: [],
			createdBy: viewer.email || null,
			createdByName: viewer.name || null,
			createdAt: now,
			updatedAt: now,
			uid: null,
			organizer: null,
			sequence: 0,
			recurrenceId: null,
		};
		this.write(ev);
		await this.refreshNextReminder();
		return ev;
	}

	/**
	 * Changes an event. For a repeating one, `scope` says which: just the one at `occurrence`, that
	 * one and the ones after it, or all of them. `input` holds the times of the one being changed.
	 */
	async changeEvent(id: string, input: EventInput, scope: EditScope, occurrence: string | null, viewer: Viewer): Promise<CalendarEvent | "missing" | "private" | "outside"> {
		const ev = this.get(id);
		if (!ev) return "missing";
		if (!this.canEdit(ev, viewer)) return "private";
		if (this.isOutside(ev.calendarId)) return "outside";
		input = { ...input, calendarId: this.knownCalendar(input.calendarId) };
		// A series with guests changes one date or all of them (as in Outlook), never splits in two.
		const linked = this.linked(ev);
		if (linked && scope === "following") scope = "all";
		const now = new Date().toISOString();
		// Guests' calendars take the change with the higher sequence number.
		const sequence = !ev.organizer && (ev.guests.length || input.guests.length) && guestsCare(ev, input) ? ev.sequence + 1 : ev.sequence;
		const keep = { id: ev.id, exceptions: ev.exceptions, createdBy: ev.createdBy, createdByName: ev.createdByName, createdAt: ev.createdAt, updatedAt: now, uid: ev.uid, organizer: ev.organizer, sequence, recurrenceId: ev.recurrenceId };
		const isFirst = !occurrence || occurrence === ev.start;

		if (!ev.repeat || !occurrence || scope === "all" || (scope === "following" && isFirst)) {
			let updated: CalendarEvent = { ...input, ...keep };
			if (ev.repeat && occurrence && input.repeat) {
				// Moving one of the repeats moves the whole series by the same amount.
				const shift = parseWall(input.start) - parseWall(occurrence);
				const length = parseWall(input.end) - parseWall(input.start);
				const start = parseWall(ev.start) + shift;
				updated = {
					...updated,
					start: formatWall(start, input.allDay),
					end: formatWall(start + length, input.allDay),
					exceptions: shift === 0 || input.allDay !== ev.allDay ? ev.exceptions : ev.exceptions.map((x) => formatWall(parseWall(x) + shift, input.allDay)),
				};
				// A weekly repeat on one day follows the event to its new day.
				if (shift !== 0 && input.repeat.freq === "weekly" && (input.repeat.days?.length ?? 0) <= 1) delete updated.repeat!.days;
			}
			if (!input.repeat) updated.exceptions = [];
			this.write(updated);
			await this.refreshNextReminder();
			return updated;
		}

		let made: CalendarEvent = { ...input, id: crypto.randomUUID(), exceptions: [], createdBy: viewer.email || null, createdByName: viewer.name || null, createdAt: now, updatedAt: now, uid: null, organizer: ev.organizer, sequence: 0, recurrenceId: null };
		this.ctx.storage.transactionSync(() => {
			if (scope === "one") {
				// The changed one becomes an event of its own, and the series skips that day.
				this.write({ ...ev, exceptions: [...new Set([...ev.exceptions, occurrence])], updatedAt: now });
				made = { ...made, repeat: null };
				if (linked) {
					// It stays part of the series in guests' calendars: same uid, and which date it was.
					const was = instanceOf(ev, occurrence);
					made = {
						...made, uid: eventUid(ev), recurrenceId: recurrenceIdOf(ev, occurrence), createdBy: ev.createdBy, createdByName: ev.createdByName,
						sequence: !ev.organizer && guestsCare(was, input) ? ev.sequence + 1 : ev.sequence,
					};
				}
				this.write(made);
			} else {
				// "This and following": the old series stops before this one, and a new series starts here.
				const before = this.endSeriesBefore(ev, occurrence);
				this.write({ ...before, updatedAt: now });
				const shift = parseWall(input.start) - parseWall(occurrence);
				const later = ev.exceptions.filter((x) => x > occurrence).map((x) => formatWall(parseWall(x) + shift, input.allDay));
				const repeat = input.repeat && ev.repeat?.count && input.repeat.count === ev.repeat.count
					? { ...input.repeat, count: Math.max(1, ev.repeat.count - countBefore(parseWall(ev.start), ev.repeat, parseWall(occurrence))) }
					: input.repeat;
				made = { ...made, repeat, exceptions: repeat ? later : [] };
				this.write(made);
			}
		});
		await this.refreshNextReminder();
		return made;
	}

	/** The series, cut short so its last time is the one before `occurrence`. */
	private endSeriesBefore(ev: CalendarEvent, occurrence: string): CalendarEvent {
		const repeat = { ...ev.repeat! };
		if (repeat.count) repeat.count = countBefore(parseWall(ev.start), repeat, parseWall(occurrence));
		else repeat.until = formatWall(parseWall(occurrence.slice(0, 10)) - DAY, true);
		return { ...ev, repeat, exceptions: ev.exceptions.filter((x) => x < occurrence) };
	}

	async removeEvent(id: string, scope: EditScope, occurrence: string | null, viewer: Viewer): Promise<"missing" | "private" | "outside" | true> {
		const ev = this.get(id);
		if (!ev) return "missing";
		if (!this.canEdit(ev, viewer)) return "private";
		if (this.isOutside(ev.calendarId)) return "outside";
		const now = new Date().toISOString();
		if (this.linked(ev) && scope === "following") scope = "all";
		if (!ev.repeat || !occurrence || scope === "all" || (scope === "following" && occurrence === ev.start)) {
			this.sql.exec(`DELETE FROM calendar_events WHERE id = ?1`, id);
			// Dates of the series that were changed on their own go with it.
			if (ev.repeat && !ev.recurrenceId && this.linked(ev)) this.sql.exec(`DELETE FROM calendar_events WHERE uid = ?1 AND recurrence_id IS NOT NULL`, eventUid(ev));
		} else if (scope === "one") {
			this.write({ ...ev, exceptions: [...new Set([...ev.exceptions, occurrence])], updatedAt: now });
		} else {
			this.write({ ...this.endSeriesBefore(ev, occurrence), updatedAt: now });
		}
		await this.refreshNextReminder();
		return true;
	}

	/** Deletes a calendar and its events. The last calendar can't go. */
	async removeCalendar(id: string): Promise<"last" | boolean> {
		const all = this.list();
		const cal = all.find((c) => c.id === id);
		if (!cal) return false;
		// The last calendar of its own can't go (one from another website always can).
		if (!cal.sourceUrl && all.filter((c) => !c.sourceUrl).length === 1) return "last";
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(`DELETE FROM calendar_events WHERE calendar_id = ?1`, id);
			this.sql.exec(`DELETE FROM calendars WHERE id = ?1`, id);
		});
		await this.refreshNextReminder();
		return true;
	}

	/** One calendar, or all of them, as an .ics file. */
	exportIcs(calendarId: string | null, viewer: Viewer): { name: string; ics: string } {
		const cals = this.list();
		const cal = calendarId ? cals.find((c) => c.id === calendarId) : null;
		const rows = cal
			? this.sql.exec(`SELECT * FROM calendar_events WHERE calendar_id = ?1`, cal.id)
			: this.sql.exec(`SELECT * FROM calendar_events`);
		const events = [...rows].map(toEvent).map((ev) => (this.canEdit(ev, viewer) ? ev : { ...ev, ...busyOnly }));
		const name = cal?.name ?? "Mail App calendar";
		return { name, ics: toIcs(name, events) };
	}

	/**
	 * One calendar for its subscribe link (Apple Calendar, Outlook, Google Calendar). Private events,
	 * or every event with "busy", show only as Busy; reminders stay out, as they're each app's own.
	 */
	feedIcs(calendarId: string, level: "all" | "busy"): { name: string; ics: string } | null {
		const cal = this.list().find((c) => c.id === calendarId);
		if (!cal) return null;
		const events = [...this.sql.exec(`SELECT * FROM calendar_events WHERE calendar_id = ?1`, cal.id)].map(toEvent).map((ev) =>
			level === "busy" || ev.private ? { ...ev, ...busyOnly, private: false } : { ...ev, reminders: [] });
		return { name: cal.name, ics: toIcs(cal.name, events) };
	}

	// ── Invites ────────────────────────────────────────────────────

	/** Is this event in guests' calendars too (ours with guests, or one we were invited to)? */
	private linked(ev: CalendarEvent): boolean {
		return !!ev.organizer || ev.guests.length > 0 || !!ev.recurrenceId;
	}

	/**
	 * The event an invite is about: one we were invited to (by its uid), or one of ours ("<id>@mail-app.local").
	 * With `recurrenceId`, the one date of that series that was changed on its own.
	 */
	byUid(uid: string, recurrenceId: string | null = null): CalendarEvent | null {
		if (recurrenceId) {
			const row = [...this.sql.exec(`SELECT * FROM calendar_events WHERE uid = ?1 AND recurrence_id = ?2 LIMIT 1`, uid, recurrenceId)][0];
			return row ? toEvent(row) : null;
		}
		const row = [...this.sql.exec(`SELECT * FROM calendar_events WHERE uid = ?1 AND recurrence_id IS NULL LIMIT 1`, uid)][0];
		if (row) return toEvent(row);
		const ours = uid.match(/^([0-9a-f-]{36})@mail-app\.local$/i)?.[1];
		const ev = ours ? this.get(ours) : null;
		return ev && !ev.uid ? ev : null;
	}

	/** The dates of a series that were changed on their own (their recurrence ids). */
	changedDates(uid: string): string[] {
		return [...this.sql.exec(`SELECT recurrence_id FROM calendar_events WHERE uid = ?1 AND recurrence_id IS NOT NULL`, uid)].map((r) => String(r.recurrence_id));
	}

	/**
	 * Puts an invite we were sent into the calendar, or brings the copy we have up to date. Changes the
	 * person made themselves (calendar, colour, reminders, private) are kept. Older invites are ignored.
	 * With `recurrenceId` it's one date of a series, changed on its own: the series skips that date.
	 */
	async saveInvite(input: EventInput, invite: { uid: string; organizer: Organizer | null; sequence: number; exceptions: string[]; recurrenceId?: string | null }, viewer: Viewer): Promise<CalendarEvent> {
		const rid = invite.recurrenceId ?? null;
		const had = this.byUid(invite.uid, rid);
		const series = rid ? this.byUid(invite.uid) : null;
		const now = new Date().toISOString();
		if (had && had.sequence > invite.sequence) return had;
		const own = had ?? series;
		const exceptions = rid ? [] : [...new Set([...invite.exceptions, ...(had ? this.changedDates(invite.uid).map((r) => recurrenceWall(input, r)) : [])])];
		const ev: CalendarEvent = {
			...input,
			...(rid ? { repeat: null } : {}),
			calendarId: own ? own.calendarId : this.knownCalendar(input.calendarId),
			...(own ? { color: own.color, reminders: own.reminders, private: own.private } : {}),
			id: had?.id ?? crypto.randomUUID(),
			exceptions,
			createdBy: had?.createdBy ?? (viewer.email || null), createdByName: had?.createdByName ?? (viewer.name || null),
			createdAt: had?.createdAt ?? now, updatedAt: now,
			uid: invite.uid, organizer: invite.organizer ?? had?.organizer ?? null, sequence: invite.sequence, recurrenceId: rid,
		};
		this.ctx.storage.transactionSync(() => {
			this.write(ev);
			if (series && series.organizer) {
				const skip = recurrenceWall(series, rid!);
				if (!series.exceptions.includes(skip)) this.write({ ...series, exceptions: [...series.exceptions, skip], updatedAt: now });
			}
		});
		await this.refreshNextReminder();
		return ev;
	}

	/** A guest answered one of our invites: note their answer on the event. Returns the event, or null if we don't have it. */
	setGuestStatus(uid: string, email: string, status: GuestStatus, name = "", recurrenceId: string | null = null): CalendarEvent | null {
		const ev = this.byUid(uid, recurrenceId);
		if (!ev || ev.organizer) return null;
		const who = email.toLowerCase();
		const known = ev.guests.some((g) => g.email === who);
		const guests = known ? ev.guests.map((g) => (g.email === who ? { ...g, status, name: g.name || name } : g)) : [...ev.guests, { email: who, name, status }];
		const updated = { ...ev, guests, updatedAt: new Date().toISOString() };
		this.write(updated);
		return updated;
	}

	/**
	 * Takes an event we were invited to out of the calendar (it was cancelled, or we said no). With
	 * `recurrenceId`, just that one date of the series.
	 */
	async removeInvite(uid: string, recurrenceId: string | null = null): Promise<boolean> {
		const series = this.byUid(uid);
		let done = false;
		this.ctx.storage.transactionSync(() => {
			if (recurrenceId) {
				const one = this.byUid(uid, recurrenceId);
				if (one?.organizer) { this.sql.exec(`DELETE FROM calendar_events WHERE id = ?1`, one.id); done = true; }
				if (series?.organizer && series.repeat) {
					const skip = recurrenceWall(series, recurrenceId);
					if (!series.exceptions.includes(skip)) this.write({ ...series, exceptions: [...series.exceptions, skip], updatedAt: new Date().toISOString() });
					done = true;
				}
			} else if (series?.organizer) {
				this.sql.exec(`DELETE FROM calendar_events WHERE id = ?1 OR (uid = ?2 AND recurrence_id IS NOT NULL)`, series.id, uid);
				done = true;
			}
		});
		if (done) await this.refreshNextReminder();
		return done;
	}

	// ── Reminders ──────────────────────────────────────────────────

	/** Reminders due between two moments, soonest first. */
	private remindersBetween(fromMs: number, toMs: number, viewer: Viewer | null): { at: number; ev: CalendarEvent; start: number; minutes: number; occurrence: string | null }[] {
		const due: { at: number; ev: CalendarEvent; start: number; minutes: number; occurrence: string | null }[] = [];
		for (const row of this.sql.exec(`SELECT * FROM calendar_events WHERE reminders <> '[]' AND (last_end_ms IS NULL OR last_end_ms >= ?1)`, fromMs)) {
			const ev = toEvent(row);
			if (viewer && !this.canEdit(ev, viewer)) continue;
			const longest = Math.max(...ev.reminders) * 60_000;
			for (const o of occurrencesOf(ev, fromMs - DAY, toMs + longest + DAY, 500)) {
				for (const minutes of ev.reminders) {
					const at = reminderMoment(ev, o.wallStart, o.start, minutes);
					if (at > fromMs && at <= toMs) due.push({ at, ev, start: o.start, minutes, occurrence: o.occurrence });
				}
			}
		}
		return due.sort((a, b) => a.at - b.at);
	}

	/** Reminders coming up for this person, so the open app can show them too. */
	upcoming(fromMs: number, toMs: number, viewer: Viewer) {
		return this.remindersBetween(fromMs, toMs, viewer).map((r) => ({
			at: new Date(r.at).toISOString(),
			eventId: r.ev.id,
			occurrence: r.occurrence,
			title: r.ev.title,
			startAt: r.ev.allDay ? formatWall(utcToZoned(r.start, r.ev.timeZone), true) : new Date(r.start).toISOString(),
			allDay: r.ev.allDay,
			location: r.ev.location,
			minutes: r.minutes,
		}));
	}

	private state(): { checked: number | null; next: number | null } {
		const row = [...this.sql.exec(`SELECT reminders_checked_at, next_reminder_at FROM calendar_state WHERE id = 1`)][0];
		return { checked: row?.reminders_checked_at == null ? null : Number(row.reminders_checked_at), next: row?.next_reminder_at == null ? null : Number(row.next_reminder_at) };
	}

	/** When the alarm next needs to wake for a reminder, or null. */
	nextDue(): number | null {
		return this.state().next;
	}

	/** Works out the next reminder after something changed, and books the alarm for it. */
	async refreshNextReminder(now = Date.now()): Promise<void> {
		const checked = this.state().checked ?? now;
		const next = this.remindersBetween(Math.max(checked, now - STALE_MS), now + LOOK_AHEAD_MS, null)[0]?.at;
		const anyReminders = [...this.sql.exec(`SELECT 1 FROM calendar_events WHERE reminders <> '[]' LIMIT 1`)].length > 0;
		const at = next ?? (anyReminders ? now + LOOK_AHEAD_MS - DAY : null);
		this.sql.exec(
			`INSERT INTO calendar_state (id, reminders_checked_at, next_reminder_at) VALUES (1, ?1, ?2)
			 ON CONFLICT(id) DO UPDATE SET reminders_checked_at = COALESCE(reminders_checked_at, ?1), next_reminder_at = ?2`,
			checked, at,
		);
		if (at !== null) {
			const current = await this.ctx.storage.getAlarm();
			if (current === null || at < current) await this.ctx.storage.setAlarm(at);
		}
	}

	/** From the alarm: sends the reminders that are due to every device with notifications on. */
	async onAlarm(mailboxId: string | null, now = Date.now()): Promise<void> {
		const { checked, next } = this.state();
		if (next === null || now < next) return;
		const from = Math.max(checked ?? now - 60_000, now - STALE_MS);
		const due = this.remindersBetween(from, now, null);
		this.sql.exec(`UPDATE calendar_state SET reminders_checked_at = ?1 WHERE id = 1`, now);
		if (mailboxId) {
			for (const r of due) {
				await notifyDevices(this.env, mailboxId, {
					title: r.ev.private ? "Private event" : r.ev.title,
					body: reminderBody(r.ev, r.start, r.minutes),
					url: `/mailbox/${encodeURIComponent(mailboxId)}/calendar?date=${formatWall(utcToZoned(r.start, r.ev.timeZone), true)}`,
				}).catch((e) => console.error("Reminder failed:", (e as Error).message));
			}
		}
		await this.refreshNextReminder(now);
	}
}

/** "Today at 09:00, in 10 minutes" in the event's own time zone. */
export function reminderBody(ev: CalendarEvent, startMs: number, minutes: number): string {
	if (ev.allDay) return minutes === 0 ? "Today, all day" : `All day on ${new Date(startMs).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: ev.timeZone })}`;
	if (minutes === 0) return `Starting now, at ${new Date(startMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: ev.timeZone })}${ev.location && !ev.private ? ` · ${ev.location}` : ""}`;
	const time = new Date(startMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: ev.timeZone });
	const when = minutes === 0 ? "Starting now" : minutes < 60 ? `In ${minutes} minutes` : minutes < 1440 ? `In ${minutes / 60 === 1 ? "1 hour" : `${Math.round(minutes / 60)} hours`}` : `${new Date(startMs).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: ev.timeZone })}`;
	return `${when}, at ${time}${ev.location && !ev.private ? ` · ${ev.location}` : ""}`;
}
