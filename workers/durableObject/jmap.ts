// Mail App 2.6: what JMAP (workers/jmap/) needs from a mailbox, in plain SQL: folders with their counts,
// finding emails, reading them, conversations, and what changed since an app last looked (the change
// numbers from migrations 28 and 29). Changes themselves (read, starred, move, delete) go through the
// mailbox's usual methods, so rules, webhooks and the change log all see them.

import type { EmailFilter, EmailSort } from "../../shared/jmap";

export interface JmapMailbox {
	id: string;
	name: string;
	totalEmails: number;
	unreadEmails: number;
	totalThreads: number;
	unreadThreads: number;
}

export interface JmapEmailRow {
	id: string;
	folder_id: string;
	thread_id: string | null;
	subject: string | null;
	sender: string | null;
	sender_name: string | null;
	recipient: string | null;
	cc: string | null;
	bcc: string | null;
	date: string | null;
	read: boolean;
	starred: boolean;
	body: string | null;
	in_reply_to: string | null;
	email_references: string | null;
	message_id: string | null;
	raw_headers: string | null;
	size: number;
	attachments: { id: string; filename: string; mimetype: string; size: number; content_id: string | null; disposition: string | null }[];
}

export interface JmapChanges {
	created: string[];
	updated: string[];
	destroyed: string[];
	/** Threads whose emails changed: an email added, moved, marked or deleted. */
	threads: { updated: string[]; destroyed: string[] };
	newState: number;
	hasMore: boolean;
}

const MAX_QUERY = 5000;

/** The order to list in, as SQL over the columns of the "m" list in query(). */
function orderBy(sort: EmailSort): string {
	const dir = sort.isAscending ? "ASC" : "DESC";
	switch (sort.property) {
		case "size": return `size ${dir}, date DESC, rid DESC`;
		case "from": return `LOWER(COALESCE(sender_name, sender)) ${dir}, date DESC, rid DESC`;
		case "to": return `LOWER(recipient) ${dir}, date DESC, rid DESC`;
		case "subject": return `LOWER(subject) ${dir}, date DESC, rid DESC`;
		default: return `date ${dir}, rid ${dir}`;
	}
}

