// Mail App addition (not part of upstream Agentic Inbox).
// Notes: ideas, checklists and quick reminders, kept in the mailbox's own database alongside its email.
// A note is private to the person who wrote it. In a mailbox more than one person uses, it can be shared
// with everyone who can open the mailbox, and then any of them can change it. A note with a reminder
// sends a notification to the mailbox's devices when it's due. Deleted notes stay in the Bin for
// BIN_DAYS so they can be put back.

export type NoteColour = "none" | "yellow" | "green" | "blue" | "pink" | "purple" | "grey";

export const NOTE_COLOURS: NoteColour[] = ["none", "yellow", "green", "blue", "pink", "purple", "grey"];

export interface ChecklistItem {
	id: string;
	text: string;
	done: boolean;
}

export interface Note {
	id: string;
	title: string;
	/** The text, for a note that isn't a checklist. */
	body: string;
	/** A checklist instead of text: an empty list means it's a text note. */
	items: ChecklistItem[];
	checklist: boolean;
	colour: NoteColour;
	pinned: boolean;
	/** Shared with everyone who can open the mailbox. */
	shared: boolean;
	/** When to send a reminder, in milliseconds, or null. */
	remindAt: number | null;
	/** True once the reminder has been sent. */
	reminded: boolean;
	ownerEmail: string;
	ownerName: string;
	/** Is the viewer the person who wrote it? */
	mine: boolean;
	createdAt: string;
	updatedAt: string;
	binnedAt: string | null;
}

/** What the app sends to make or change a note. Anything left out stays as it is. */
export interface NoteInput {
	title?: string;
	body?: string;
	items?: ChecklistItem[];
	checklist?: boolean;
	colour?: NoteColour;
	pinned?: boolean;
	shared?: boolean;
	remindAt?: number | null;
}

export const MAX_TITLE = 200;
export const MAX_BODY = 20_000;
export const MAX_ITEMS = 200;
export const MAX_ITEM_TEXT = 500;
export const MAX_NOTES = 2000;
export const BIN_DAYS = 30;
/** The furthest ahead a reminder can be set. */
export const MAX_REMIND_AHEAD_MS = 2 * 366 * 86_400_000;

const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").slice(0, max) : "");
const ITEM_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** A checklist made safe to keep: no more than MAX_ITEMS, each with an id and some text. */
export function cleanItems(v: unknown): ChecklistItem[] {
	if (!Array.isArray(v)) return [];
	const seen = new Set<string>();
	const out: ChecklistItem[] = [];
	for (const raw of v.slice(0, MAX_ITEMS)) {
		if (!raw || typeof raw !== "object") continue;
		const r = raw as Record<string, unknown>;
		const text = clip(r.text, MAX_ITEM_TEXT).replace(/\n/g, " ");
		let id = typeof r.id === "string" && ITEM_ID.test(r.id) ? r.id : "";
		if (!id || seen.has(id)) id = `i${out.length}-${Math.random().toString(36).slice(2, 8)}`;
		seen.add(id);
		out.push({ id, text, done: r.done === true });
	}
	return out;
}

/**
 * The parts of a request that can change a note, cleaned. `now` is for checking a reminder time: one in
 * the past is refused (returns a message), null clears it.
 */
export function cleanNoteInput(v: unknown, now = Date.now()): NoteInput | string {
	if (!v || typeof v !== "object") return "That note couldn't be read.";
	const r = v as Record<string, unknown>;
	const out: NoteInput = {};
	if ("title" in r) out.title = clip(r.title, MAX_TITLE).replace(/\n/g, " ");
	if ("body" in r) out.body = clip(r.body, MAX_BODY);
	if ("items" in r) out.items = cleanItems(r.items);
	if ("checklist" in r) out.checklist = r.checklist === true;
	if ("colour" in r) out.colour = NOTE_COLOURS.includes(r.colour as NoteColour) ? (r.colour as NoteColour) : "none";
	if ("pinned" in r) out.pinned = r.pinned === true;
	if ("shared" in r) out.shared = r.shared === true;
	if ("remindAt" in r) {
		if (r.remindAt === null) out.remindAt = null;
		else if (typeof r.remindAt === "number" && Number.isFinite(r.remindAt)) {
			if (r.remindAt < now - 60_000) return "That reminder time has already passed.";
			if (r.remindAt > now + MAX_REMIND_AHEAD_MS) return "Reminders can be set up to two years ahead.";
			out.remindAt = Math.round(r.remindAt);
		} else return "That reminder time couldn't be read.";
	}
	return out;
}

/** True when a note has nothing in it, so a new one left like this needn't be kept. */
export function isEmptyNote(n: Pick<Note, "title" | "body" | "items">): boolean {
	return !n.title.trim() && !n.body.trim() && !n.items.some((i) => i.text.trim());
}

/** Turns text into a checklist (one item a line) or a checklist back into text. */
export function toChecklist(body: string): ChecklistItem[] {
	return body.split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\[[ xX]?\])\s*/, "").trim()).filter(Boolean).slice(0, MAX_ITEMS)
		.map((text, i) => ({ id: `i${i}-${Math.random().toString(36).slice(2, 8)}`, text: text.slice(0, MAX_ITEM_TEXT), done: false }));
}

export function toText(items: ChecklistItem[]): string {
	return items.map((i) => i.text).filter((t) => t.trim()).join("\n");
}

/** The words a note shows as plain text, such as for an email or a search. */
export function noteText(n: Pick<Note, "title" | "body" | "items" | "checklist">): string {
	const content = n.checklist ? n.items.map((i) => `${i.done ? "☑" : "☐"} ${i.text}`).join("\n") : n.body;
	return [n.title.trim(), content.trim()].filter(Boolean).join("\n\n");
}

/** Does a note match a search? Every word must be found in its title, text or checklist. */
export function matchesSearch(n: Pick<Note, "title" | "body" | "items">, q: string): boolean {
	const words = q.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const hay = `${n.title}\n${n.body}\n${n.items.map((i) => i.text).join("\n")}`.toLowerCase();
	return words.every((w) => hay.includes(w));
}

/** Pinned notes first, then the most recently changed. */
export function sortNotes<T extends Pick<Note, "pinned" | "updatedAt">>(notes: T[]): T[] {
	return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * What a reminder notification says. A private note in a mailbox other people use doesn't show its
 * title, since everyone's devices for that mailbox get the notification.
 */
export function reminderWords(n: Pick<Note, "title" | "body" | "items" | "checklist" | "shared">, sharedMailbox: boolean): { title: string; body: string } {
	if (sharedMailbox && !n.shared) return { title: "Note reminder", body: "One of your private notes has a reminder." };
	const first = noteText({ ...n, title: "" }).split("\n").find((l) => l.trim()) ?? "";
	return { title: n.title.trim() || "Note reminder", body: (first || "You asked to be reminded about this note.").slice(0, 140) };
}
