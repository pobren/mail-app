// Mail App addition (not part of upstream Agentic Inbox).
// Calendar sharing: a mailbox's calendar shared with someone else on the team, or with everyone.
// Each share says how much they see: just when you're busy, every event, or every event and the
// right to add and change them. A calendar shared with everyone so they can edit is a team calendar.
// All the shares for an install live in one small file in R2 (calendar-shares.json).
//
// Pure functions only, so the browser, the Worker and the tests can all use them.

export type ShareLevel = "busy" | "view" | "edit";
export const SHARE_LEVELS: ShareLevel[] = ["busy", "view", "edit"];

/** Shared with everyone on the People list (a team calendar). */
export const EVERYONE = "everyone";

export interface CalendarShare {
	/** The mailbox the calendar belongs to. */
	owner: string;
	calendarId: string;
	/** Who it's shared with: their sign-in address, or EVERYONE. */
	with: string;
	level: ShareLevel;
	/** Who shared it, and when. */
	by: string;
	at: string;
}

export interface ShareBook {
	shares: CalendarShare[];
}

export const SHARES_KEY = "calendar-shares.json";
/** People a single calendar can be shared with, one by one (EVERYONE counts as one). */
export const MAX_SHARES_PER_CALENDAR = 50;

const ADDRESS_RE = /^[a-z0-9.!#$%&'*/=?^_`{|}~+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const isLevel = (v: unknown): v is ShareLevel => v === "busy" || v === "view" || v === "edit";
const isWho = (v: unknown): v is string => typeof v === "string" && (v === EVERYONE || ADDRESS_RE.test(v));

export function cleanShares(raw: unknown): ShareBook {
	const list = Array.isArray((raw as ShareBook | null)?.shares) ? (raw as ShareBook).shares : [];
	const seen = new Set<string>();
	const shares: CalendarShare[] = [];
	for (const s of list) {
		if (!s || typeof s !== "object") continue;
		const owner = typeof s.owner === "string" ? s.owner.trim().toLowerCase() : "";
		const who = typeof s.with === "string" ? s.with.trim().toLowerCase() : "";
		if (!ADDRESS_RE.test(owner) || !isWho(who) || typeof s.calendarId !== "string" || !s.calendarId || !isLevel(s.level)) continue;
		const key = `${owner}|${s.calendarId}|${who}`;
		if (seen.has(key)) continue;
		seen.add(key);
		shares.push({ owner, calendarId: s.calendarId, with: who, level: s.level, by: typeof s.by === "string" ? s.by : "", at: typeof s.at === "string" ? s.at : "" });
	}
	return { shares };
}

/** One calendar's shares, as the share window edits them. */
export function sharesOf(book: ShareBook, owner: string, calendarId: string): CalendarShare[] {
	const o = owner.toLowerCase();
	return book.shares.filter((s) => s.owner === o && s.calendarId === calendarId);
}

/** Replaces one calendar's shares. Returns a sentence when something is wrong. */
export function setSharesOf(
	book: ShareBook,
	owner: string,
	calendarId: string,
	wanted: { with: string; level: ShareLevel }[],
	by: string,
	now: string,
): ShareBook | string {
	const o = owner.toLowerCase();
	const had = new Map(sharesOf(book, o, calendarId).map((s) => [s.with, s]));
	const next: CalendarShare[] = [];
	const seen = new Set<string>();
	for (const w of wanted) {
		const who = String(w.with ?? "").trim().toLowerCase();
		if (!isWho(who)) return `"${w.with}" isn't someone on your team.`;
		if (!isLevel(w.level)) return "Please choose how much they can see.";
		if (seen.has(who)) continue;
		seen.add(who);
		const before = had.get(who);
		// Unchanged shares keep who made them and when.
		next.push(before && before.level === w.level ? before : { owner: o, calendarId, with: who, level: w.level, by, at: now });
	}
	if (next.length > MAX_SHARES_PER_CALENDAR) return `A calendar can be shared with up to ${MAX_SHARES_PER_CALENDAR} people.`;
	return { shares: [...book.shares.filter((s) => !(s.owner === o && s.calendarId === calendarId)), ...next] };
}

/** Takes away every share of a calendar (it was deleted), or of a whole mailbox. */
export function dropShares(book: ShareBook, owner: string, calendarId?: string): ShareBook {
	const o = owner.toLowerCase();
	return { shares: book.shares.filter((s) => !(s.owner === o && (calendarId === undefined || s.calendarId === calendarId))) };
}

const RANK: Record<ShareLevel, number> = { busy: 1, view: 2, edit: 3 };

/**
 * The calendars shared with this person, each at the most they're allowed (a calendar shared with
 * them and with everyone counts at the higher level). Calendars in mailboxes they can open anyway
 * are left out, since they already see them in full there.
 */
export function sharedWith(book: ShareBook, email: string, ownMailboxes: string[]): { owner: string; calendarId: string; level: ShareLevel }[] {
	const me = email.toLowerCase();
	const own = new Set(ownMailboxes.map((m) => m.toLowerCase()));
	const best = new Map<string, { owner: string; calendarId: string; level: ShareLevel }>();
	for (const s of book.shares) {
		if (s.with !== me && s.with !== EVERYONE) continue;
		if (own.has(s.owner)) continue;
		const key = `${s.owner}|${s.calendarId}`;
		const had = best.get(key);
		if (!had || RANK[s.level] > RANK[had.level]) best.set(key, { owner: s.owner, calendarId: s.calendarId, level: s.level });
	}
	return [...best.values()];
}

/** How much this person may see of one calendar, or null if it isn't shared with them. */
export function levelFor(book: ShareBook, email: string, owner: string, calendarId: string): ShareLevel | null {
	const me = email.toLowerCase();
	const o = owner.toLowerCase();
	let level: ShareLevel | null = null;
	for (const s of book.shares) {
		if (s.owner !== o || s.calendarId !== calendarId || (s.with !== me && s.with !== EVERYONE)) continue;
		if (!level || RANK[s.level] > RANK[level]) level = s.level;
	}
	return level;
}
