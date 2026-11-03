// Mail App addition (not part of upstream Agentic Inbox).
// Admin > Reports: email, spam, storage and activity over the last 7, 30 or 90 days. Each mailbox keeps
// a daily tally (workers/durableObject/stats.ts); days from before the tally began are worked out from
// the mail still in the mailbox, so they can be a little low. The sums are worked out here, so the page,
// the CSV download and the tests agree.

import type { LogEntry } from "./people";
import type { StoredReason } from "./spam-checks";

export const REPORT_DAYS = [7, 30, 90] as const;
export const DEFAULT_REPORT_DAYS = 30;

export type SpamWhy = "blocked" | "dmarc-fail" | "checks" | "rule";
export const SPAM_WHYS: SpamWhy[] = ["checks", "blocked", "dmarc-fail", "rule"];
export type CountKind = "received" | "sent" | "failed" | "not-spam" | `spam:${SpamWhy}`;

/** What one mailbox sends back for a report. */
export interface MailboxCounts {
	/** The first day of the tally ("2026-10-29"). */
	countingSince: string;
	counted: { day: string; kind: CountKind; n: number }[];
	/** Days before the tally began, from the mail still in the mailbox. */
	estimated: { day: string; received: number; sent: number; spam: number }[];
	/** The latest sends that failed, newest first. */
	failures: { at: string; to: string; error: string }[];
	/** Who sent the most mail now in Spam. */
	spamSenders: { sender: string; count: number }[];
	/** Bytes. The database is the mailbox's own (email text, calendars, notes); the rest are in R2. */
	storage: { database: number; attachments: number; files: number; backups: number };
}

export interface MailboxReport extends MailboxCounts {
	mailbox: string;
	shared: boolean;
}

export interface PersonActivity {
	email: string;
	name: string;
	role: "admin" | "member";
	status: string;
	lastSeenAt: string | null;
	invitedAt: string;
}

export interface ReportsAnswer {
	days: number;
	/** The first and last day covered, inclusive. */
	from: string;
	to: string;
	mailboxes: MailboxReport[];
	/** Mailboxes that couldn't be read just now. */
	unreadable: string[];
	people: PersonActivity[];
	/** Admins opening other people's mailboxes, and access given or taken away, newest first. */
	log: LogEntry[];
}

export function reportDays(raw: unknown): number {
	const n = Number(raw);
	return (REPORT_DAYS as readonly number[]).includes(n) ? n : DEFAULT_REPORT_DAYS;
}

/** The days a report covers, oldest first ("2026-10-01" … today). */
export function dayList(days: number, now = Date.now()): string[] {
	const out: string[] = [];
	for (let i = days - 1; i >= 0; i--) out.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
	return out;
}

export interface DayTotals {
	received: number;
	sent: number;
	failed: number;
	spam: number;
}

const zero = (): DayTotals => ({ received: 0, sent: 0, failed: 0, spam: 0 });

/** Each day's totals for one mailbox, for the days given. */
export function mailboxDays(m: MailboxCounts, days: string[]): Map<string, DayTotals> {
	const out = new Map(days.map((d) => [d, zero()]));
	for (const e of m.estimated) {
		const t = out.get(e.day);
		if (t) { t.received += e.received; t.sent += e.sent; t.spam += e.spam; }
	}
	for (const c of m.counted) {
		const t = out.get(c.day);
		if (!t) continue;
		if (c.kind === "received") t.received += c.n;
		else if (c.kind === "sent") t.sent += c.n;
		else if (c.kind === "failed") t.failed += c.n;
		else if (c.kind.startsWith("spam:")) t.spam += c.n;
	}
	return out;
}

export function sumDays(maps: Map<string, DayTotals>[], days: string[]): { day: string; totals: DayTotals }[] {
	return days.map((day) => {
		const totals = zero();
		for (const m of maps) {
			const t = m.get(day);
			if (t) { totals.received += t.received; totals.sent += t.sent; totals.failed += t.failed; totals.spam += t.spam; }
		}
		return { day, totals };
	});
}

export function total(rows: { totals: DayTotals }[]): DayTotals {
	return rows.reduce((acc, r) => ({
		received: acc.received + r.totals.received, sent: acc.sent + r.totals.sent,
		failed: acc.failed + r.totals.failed, spam: acc.spam + r.totals.spam,
	}), zero());
}

/** Spam caught by reason, and "Not spam" presses, from the tally only (older mail doesn't say why). */
export function spamReasons(mailboxes: MailboxCounts[], days: string[]): { why: Record<SpamWhy, number>; notSpam: number } {
	const inRange = new Set(days);
	const why = { checks: 0, blocked: 0, "dmarc-fail": 0, rule: 0 } as Record<SpamWhy, number>;
	let notSpam = 0;
	for (const m of mailboxes) for (const c of m.counted) {
		if (!inRange.has(c.day)) continue;
		if (c.kind === "not-spam") notSpam += c.n;
		else if (c.kind.startsWith("spam:")) {
			const w = c.kind.slice(5) as SpamWhy;
			if (w in why) why[w] += c.n;
		}
	}
	return { why, notSpam };
}

/** The top spam senders across every mailbox. */
export function topSpamSenders(mailboxes: MailboxCounts[], limit = 5): { sender: string; count: number }[] {
	const all = new Map<string, number>();
	for (const m of mailboxes) for (const s of m.spamSenders) all.set(s.sender, (all.get(s.sender) ?? 0) + s.count);
	return [...all].map(([sender, count]) => ({ sender, count })).sort((a, b) => b.count - a.count || a.sender.localeCompare(b.sender)).slice(0, limit);
}

