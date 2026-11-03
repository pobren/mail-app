// Mail App addition (not part of upstream Agentic Inbox).
// The calendar's API. Calendars live in each mailbox's own database (workers/durableObject/calendar.ts),
// so everyone who can open the mailbox shares them; requireMailbox has already checked that.
// Also invites: guests of our events are emailed (?notify), and an invite that arrives by email can be
// answered from the email (the /emails/:emailId/invite routes).

import { Hono, type Context } from "hono";
import {
	cleanCalendarName, cleanEventInput, eventUid, formatWall, isCalendarColor, isTimeZone, parseWall, recurrenceIdOf, recurrenceWall,
	type CalendarEvent, type EditScope, type Guest, type GuestStatus,
} from "../../shared/calendar";
import { eventFromInvite, exceptionsFromInvite, parseIcs, recurrenceIdFromInvite, whenText, type IcsEvent, type IcsFile } from "../../shared/invites";
import { nextLabelColor } from "../../shared/labels";
import { sendableAddresses } from "../../shared/addresses";
import { loadAddressBook } from "../lib/addresses";
import { emailAnswer, emailGuests, organizerFor } from "../lib/invites";
import { forgetCalendarShares } from "./calendar-shares";
import { cleanSourceUrl, MAX_OUTSIDE_BYTES, OUTSIDE_WORDS, outsideEvents } from "../../shared/outside-calendars";
import { dueForRefresh, fetchOutside, refreshOutside } from "../lib/outside-calendars";
import type { MailboxContext } from "../lib/mailbox";

export const calendar = new Hono<MailboxContext>();

const base = "/api/v1/mailboxes/:mailboxId/calendar";
const viewerOf = (c: { var: MailboxContext["Variables"] }) => ({ email: c.var.person?.email ?? "", name: c.var.person?.name ?? "" });
const scopeOf = (v: unknown): EditScope => (v === "one" || v === "following" ? v : "all");
const DAY = 86_400_000;
const mailboxOf = (c: Context<MailboxContext>) => decodeURIComponent(c.req.param("mailboxId") ?? "").toLowerCase();
/** Is this event in guests' calendars too? Such a series changes one date or all of them, never "this and following". */
const linked = (ev: CalendarEvent | null) => !!ev && (!!ev.organizer || ev.guests.length > 0 || !!ev.recurrenceId);

/** One date of a series as an event of its own, as guests know it. */
function oneDateOf(series: CalendarEvent, occurrence: string): CalendarEvent {
	const length = parseWall(series.end) - parseWall(series.start);
	return {
		...series, start: occurrence, end: formatWall(parseWall(occurrence) + length, series.allDay), repeat: null, exceptions: [],
		uid: eventUid(series), recurrenceId: recurrenceIdOf(series, occurrence),
	};
}

/** A series as guests should see it: dates changed on their own aren't "removed" (that would delete them). */
async function asGuestsSeeIt(c: Context<MailboxContext>, ev: CalendarEvent): Promise<CalendarEvent> {
	if (!ev.repeat || !ev.exceptions.length) return ev;
	const changed = new Set((await c.var.mailboxStub.calendarChangedDates(eventUid(ev))).map((r) => recurrenceWall(ev, r)));
	return changed.size ? { ...ev, exceptions: ev.exceptions.filter((x) => !changed.has(x)) } : ev;
}

/** Emails the guests of one of our events after a change: new guests get the invite, everyone else an update, and removed guests a cancellation. */
async function tellGuests(c: Context<MailboxContext>, before: CalendarEvent | null, after: CalendarEvent): Promise<string | null> {
	if (after.organizer) return null;
	const organizer = await organizerFor(c.env, mailboxOf(c), c.var.person);
	after = await asGuestsSeeIt(c, after);
	const had = new Set((before?.guests ?? []).map((g) => g.email));
	const has = new Set(after.guests.map((g) => g.email));
	const added = after.guests.filter((g) => !had.has(g.email));
	const kept = after.guests.filter((g) => had.has(g.email));
	const removed = (before?.guests ?? []).filter((g) => !has.has(g.email));
	const changed = !!before && after.sequence > before.sequence;
	const problems = await Promise.all([
		emailGuests(c.env, "REQUEST", after, organizer, added),
		changed ? emailGuests(c.env, "REQUEST", after, organizer, kept, true) : null,
		before ? emailGuests(c.env, "CANCEL", before, organizer, removed) : null,
	]);
	return problems.find(Boolean) ?? null;
}

calendar.get(`${base}/calendars`, async (c) => c.json(await c.var.mailboxStub.listCalendars()));

