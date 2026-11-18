// Mail App, 2026: keeping another app in step with a mailbox, for the Outlook bridge and anything else
// that syncs over the API. Triggers (migration 28) note every email that's added, moved, marked read or
// unread, starred or deleted, with a number that only goes up. An app keeps the last number it saw and asks
// for what changed since, instead of reading whole folders again. Each email keeps one row (its newest
// change), so the table never grows past the size of the mailbox plus recent deletions.
//
// Deleted emails also leave their id in raw_gone, so the original copy kept in R2 (raw/<id>.eml) can be
// removed however the email was deleted: from the app, the API, a rule, or auto-empty.

import type { Env } from "../types";

/** How long a deleted email's row is kept. An app that's been away longer starts again from scratch. */
export const KEEP_DELETED_DAYS = 30;
/** Most changes in one answer. */
export const MAX_CHANGES = 1000;
/** Most emails in one page of a folder's list. */
export const MAX_INDEX = 5000;

export interface EmailChange {
	id: string;
	/** Where it is now, or null once deleted. */
	folder: string | null;
	read: boolean;
	starred: boolean;
	deleted: boolean;
}

export interface IndexEntry {
	id: string;
	read: boolean;
	starred: boolean;
	date: string | null;
	message_id: string | null;
}

/** Where the original of an email is kept. */
export const rawKey = (emailId: string) => `raw/${emailId}.eml`;

export class Sync {
	constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

	private get sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	/** The newest change number. */
	cursor(): number {
		const row = [...this.sql.exec(`SELECT MAX(seq) AS seq FROM email_changes`)][0];
		return Number(row?.seq ?? 0);
	}

	/** The oldest number an app can still ask from. Anything older has lost deletions, so it must start again. */
	private floor(): number {
		const row = [...this.sql.exec(`SELECT value FROM sync_meta WHERE key = 'floor'`)][0];
		return Number(row?.value ?? 0);
	}

	/** Forgets deletions older than KEEP_DELETED_DAYS, raising the floor past them. */
	private prune(now = Date.now()) {
		const cutoff = now - KEEP_DELETED_DAYS * 86_400_000;
		const old = [...this.sql.exec(
			`SELECT MAX(c.seq) AS seq FROM email_changes c LEFT JOIN emails e ON e.id = c.email_id WHERE e.id IS NULL AND c.at < ?1`, cutoff,
		)][0];
		const top = Number(old?.seq ?? 0);
		if (!top) return;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(`DELETE FROM email_changes WHERE seq <= ?1 AND email_id NOT IN (SELECT id FROM emails)`, top);
			this.sql.exec(`INSERT INTO sync_meta (key, value) VALUES ('floor', ?1) ON CONFLICT(key) DO UPDATE SET value = MAX(value, ?1)`, top);
		});
	}

	/** What changed after `since`, oldest first. "gone" when `since` is too old to answer. */
	changes(since: number, limit = MAX_CHANGES): { changes: EmailChange[]; cursor: number; more: boolean } | "gone" {
		this.prune();
		if (since < this.floor()) return "gone";
		const n = Math.min(Math.max(limit, 1), MAX_CHANGES);
		const rows = [...this.sql.exec(
			`SELECT c.seq, c.email_id, e.id AS here, e.folder_id, e.read, e.starred
			 FROM email_changes c LEFT JOIN emails e ON e.id = c.email_id
			 WHERE c.seq > ?1 ORDER BY c.seq LIMIT ?2`, since, n + 1,
		)];
		const more = rows.length > n;
		const page = rows.slice(0, n);
		return {
			changes: page.map((r) => ({
				id: String(r.email_id),
				folder: r.here ? String(r.folder_id) : null,
				read: !!r.read,
				starred: !!r.starred,
				deleted: !r.here,
			})),
			cursor: page.length ? Number(page[page.length - 1].seq) : Math.max(since, this.cursor()),
			more,
		};
	}

	/** Every email in a folder, oldest first, with just enough to list it. Paged by `after` (an index). */
	index(folder: string, offset = 0, limit = MAX_INDEX): { emails: IndexEntry[]; more: boolean } {
		const n = Math.min(Math.max(limit, 1), MAX_INDEX);
		const rows = [...this.sql.exec(
			`SELECT id, read, starred, date, message_id FROM emails WHERE folder_id = ?1 ORDER BY date ASC, rowid ASC LIMIT ?2 OFFSET ?3`,
			folder, n + 1, Math.max(offset, 0),
		)];
		return {
			emails: rows.slice(0, n).map((r) => ({
				id: String(r.id), read: !!r.read, starred: !!r.starred,
				date: r.date == null ? null : String(r.date), message_id: r.message_id == null ? null : String(r.message_id),
			})),
			more: rows.length > n,
		};
	}

	/** Removes the kept originals of deleted emails from R2. Safe to call often: it's quick when there's nothing to do. */
	async sweepRaw(): Promise<number> {
		let total = 0;
		for (;;) {
			const ids = [...this.sql.exec(`SELECT email_id FROM raw_gone LIMIT 1000`)].map((r) => String(r.email_id));
			if (!ids.length) break;
			await this.env.BUCKET.delete(ids.map(rawKey));
			const marks = ids.map((_, i) => `?${i + 1}`).join(",");
			this.sql.exec(`DELETE FROM raw_gone WHERE email_id IN (${marks})`, ...ids);
			total += ids.length;
			if (ids.length < 1000) break;
		}
		return total;
	}
}
