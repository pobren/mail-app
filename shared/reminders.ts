// Mail App addition (not part of upstream Agentic Inbox).
// Snooze (hide a conversation until a set time, then bring it back to the top of the Inbox) and
// "Remind me if no reply" (a sent email comes back to the Inbox if nobody answers in time). Each
// mailbox keeps them in its database (the reminders table) and its alarm brings them back. These are
// the times offered, worked out in the person's own time zone by the browser.

export type ReminderKind = "snooze" | "no-reply";

/** What an email (or the list) says about its conversation's reminders. */
export interface ReminderInfo {
	kind: ReminderKind;
	/** When it's due, in milliseconds. */
	due_at: number;
	/** For "no-reply": true once it's due and the conversation is back in the Inbox. */
	shown: boolean;
}

/** The furthest ahead a snooze or reminder can be set. */
export const MAX_AHEAD_MS = 366 * 86_400_000;

/** A time this far ahead or less is too soon to be worth it (and may already have passed on the way). */
export const MIN_AHEAD_MS = 60_000;

/** The hour a snooze to "tomorrow", "this weekend" or "next week" comes back. */
export const MORNING_HOUR = 8;

/** Whether `at` is a time a snooze or reminder can be set for. */
export function validDueAt(at: unknown, now = Date.now()): at is number {
	return typeof at === "number" && Number.isFinite(at) && at >= now + MIN_AHEAD_MS && at <= now + MAX_AHEAD_MS;
}

function atHour(d: Date, hour: number): Date {
	const out = new Date(d);
	out.setHours(hour, 0, 0, 0);
	return out;
}

function addDays(d: Date, days: number): Date {
	const out = new Date(d);
	out.setDate(out.getDate() + days);
	return out;
}

export interface SnoozeChoice {
	id: "later" | "tomorrow" | "weekend" | "next-week";
	at: Date;
}

/**
 * The quick snooze times, in local time: later today (3 hours on, only before 6pm), tomorrow at 8am,
 * this weekend (Saturday at 8am, left out from Friday evening to Sunday) and next week (Monday at 8am).
 */
export function snoozeChoices(now = new Date()): SnoozeChoice[] {
	const out: SnoozeChoice[] = [];
	if (now.getHours() < 18) {
		const later = new Date(now.getTime() + 3 * 3_600_000);
		later.setMinutes(later.getMinutes() < 30 ? 0 : 30, 0, 0);
		out.push({ id: "later", at: later });
	}
	out.push({ id: "tomorrow", at: atHour(addDays(now, 1), MORNING_HOUR) });
	const day = now.getDay(); // 0 Sunday … 6 Saturday
	const weekendOff = day === 6 || day === 0 || (day === 5 && now.getHours() >= 18);
	if (!weekendOff) out.push({ id: "weekend", at: atHour(addDays(now, 6 - day), MORNING_HOUR) });
	out.push({ id: "next-week", at: atHour(addDays(now, ((8 - day) % 7) || 7), MORNING_HOUR) });
	return out;
}

/** The "Remind me if no reply" choices, in days. */
export const NO_REPLY_DAYS = [1, 2, 3, 7] as const;

/** When a "no reply in N days" reminder is due: N days on, at the same time of day. */
export function noReplyDueAt(days: number, now = new Date()): number {
	return addDays(now, days).getTime();
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/**
 * When a snooze or reminder is due, in words: "today at 15:00", "tomorrow at 08:00", "Saturday at
 * 08:00" (in the next week), or "Mon 3 Nov at 08:00". In the person's own time zone.
 */
export function formatWhen(ms: number, now = new Date()): string {
	const d = new Date(ms);
	const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	if (sameDay(d, now)) return `today at ${time}`;
	if (sameDay(d, addDays(now, 1))) return `tomorrow at ${time}`;
	if (d > now && d.getTime() - now.getTime() < 6 * 86_400_000) return `${d.toLocaleDateString("en-GB", { weekday: "long" })} at ${time}`;
	const sameYear = d.getFullYear() === now.getFullYear();
	return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).replace(",", "")} at ${time}`;
}