/** "%text%" for LIKE, with the LIKE characters escaped. */
const like = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export class JmapStore {
	constructor(private readonly ctx: DurableObjectState) {}

	private get sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	mailboxes(): JmapMailbox[] {
		const rows = [...this.sql.exec(
			`SELECT f.id, f.name,
			        COUNT(e.id) AS total,
			        COALESCE(SUM(CASE WHEN e.read = 0 THEN 1 ELSE 0 END), 0) AS unread,
			        COUNT(DISTINCT COALESCE(e.thread_id, e.id)) AS threads,
			        COUNT(DISTINCT CASE WHEN e.read = 0 THEN COALESCE(e.thread_id, e.id) END) AS unreadThreads
			 FROM folders f LEFT JOIN emails e ON e.folder_id = f.id
			 GROUP BY f.id, f.name`,
		)];
		return rows.map((r) => ({
			id: String(r.id),
			name: String(r.name),
			totalEmails: Number(r.total),
			unreadEmails: Number(r.unread),
			totalThreads: Number(r.threads),
			unreadThreads: Number(r.unreadThreads),
		}));
	}

	/** Changes when folders are added, renamed or removed. Counts are covered by the email state. */
	folderState(): string {
		const rows = [...this.sql.exec(`SELECT id, name FROM folders ORDER BY id`)];
		let h = 5381;
		for (const r of rows) for (const ch of `${r.id}\u0000${r.name}\u0001`) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
		return h.toString(36);
	}

	cursor(): number {
		const row = [...this.sql.exec(`SELECT MAX(seq) AS seq FROM email_changes`)][0];
		return Number(row?.seq ?? 0);
	}

	private floor(): number {
		const row = [...this.sql.exec(`SELECT value FROM sync_meta WHERE key = 'floor'`)][0];
		return Number(row?.value ?? 0);
	}

	query(filter: EmailFilter, sort: EmailSort, position: number, limit: number, collapseThreads: boolean): { ids: string[]; total: number; position: number } {
		const where: string[] = [];
		const args: unknown[] = [];
		const arg = (v: unknown) => { args.push(v); return `?${args.length}`; };
		if (filter.inMailbox) where.push(`e.folder_id = ${arg(filter.inMailbox)}`);
		if (filter.inMailboxOtherThan?.length) where.push(`e.folder_id NOT IN (${filter.inMailboxOtherThan.map(arg).join(",")})`);
		if (filter.before) where.push(`e.date < ${arg(new Date(filter.before).toISOString())}`);
		if (filter.after) where.push(`e.date >= ${arg(new Date(filter.after).toISOString())}`);
		if (filter.hasKeyword === "$seen") where.push(`e.read = 1`);
		if (filter.hasKeyword === "$flagged") where.push(`e.starred = 1`);
		if (filter.hasKeyword === "$draft") where.push(`e.folder_id = 'draft'`);
		if (filter.notKeyword === "$seen") where.push(`e.read = 0`);
		if (filter.notKeyword === "$flagged") where.push(`e.starred = 0`);
		if (filter.notKeyword === "$draft") where.push(`e.folder_id <> 'draft'`);
		if (filter.hasAttachment === true) where.push(`EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = e.id AND COALESCE(a.disposition, 'attachment') <> 'inline')`);
		if (filter.hasAttachment === false) where.push(`NOT EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = e.id AND COALESCE(a.disposition, 'attachment') <> 'inline')`);
		if (filter.from) where.push(`(e.sender LIKE ${arg(like(filter.from))} ESCAPE '\\' OR e.sender_name LIKE ${arg(like(filter.from))} ESCAPE '\\')`);
		if (filter.to) where.push(`e.recipient LIKE ${arg(like(filter.to))} ESCAPE '\\'`);
		if (filter.cc) where.push(`e.cc LIKE ${arg(like(filter.cc))} ESCAPE '\\'`);
		if (filter.bcc) where.push(`e.bcc LIKE ${arg(like(filter.bcc))} ESCAPE '\\'`);
		if (filter.subject) where.push(`e.subject LIKE ${arg(like(filter.subject))} ESCAPE '\\'`);
		if (filter.body) where.push(`e.body LIKE ${arg(like(filter.body))} ESCAPE '\\'`);
		if (filter.text) {
			const t = like(filter.text);
			where.push(`(e.subject LIKE ${arg(t)} ESCAPE '\\' OR e.sender LIKE ${arg(t)} ESCAPE '\\' OR e.sender_name LIKE ${arg(t)} ESCAPE '\\' OR e.recipient LIKE ${arg(t)} ESCAPE '\\' OR e.body LIKE ${arg(t)} ESCAPE '\\')`);
		}
		const size = `(LENGTH(COALESCE(e.body, '')) + COALESCE((SELECT SUM(a.size) FROM attachments a WHERE a.email_id = e.id), 0))`;
		if (filter.minSize != null) where.push(`${size} >= ${arg(filter.minSize)}`);
		if (filter.maxSize != null) where.push(`${size} < ${arg(filter.maxSize)}`);
		const cond = where.length ? `WHERE ${where.join(" AND ")}` : "";

		// Collapsed: one email per conversation, the first in the chosen order.
		const ord = orderBy(sort);
		const list = `WITH m AS (SELECT e.id, e.date, e.rowid AS rid, e.subject, e.sender, e.sender_name, e.recipient, ${size} AS size,
		                     COALESCE(e.thread_id, e.id) AS t FROM emails e ${cond}),
		              r AS (SELECT m.*, ROW_NUMBER() OVER (PARTITION BY t ORDER BY ${ord}) AS n FROM m)
		         SELECT id FROM r ${collapseThreads ? "WHERE n = 1" : ""}`;
		const total = Number([...this.sql.exec(`SELECT COUNT(*) AS n FROM (${list})`, ...args)][0]?.n ?? 0);
		const start = position < 0 ? Math.max(total + position, 0) : position;
		const n = Math.min(Math.max(limit, 0), MAX_QUERY);
		const ids = [...this.sql.exec(`${list} ORDER BY ${ord} LIMIT ${n} OFFSET ${start}`, ...args)].map((r) => String(r.id));
		return { ids, total, position: start };
	}

	getEmails(ids: string[], withBody: boolean): JmapEmailRow[] {
		if (!ids.length) return [];
		const marks = ids.map((_, i) => `?${i + 1}`).join(",");
		const rows = [...this.sql.exec(
			`SELECT id, folder_id, thread_id, subject, sender, sender_name, recipient, cc, bcc, date, read, starred,
			        ${withBody ? "body" : "SUBSTR(body, 1, 4000) AS body"}, in_reply_to, email_references, message_id, raw_headers,
			        LENGTH(COALESCE(body, '')) AS body_size
			 FROM emails WHERE id IN (${marks})`,
			...ids,
		)];
		const atts = [...this.sql.exec(`SELECT id, email_id, filename, mimetype, size, content_id, disposition FROM attachments WHERE email_id IN (${marks})`, ...ids)];
		const byEmail = new Map<string, JmapEmailRow["attachments"]>();
		for (const a of atts) {
			const list = byEmail.get(String(a.email_id)) ?? [];
			list.push({ id: String(a.id), filename: String(a.filename), mimetype: String(a.mimetype), size: Number(a.size), content_id: a.content_id == null ? null : String(a.content_id), disposition: a.disposition == null ? null : String(a.disposition) });
			byEmail.set(String(a.email_id), list);
		}
		const s = (v: unknown) => (v == null ? null : String(v));
		return rows.map((r) => {
			const attachments = byEmail.get(String(r.id)) ?? [];
			return {
				id: String(r.id), folder_id: String(r.folder_id), thread_id: s(r.thread_id), subject: s(r.subject),
				sender: s(r.sender), sender_name: s(r.sender_name), recipient: s(r.recipient), cc: s(r.cc), bcc: s(r.bcc),
				date: s(r.date), read: !!r.read, starred: !!r.starred, body: s(r.body), in_reply_to: s(r.in_reply_to),
				email_references: s(r.email_references), message_id: s(r.message_id), raw_headers: s(r.raw_headers),
				size: Number(r.body_size) + attachments.reduce((n, a) => n + a.size, 0),
				attachments,
			};
		});
	}

	/** The emails in each conversation, oldest first. Conversations with none left are missing. */
	threads(threadIds: string[]): Record<string, string[]> {
		const out: Record<string, string[]> = {};
		if (!threadIds.length) return out;
		const marks = threadIds.map((_, i) => `?${i + 1}`).join(",");
		const rows = [...this.sql.exec(
			`SELECT id, COALESCE(thread_id, id) AS t FROM emails WHERE COALESCE(thread_id, id) IN (${marks}) ORDER BY date ASC, rowid ASC`,
			...threadIds,
		)];
		for (const r of rows) (out[String(r.t)] ??= []).push(String(r.id));
		return out;
	}

	/** What changed after change number `since`. "gone" when it's too old to answer. */
	changes(since: number, max: number): JmapChanges | "gone" {
		if (since < this.floor()) return "gone";
		const n = Math.min(Math.max(max, 1), 1000);
		const rows = [...this.sql.exec(
			`SELECT c.seq, c.email_id, e.id AS here, COALESCE(e.thread_id, e.id) AS thread, COALESCE(b.seq, 0) AS born
			 FROM email_changes c LEFT JOIN emails e ON e.id = c.email_id LEFT JOIN email_born b ON b.email_id = c.email_id
			 WHERE c.seq > ?1 ORDER BY c.seq LIMIT ?2`,
			since, n + 1,
		)];
		const hasMore = rows.length > n;
		const page = rows.slice(0, n);
		const created: string[] = [];
		const updated: string[] = [];
		const destroyed: string[] = [];
		const threadSet = new Set<string>();
		for (const r of page) {
			const id = String(r.email_id);
			if (!r.here) {
				// Added and deleted while the app was away: it never knew about it.
				destroyed.push(id);
				continue;
			}
			threadSet.add(String(r.thread));
			if (Number(r.born) > since) created.push(id);
			else updated.push(id);
		}
		// A deleted email's conversation: still there if other emails are left, gone if not.
		const threads = [...threadSet];
		return {
			created, updated, destroyed,
			threads: { updated: threads, destroyed: [] },
			newState: page.length ? Number(page[page.length - 1].seq) : Math.max(since, this.cursor()),
			hasMore,
		};
	}
}