calendar.post(`${base}/calendars`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; color?: unknown; sourceUrl?: unknown; tz?: unknown };
	const name = cleanCalendarName(body.name);
	if (!name) return c.json({ error: "Please give the calendar a name." }, 400);
	const color = isCalendarColor(body.color) ? body.color : nextLabelColor(await c.var.mailboxStub.listCalendars());
	// A calendar from another website: read it first, so a link that doesn't work is caught now.
	let source: { url: string; tz: string } | undefined;
	if (body.sourceUrl !== undefined && body.sourceUrl !== null && body.sourceUrl !== "") {
		const url = cleanSourceUrl(body.sourceUrl);
		if (!url) return c.json({ error: "Please paste a web address, starting https:// or webcal://" }, 400);
		source = { url, tz: isTimeZone(body.tz) ? body.tz : "Europe/London" };
		const first = await fetchOutside(url, "", source.tz);
		if ("error" in first) return c.json({ error: first.error }, 400);
	}
	const made = await c.var.mailboxStub.createCalendar(name, color, source);
	if (made === "full") return c.json({ error: "You can have up to 20 calendars." }, 400);
	if (source) {
		await refreshOutside(c.var.mailboxStub, made.id);
		return c.json((await c.var.mailboxStub.listCalendars()).find((cal) => cal.id === made.id) ?? made, 201);
	}
	return c.json(made, 201);
});

// Imports an .ics file (from Google Calendar, Outlook, Apple Calendar...) into one of your own calendars.
calendar.post(`${base}/calendars/:id/import`, async (c) => {
	const text = await c.req.text();
	if (text.length > MAX_OUTSIDE_BYTES) return c.json({ error: "That file is too big to import (over 5 MB)." }, 400);
	const items = outsideEvents(text, c.req.param("id"), tzOf(c), Date.now(), true);
	if (typeof items === "string") return c.json({ error: "That file isn't a calendar. Please choose an .ics file." }, 400);
	if (!items.length) return c.json({ error: "There are no events in that file." }, 400);
	// Events come in as plain events of yours: no guests (nobody gets emailed) and no reminders.
	const done = await c.var.mailboxStub.importCalendarEvents(c.req.param("id"), items, viewerOf(c));
	if (!done) return c.json({ error: "Please choose one of your own calendars to import into." }, 400);
	return c.json(done);
});

// Brings a calendar from another website up to date now.
calendar.post(`${base}/calendars/:id/refresh`, async (c) => {
	const id = c.req.param("id");
	if (!(await c.var.mailboxStub.outsideCalendarSource(id))) return c.json({ error: "Not found" }, 404);
	await refreshOutside(c.var.mailboxStub, id);
	return c.json((await c.var.mailboxStub.listCalendars()).find((cal) => cal.id === id));
});

calendar.put(`${base}/calendars/:id`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; color?: unknown };
	const changes: { name?: string; color?: ReturnType<typeof nextLabelColor> } = {};
	if (body.name !== undefined) {
		const name = cleanCalendarName(body.name);
		if (!name) return c.json({ error: "Please give the calendar a name." }, 400);
		changes.name = name;
	}
	if (isCalendarColor(body.color)) changes.color = body.color;
	const saved = await c.var.mailboxStub.updateCalendar(c.req.param("id"), changes);
	return saved ? c.json(saved) : c.json({ error: "Not found" }, 404);
});

