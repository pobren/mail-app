// Mail App addition (not part of upstream Agentic Inbox).
// Calendar sharing (see shared/calendar-shares.ts). Two sides:
//  - the calendar's own people choose who it's shared with (under /mailboxes/:mailboxId, so
//    requireMailbox has already checked they can open it);
//  - the people it's shared with see it next to their own calendars, and with "Can edit" add and
//    change its events (under /shared-calendars, checked against the share on every request).
// Events with guests stay with the calendar's own people, since changing them emails the guests.
// Also each calendar's subscribe link (see workers/lib/calendar-feeds.ts).

import { Hono, type Context } from "hono";
import { cleanEventInput, type Calendar, type CalendarEvent, type EditScope, type EventInput } from "../../shared/calendar";
import { dropShares, EVERYONE, levelFor, setSharesOf, sharedWith, sharesOf, SHARE_LEVELS, type ShareLevel } from "../../shared/calendar-shares";
import { canOpen, openable, type Person } from "../../shared/people";
import { feedOf, feedUrl, isFeedLevel, newFeedToken, setFeed, subscribeLinks } from "../../shared/calendar-feeds";
import { forgetCalendarFeeds, loadFeeds, updateFeeds } from "../lib/calendar-feeds";
import { loadShares, updateShares } from "../lib/calendar-shares";
import { OUTSIDE_WORDS } from "../../shared/outside-calendars";
import { organizerFor } from "../lib/invites";
import type { MailboxContext } from "../lib/mailbox";
import { loadPeople } from "../lib/people";
import type { Env } from "../types";

export const calendarShares = new Hono<MailboxContext>();

const base = "/api/v1/mailboxes/:mailboxId/calendar";
const DAY = 86_400_000;
const viewerOf = (c: { var: MailboxContext["Variables"] }) => ({ email: c.var.person?.email ?? "", name: c.var.person?.name ?? "" });
const scopeOf = (v: unknown): EditScope => (v === "one" || v === "following" ? v : "all");
const mailboxOf = (c: Context<MailboxContext>) => decodeURIComponent(c.req.param("mailboxId") ?? "").toLowerCase();
const linked = (ev: CalendarEvent | null) => !!ev && (!!ev.organizer || ev.guests.length > 0 || !!ev.recurrenceId);