/** Did any day in the report come from before the tally began? Then the figures may be a little low. */
export function hasEstimates(mailboxes: MailboxCounts[], from: string): boolean {
	return mailboxes.some((m) => m.countingSince > from);
}

// ── Find an email ─────────────────────────────────────────────────

/** The shortest search that's run, so a stray letter doesn't pull back every email. */
export const MIN_FIND = 3;
export const MAX_FIND_ROWS = 100;

export type FoundStatus = "delivered" | "spam" | "bin" | "sent" | "scheduled" | "failed";
/** Statuses that mean something went wrong, for "Problems only". */
export const PROBLEM_STATUSES: FoundStatus[] = ["spam", "failed"];

/** One email (or failed send) a search found. No message text, only who, when, the subject and what happened. */
export interface FoundEmail {
	at: string;
	mailbox: string;
	/** The email itself and the folder it's in, so it can be opened. Not there for sends that failed. */
	id?: string;
	folderId?: string;
	from: string;
	to: string;
	subject: string;
	status: FoundStatus;
	/** The folder it's in, when it was delivered somewhere other than the Inbox. */
	folder?: string;
	/** Why it went to Spam, when we know. */
	why?: { check: StoredReason; detail?: string }[];
	/** Why it couldn't be sent. */
	error?: string;
}

export interface FindAnswer {
	q: string;
	days: number;
	found: FoundEmail[];
	/** More matched than are shown. */
	more: boolean;
	unreadable: string[];
	/** Each mailbox found in: its id, whether this admin can open it now, and who uses it (opening it otherwise is logged). */
	mailboxes: Record<string, { id: string; canOpen: boolean; people: string[] }>;
}

/** The search as typed, tidied: lower case, single spaces, "<" and ">" from a pasted address taken off. */
export function cleanFind(raw: unknown): string {
	return typeof raw === "string" ? raw.replace(/[<>"]/g, " ").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200) : "";
}

/** A LIKE pattern that matches the text anywhere, with % and _ in it taken literally (ESCAPE '\'). */
export function likeAnywhere(q: string): string {
	return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function isProblem(f: FoundEmail): boolean {
	return PROBLEM_STATUSES.includes(f.status);
}

/** Every mailbox's finds as one list, newest first. */
export function mergeFound(lists: FoundEmail[][], limit = MAX_FIND_ROWS): { found: FoundEmail[]; more: boolean } {
	const all = lists.flat().sort((a, b) => b.at.localeCompare(a.at));
	return { found: all.slice(0, limit), more: all.length > limit };
}

// ── Storage ───────────────────────────────────────────────────────

const GB = 1024 ** 3;
/** Cloudflare's prices (US dollars a month), checked October 2026. */
export const STORAGE_PRICES = {
	/** R2: attachments, Files and backups. The first 10 GB each month are free. */
	r2: { freeGb: 10, perGb: 0.015 },
	/** Durable Objects (SQLite): each mailbox's email text, calendars and notes. 5 GB included. */
	database: { freeGb: 5, perGb: 0.2 },
};

export function storageTotals(mailboxes: MailboxCounts[]) {
	const sum = (k: keyof MailboxCounts["storage"]) => mailboxes.reduce((s, m) => s + (m.storage[k] || 0), 0);
	return { database: sum("database"), attachments: sum("attachments"), files: sum("files"), backups: sum("backups") };
}

/**
 * Roughly what this storage costs on the Cloudflare bill each month, in whole US dollars (0 when it's
 * inside what Cloudflare includes). Other apps on the same Cloudflare account share the free allowance.
 */
export function storageCost(t: ReturnType<typeof storageTotals>): { dollars: number; r2Gb: number; databaseGb: number } {
	const r2Gb = (t.attachments + t.files + t.backups) / GB;
	const databaseGb = t.database / GB;
	const cost = Math.max(0, r2Gb - STORAGE_PRICES.r2.freeGb) * STORAGE_PRICES.r2.perGb
		+ Math.max(0, databaseGb - STORAGE_PRICES.database.freeGb) * STORAGE_PRICES.database.perGb;
	return { dollars: cost > 0 ? Math.ceil(cost) : 0, r2Gb, databaseGb };
}

/** "12 KB", "3.4 MB", "1.2 GB". */
export function formatBytes(n: number): string {
	if (n < 1024) return `${Math.round(n)} bytes`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
	return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

// ── CSV ───────────────────────────────────────────────────────────

const cell = (v: string | number) => {
	const s = String(v);
	// A leading = + - @ would run as a formula in a spreadsheet.
	const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
	return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** One row per mailbox per day: what the Email and Spam tabs show, for a spreadsheet. */
export function reportCsv(answer: ReportsAnswer, now = Date.now()): string {
	const days = dayList(answer.days, now);
	const rows = [["Date", "Mailbox", "Received", "Sent", "Couldn't send", "Spam"].map(cell).join(",")];
	for (const m of answer.mailboxes) {
		const map = mailboxDays(m, days);
		for (const d of days) {
			const t = map.get(d)!;
			rows.push([d, m.mailbox, t.received, t.sent, t.failed, t.spam].map(cell).join(","));
		}
	}
	return `${rows.join("\n")}\n`;
}