calendar.delete(`${base}/calendars/:id`, async (c) => {
	const result = await c.var.mailboxStub.removeCalendar(c.req.param("id"));
	if (result === "last") return c.json({ error: "You need at least one calendar." }, 400);
	if (result) await forgetCalendarShares(c.env, mailboxOf(c), c.req.param("id"));
	return result ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

// Everything between two moments (at most about six weeks plus a bit, which covers a month view).
calendar.get(`${base}/events`, async (c) => {
	const from = Date.parse(c.req.query("from") ?? "");
	const to = Date.parse(c.req.query("to") ?? "");
	if (Number.isNaN(from) || Number.isNaN(to) || to <= from || to - from > 100 * DAY) return c.json({ error: "Please give a date range." }, 400);
	// Calendars from other websites are brought up to date every few hours, while someone's looking.
	const due = dueForRefresh(await c.var.mailboxStub.listCalendars());
	if (due.length) c.executionCtx.waitUntil(Promise.all(due.map((cal) => refreshOutside(c.var.mailboxStub, cal.id).catch(() => {}))));
	return c.json(await c.var.mailboxStub.calendarOccurrences(from, to, viewerOf(c)));
});

calendar.post(`${base}/events`, async (c) => {
	const input = cleanEventInput(await c.req.json().catch(() => null));
	if (typeof input === "string") return c.json({ error: input }, 400);
	if ((await c.var.mailboxStub.listCalendars()).some((cal) => cal.id === input.calendarId && cal.sourceUrl)) return c.json({ error: OUTSIDE_WORDS }, 400);
	const made = await c.var.mailboxStub.createCalendarEvent(input, viewerOf(c));
	const inviteProblem = c.req.query("notify") && made.guests.length ? await tellGuests(c, null, made) : null;
	return c.json({ ...made, inviteProblem }, 201);
});

calendar.put(`${base}/events/:id`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { event?: unknown; scope?: unknown; occurrence?: unknown };
	const input = cleanEventInput(body.event);
	if (typeof input === "string") return c.json({ error: input }, 400);
	const occurrence = typeof body.occurrence === "string" ? body.occurrence : null;
	const before = await c.var.mailboxStub.getCalendarEvent(c.req.param("id"));
	const result = await c.var.mailboxStub.changeCalendarEvent(c.req.param("id"), input, scopeOf(body.scope), occurrence, viewerOf(c));
	if (result === "missing") return c.json({ error: "That event has been deleted." }, 404);
	if (result === "private") return c.json({ error: "This is someone else's private event, so only they can change it." }, 403);
	if (result === "outside") return c.json({ error: OUTSIDE_WORDS }, 400);
	const notify = (body as { notify?: unknown }).notify && (before?.guests.length || result.guests.length);
	// Changing one date of a series: guests hear about just that date.
	const was = result.id === before?.id ? before : before && result.recurrenceId && occurrence ? { ...oneDateOf(before, occurrence), id: result.id } : null;
	const inviteProblem = notify ? await tellGuests(c, was, result) : null;
	return c.json({ ...result, inviteProblem });
});

calendar.delete(`${base}/events/:id`, async (c) => {
	const occurrence = c.req.query("occurrence") || null;
	const before = await c.var.mailboxStub.getCalendarEvent(c.req.param("id"));
	let scope = scopeOf(c.req.query("scope"));
	if (linked(before) && scope === "following") scope = "all";
	const result = await c.var.mailboxStub.removeCalendarEvent(c.req.param("id"), scope, occurrence, viewerOf(c));
	if (result === "missing") return c.json({ ok: true });
	if (result === "private") return c.json({ error: "This is someone else's private event, so only they can delete it." }, 403);
	if (result === "outside") return c.json({ error: OUTSIDE_WORDS }, 400);
	// Guests of an event of ours hear it's been cancelled: all of it, or just the one date.
	let inviteProblem: string | null = null;
	if (c.req.query("notify") && before && !before.organizer && before.guests.length) {
		const off = before.repeat && occurrence && scope === "one" ? oneDateOf(before, occurrence) : before;
		inviteProblem = await emailGuests(c.env, "CANCEL", off, await organizerFor(c.env, mailboxOf(c), c.var.person), before.guests);
	}
	return c.json({ ok: true, inviteProblem });
});

// ── Invites that arrive by email ─────────────────────────────────────

const CALENDAR_TYPES = /^(text\/calendar|application\/ics)/i;

const tzOf = (c: Context<MailboxContext>, fallback = "Europe/London") => {
	const tz = c.req.query("tz");
	return isTimeZone(tz) ? tz : fallback;
};

/** The invite in an email: its file, the event it's about, and which guest on it is us. */
async function inviteIn(c: Context<MailboxContext>, emailId: string): Promise<{ file: IcsFile; ev: IcsEvent; me: Guest | null; mine: string[]; rid: string | null; had: CalendarEvent | null } | null> {
	const email = (await c.var.mailboxStub.getEmail(emailId)) as { attachments?: { id: string; filename: string; mimetype: string }[] } | null;
	const att = email?.attachments?.find((a) => CALENDAR_TYPES.test(a.mimetype ?? "") || /\.ics$/i.test(a.filename ?? ""));
	if (!att) return null;
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${att.id}/${att.filename}`);
	if (!obj) return null;
	const file = parseIcs(await obj.text());
	const ev = file.events.find((e) => !e.recurrenceId) ?? file.events[0];
	if (!ev) return null;
	const mailbox = mailboxOf(c);
	const mine = [mailbox, ...sendableAddresses(await loadAddressBook(c.env.BUCKET), mailbox)].map((a) => a.toLowerCase());
	const me = ev.attendees.find((a) => mine.includes(a.email)) ?? null;
	// Just one date of a series: the series' own time zone says which.
	const series = ev.recurrenceId ? await c.var.mailboxStub.calendarEventByUid(ev.uid) : null;
	const rid = recurrenceIdFromInvite(ev, file, series?.timeZone ?? tzOf(c));
	const had = await c.var.mailboxStub.calendarEventByUid(ev.uid, rid);
	return { file, ev, me, mine, rid, had };
}

calendar.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/invite", async (c) => {
	const found = await inviteIn(c, c.req.param("emailId"));
	if (!found) return c.json({ invite: null });
	const { file, ev, me, mine, rid, had } = found;
	const input = eventFromInvite(ev, file, tzOf(c, had?.timeZone), "");
	const ours = !!had && !had.organizer;
	const myStatus: GuestStatus | null = had?.organizer
		? had.guests.find((g) => mine.includes(g.email))?.status ?? "accepted"
		: had ? null : me?.status ?? null;
	return c.json({
		invite: {
			method: file.method || "REQUEST",
			cancelled: file.method === "CANCEL" || ev.status === "CANCELLED",
			title: input.title, when: whenText(input), allDay: input.allDay, start: input.start, end: input.end, timeZone: input.timeZone,
			location: input.location, meetingUrl: input.meetingUrl, repeats: !!input.repeat, oneDate: !!rid,
			organizer: ev.organizer, guests: ev.attendees, ours,
			inCalendar: !!had, eventId: had?.id ?? null, myStatus,
			// Older than the copy we have: the card says so rather than offering to change it back.
			outdated: !!had && !ours && had.sequence > ev.sequence,
			// For an answer to one of our invites: who answered and how.
			answer: file.method === "REPLY" && ev.attendees[0] ? ev.attendees[0] : null,
		},
	});
});

calendar.post("/api/v1/mailboxes/:mailboxId/emails/:emailId/invite", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { answer?: unknown };
	const answer = body.answer;
	const found = await inviteIn(c, c.req.param("emailId"));
	if (!found) return c.json({ error: "There's no invite in this email." }, 404);
	const { file, ev, me, rid, had } = found;
	const stub = c.var.mailboxStub;
	if (answer === "remove") {
		await stub.removeCalendarInvite(ev.uid, rid);
		return c.json({ ok: true, inCalendar: false });
	}
	if (answer !== "accepted" && answer !== "tentative" && answer !== "declined") return c.json({ error: "Please choose Yes, Maybe or No." }, 400);
	if (file.method === "CANCEL" || file.method === "REPLY") return c.json({ error: "This email doesn't need an answer." }, 400);
	if (had && !had.organizer) return c.json({ error: "This is your own event." }, 400);
	const sender = await organizerFor(c.env, mailboxOf(c), c.var.person);
	const meAs: Guest = { email: me?.email ?? sender.email, name: me?.name || sender.name, status: answer };
	const input = eventFromInvite(ev, file, tzOf(c, had?.timeZone), had?.calendarId ?? "");
	input.guests = input.guests.some((g) => g.email === meAs.email)
		? input.guests.map((g) => (g.email === meAs.email ? meAs : g))
		: [...input.guests, meAs];
	const exceptions = exceptionsFromInvite(ev, file, input);
	const organizer = ev.organizer ?? null;
	let saved: CalendarEvent | null = null;
	if (answer === "declined") await stub.removeCalendarInvite(ev.uid, rid);
	else saved = await stub.saveCalendarInvite(input, { uid: ev.uid, organizer, sequence: ev.sequence, exceptions, recurrenceId: rid }, viewerOf(c));
	// Tell whoever sent it. Without an organiser there's nobody to tell.
	const forReply: CalendarEvent = saved ?? { ...input, id: "", uid: ev.uid, organizer, sequence: ev.sequence, exceptions, recurrenceId: rid, createdBy: null, createdByName: null, createdAt: "", updatedAt: "" };
	const problem = organizer?.email ? await emailAnswer(c.env, forReply, organizer, meAs, answer, mailboxOf(c)) : null;
	return c.json({ ok: true, inCalendar: !!saved, eventId: saved?.id ?? null, myStatus: answer, problem });
});

// Reminders in the next day or so, so the open app can show them as well as the phone.
calendar.get(`${base}/reminders`, async (c) => {
	const now = Date.now();
	return c.json(await c.var.mailboxStub.upcomingReminders(now - 60_000, now + DAY, viewerOf(c)));
});

// The calendar (or one of them) as an .ics file, to keep or to import into another calendar app.
calendar.get(`${base}/export.ics`, async (c) => {
	const { name, ics } = await c.var.mailboxStub.exportCalendar(c.req.query("calendar") || null, viewerOf(c));
	const file = `${name.replace(/[^\w\- ]+/g, "").trim() || "calendar"}.ics`;
	return new Response(ics, {
		headers: {
			"Content-Type": "text/calendar; charset=utf-8",
			"Content-Disposition": `attachment; filename="${file}"`,
		},
	});
});