function stubFor(env: Env, mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** People a calendar can be shared with: everyone on the list who can't already open the mailbox. */
function sharable(people: Person[], mailbox: string, me: string): { email: string; name: string }[] {
	return people
		.filter((p) => p.status !== "suspended" && p.email !== me && !canOpen(p, mailbox))
		.map((p) => ({ email: p.email, name: p.name }))
		.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
}

// ── The calendar's own people: who it's shared with ──────────────────

calendarShares.get(`${base}/shares`, async (c) => {
	const mailbox = mailboxOf(c);
	const { book } = await loadShares(c.env.BUCKET);
	const counts: Record<string, number> = {};
	for (const s of book.shares) if (s.owner === mailbox) counts[s.calendarId] = (counts[s.calendarId] ?? 0) + 1;
	return c.json({ counts });
});

calendarShares.get(`${base}/calendars/:id/shares`, async (c) => {
	const mailbox = mailboxOf(c);
	const id = c.req.param("id");
	const calendars = await c.var.mailboxStub.listCalendars();
	if (!calendars.some((cal) => cal.id === id)) return c.json({ error: "Not found" }, 404);
	const [{ book }, { book: people }] = await Promise.all([loadShares(c.env.BUCKET), loadPeople(c.env.BUCKET)]);
	return c.json({
		shares: sharesOf(book, mailbox, id).map((s) => ({ with: s.with, level: s.level })),
		people: sharable(people.people, mailbox, c.var.person?.email ?? ""),
	});
});

calendarShares.put(`${base}/calendars/:id/shares`, async (c) => {
	const mailbox = mailboxOf(c);
	const id = c.req.param("id");
	const calendars = await c.var.mailboxStub.listCalendars();
	if (!calendars.some((cal) => cal.id === id)) return c.json({ error: "Not found" }, 404);
	const body = (await c.req.json().catch(() => ({}))) as { shares?: unknown };
	const wanted = (Array.isArray(body.shares) ? body.shares : []) as { with: string; level: ShareLevel }[];
	// Only people on the list (or everyone).
	const { book: people } = await loadPeople(c.env.BUCKET);
	const allowed = new Set([EVERYONE, ...sharable(people.people, mailbox, c.var.person?.email ?? "").map((p) => p.email)]);
	const stranger = wanted.find((w) => !allowed.has(String(w?.with ?? "").toLowerCase()));
	if (stranger) return c.json({ error: `"${stranger.with}" isn't someone you can share with.` }, 400);
	if (wanted.some((w) => !SHARE_LEVELS.includes(w?.level))) return c.json({ error: "Please choose how much they can see." }, 400);
	const saved = await updateShares(c.env.BUCKET, (b) => setSharesOf(b, mailbox, id, wanted, c.var.person?.email ?? "", new Date().toISOString()));
	if (typeof saved === "string") return c.json({ error: saved }, 400);
	return c.json({ shares: sharesOf(saved, mailbox, id).map((s) => ({ with: s.with, level: s.level })) });
});

/** A deleted calendar is no longer shared with anyone, and its subscribe link stops working. */
export async function forgetCalendarShares(env: Env, mailbox: string, calendarId?: string): Promise<void> {
	await forgetCalendarFeeds(env, mailbox, calendarId);
	const { book } = await loadShares(env.BUCKET);
	const o = mailbox.toLowerCase();
	if (!book.shares.some((s) => s.owner === o && (calendarId === undefined || s.calendarId === calendarId))) return;
	await updateShares(env.BUCKET, (b) => dropShares(b, o, calendarId));
}

// ── Subscribe links (Apple Calendar, Outlook, Google Calendar) ───────

async function feedAnswer(c: Context<MailboxContext>, mailbox: string, cal: Calendar) {
	const { book } = await loadFeeds(c.env.BUCKET);
	const feed = feedOf(book, mailbox, cal.id);
	if (!feed) return { feed: null };
	const url = feedUrl(new URL(c.req.url).origin, feed.token);
	return { feed: { url, level: feed.level, links: subscribeLinks(url, cal.name) } };
}

async function calendarOf(c: Context<MailboxContext>): Promise<Calendar | null> {
	return (await c.var.mailboxStub.listCalendars()).find((cal) => cal.id === c.req.param("id")) ?? null;
}

calendarShares.get(`${base}/calendars/:id/feed`, async (c) => {
	const cal = await calendarOf(c);
	return cal ? c.json(await feedAnswer(c, mailboxOf(c), cal)) : c.json({ error: "Not found" }, 404);
});

// Makes a link, changes how much it shows ({ level }), or with { renew: true } replaces it so the old one stops working.
calendarShares.post(`${base}/calendars/:id/feed`, async (c) => {
	const cal = await calendarOf(c);
	if (!cal) return c.json({ error: "Not found" }, 404);
	const body = (await c.req.json().catch(() => ({}))) as { level?: unknown; renew?: unknown };
	const level = isFeedLevel(body.level) ? body.level : "all";
	const mailbox = mailboxOf(c);
	const saved = await updateFeeds(c.env.BUCKET, (b) => setFeed(b, mailbox, cal.id, level, c.var.person?.email ?? "", new Date().toISOString(), body.renew ? newFeedToken() : undefined));
	if (typeof saved === "string") return c.json({ error: saved }, 409);
	return c.json(await feedAnswer(c, mailbox, cal));
});

calendarShares.delete(`${base}/calendars/:id/feed`, async (c) => {
	const cal = await calendarOf(c);
	if (!cal) return c.json({ error: "Not found" }, 404);
	await forgetCalendarFeeds(c.env, mailboxOf(c), cal.id);
	return c.json({ feed: null });
});

// ── Shared with me ────────────────────────────────────────────────

export interface SharedCalendar extends Calendar {
	owner: string;
	ownerName: string;
	level: ShareLevel;
}

/** The calendars shared with this person that still exist, with their names and colours. */
async function mySharedCalendars(c: Context<MailboxContext>): Promise<SharedCalendar[]> {
	const person = c.var.person;
	if (!person?.email) return [];
	const { book } = await loadShares(c.env.BUCKET);
	const mine = sharedWith(book, person.email, openable(person));
	const owners = [...new Set(mine.map((s) => s.owner))];
	const out: SharedCalendar[] = [];
	await Promise.all(owners.map(async (owner) => {
		if (!(await c.env.BUCKET.head(`mailboxes/${owner}.json`))) return;
		const [calendars, organiser] = await Promise.all([stubFor(c.env, owner).listCalendars(), organizerFor(c.env, owner, null)]);
		for (const s of mine.filter((m) => m.owner === owner)) {
			const cal = calendars.find((x) => x.id === s.calendarId);
			if (cal) out.push({ ...cal, owner, ownerName: organiser.name || owner, level: s.level });
		}
	}));
	return out.sort((a, b) => a.ownerName.localeCompare(b.ownerName) || a.name.localeCompare(b.name));
}

calendarShares.get("/api/v1/shared-calendars", async (c) => c.json(await mySharedCalendars(c)));

calendarShares.get("/api/v1/shared-calendars/events", async (c) => {
	const from = Date.parse(c.req.query("from") ?? "");
	const to = Date.parse(c.req.query("to") ?? "");
	if (Number.isNaN(from) || Number.isNaN(to) || to <= from || to - from > 100 * DAY) return c.json({ error: "Please give a date range." }, 400);
	const calendars = await mySharedCalendars(c);
	const lists = await Promise.all(calendars.map(async (cal) => {
		const list = await stubFor(c.env, cal.owner).calendarOccurrences(from, to, viewerOf(c), { calendarId: cal.id, level: cal.level });
		return list.map((o) => ({ ...o, owner: cal.owner }));
	}));
	return c.json(lists.flat().sort((a, b) => (a.startAt < b.startAt ? -1 : 1)));
});

/** Can this person add to and change this calendar? */
async function canEditShared(c: Context<MailboxContext>, owner: string, calendarId: string): Promise<boolean> {
	const person = c.var.person;
	if (!person?.email || !calendarId) return false;
	if (canOpen(person, owner)) return false; // they use the mailbox's own calendar page for that
	const { book } = await loadShares(c.env.BUCKET);
	if (levelFor(book, person.email, owner, calendarId) !== "edit") return false;
	const calendars = await stubFor(c.env, owner).listCalendars();
	// A calendar from another website is read only for everyone.
	return calendars.some((cal) => cal.id === calendarId && !cal.sourceUrl);
}

const ownerOf = (c: Context<MailboxContext>) => decodeURIComponent(c.req.param("owner") ?? "").toLowerCase();
const noEdit = (c: Context<MailboxContext>) => c.json({ error: "You can only look at this calendar, not change it." }, 403);
const withGuests = (c: Context<MailboxContext>) =>
	c.json({ error: "This event has guests, so only the calendar's own people can change it." }, 403);

/** What someone it's shared with may save: no guests (that would email people) and no reminders (those go to the calendar's own devices). */
function asShared(input: EventInput, before: CalendarEvent | null): EventInput {
	return { ...input, guests: before?.guests ?? [], reminders: before?.reminders ?? [] };
}

calendarShares.post("/api/v1/shared-calendars/:owner/events", async (c) => {
	const owner = ownerOf(c);
	const input = cleanEventInput(await c.req.json().catch(() => null));
	if (typeof input === "string") return c.json({ error: input }, 400);
	if (!(await canEditShared(c, owner, input.calendarId))) return noEdit(c);
	if (input.guests.length) return c.json({ error: "To invite guests, add the event to one of your own calendars." }, 400);
	const made = await stubFor(c.env, owner).createCalendarEvent(asShared(input, null), viewerOf(c));
	return c.json({ ...made, owner }, 201);
});

calendarShares.put("/api/v1/shared-calendars/:owner/events/:id", async (c) => {
	const owner = ownerOf(c);
	const stub = stubFor(c.env, owner);
	const body = (await c.req.json().catch(() => ({}))) as { event?: unknown; scope?: unknown; occurrence?: unknown };
	const input = cleanEventInput(body.event);
	if (typeof input === "string") return c.json({ error: input }, 400);
	const before = await stub.getCalendarEvent(c.req.param("id"));
	if (!before) return c.json({ error: "That event has been deleted." }, 404);
	// Both where it is and where it's going must be shared with them to edit.
	if (!(await canEditShared(c, owner, before.calendarId)) || !(await canEditShared(c, owner, input.calendarId))) return noEdit(c);
	if (linked(before)) return withGuests(c);
	const occurrence = typeof body.occurrence === "string" ? body.occurrence : null;
	const result = await stub.changeCalendarEvent(before.id, asShared(input, before), scopeOf(body.scope), occurrence, viewerOf(c));
	if (result === "missing") return c.json({ error: "That event has been deleted." }, 404);
	if (result === "private") return c.json({ error: "This is someone else's private event, so only they can change it." }, 403);
	if (result === "outside") return c.json({ error: OUTSIDE_WORDS }, 400);
	return c.json({ ...result, owner });
});

calendarShares.delete("/api/v1/shared-calendars/:owner/events/:id", async (c) => {
	const owner = ownerOf(c);
	const stub = stubFor(c.env, owner);
	const before = await stub.getCalendarEvent(c.req.param("id"));
	if (!before) return c.json({ ok: true });
	if (!(await canEditShared(c, owner, before.calendarId))) return noEdit(c);
	if (linked(before)) return withGuests(c);
	const result = await stub.removeCalendarEvent(before.id, scopeOf(c.req.query("scope")), c.req.query("occurrence") || null, viewerOf(c));
	if (result === "private") return c.json({ error: "This is someone else's private event, so only they can delete it." }, 403);
	if (result === "outside") return c.json({ error: OUTSIDE_WORDS }, 400);
	return c.json({ ok: true });
});
