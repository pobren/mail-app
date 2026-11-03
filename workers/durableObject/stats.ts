// Mail App, 2026: the mailbox's side of Admin > Reports (see shared/reports.ts). A tally per day of mail
// that arrived, was sent, couldn't be sent or was caught as spam (and why), plus the last few sends that
// failed. Only counts are kept, apart from the failed sends' addresses, which go after 90 days. Days from
// before this tally began are worked out from the mail still in the mailbox.

import { Folders } from "../../shared/folders";
import { reasonFromHeaders } from "../../shared/spam-checks";
import { MAX_FIND_ROWS, likeAnywhere, type CountKind, type FoundEmail, type MailboxCounts } from "../../shared/reports";
import type { Files } from "./files";

const KEEP_DAYS = 400;
const KEEP_FAILURES = 50;
const FAILURE_DAYS = 90;

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export class MailStats {
	constructor(private readonly ctx: DurableObjectState) {}

	private get sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	count(kinds: CountKind[], now = Date.now()) {
		const day = today(now);
		for (const kind of kinds) {
			this.sql.exec(`INSERT INTO daily_counts (day, kind, n) VALUES (?1, ?2, 1) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1`, day, kind);
		}
		this.sql.exec(`DELETE FROM daily_counts WHERE day < ?1 AND kind != 'start'`, today(now - KEEP_DAYS * 86_400_000));
	}

	failed(recipient: string, error: string, now = Date.now()) {
		this.count(["failed"], now);
		this.sql.exec(`INSERT INTO send_failures (at, recipient, error) VALUES (?1, ?2, ?3)`, now, recipient.slice(0, 500), error.slice(0, 300));
		this.sql.exec(`DELETE FROM send_failures WHERE at < ?1 OR rowid NOT IN (SELECT rowid FROM send_failures ORDER BY at DESC LIMIT ${KEEP_FAILURES})`, now - FAILURE_DAYS * 86_400_000);
	}

	/** Everything Reports needs from this mailbox, from `since` ("2026-10-01") to today. */
	report(since: string, files: Files): MailboxCounts {
		const sql = this.sql;
		const start = [...sql.exec(`SELECT day FROM daily_counts WHERE kind = 'start' ORDER BY day LIMIT 1`)][0] as { day: string } | undefined;
		const countingSince = start?.day ?? today();
		const counted = [...sql.exec(`SELECT day, kind, n FROM daily_counts WHERE day >= ?1 AND kind != 'start'`, since)]
			.map((r) => ({ day: String(r.day), kind: String(r.kind) as CountKind, n: Number(r.n) || 0 }));
		// Before the tally began: what's still in the mailbox, by the day it arrived or went.
		const estimated = since < countingSince ? [...sql.exec(
			`SELECT substr(date, 1, 10) AS day,
			        SUM(CASE WHEN folder_id = ?3 THEN 1 ELSE 0 END) AS sent,
			        SUM(CASE WHEN folder_id = ?4 THEN 1 ELSE 0 END) AS spam,
			        SUM(CASE WHEN folder_id NOT IN (?3, ?5, ?6) THEN 1 ELSE 0 END) AS received
			   FROM emails WHERE substr(date, 1, 10) >= ?1 AND substr(date, 1, 10) < ?2 GROUP BY day`,
			since, countingSince, Folders.SENT, Folders.SPAM, Folders.DRAFT, Folders.SCHEDULED,
		)].map((r) => ({ day: String(r.day), received: Number(r.received) || 0, sent: Number(r.sent) || 0, spam: Number(r.spam) || 0 })) : [];
		const failures = [...sql.exec(`SELECT at, recipient, error FROM send_failures WHERE at >= ?1 ORDER BY at DESC LIMIT 20`, Date.parse(`${since}T00:00:00Z`))]
			.map((r) => ({ at: new Date(Number(r.at)).toISOString(), to: String(r.recipient), error: String(r.error) }));
		const spamSenders = [...sql.exec(
			`SELECT lower(sender) AS sender, COUNT(*) AS n FROM emails WHERE folder_id = ?1 AND substr(date, 1, 10) >= ?2 AND sender != '' GROUP BY lower(sender) ORDER BY n DESC LIMIT 5`,
			Folders.SPAM, since,
		)].map((r) => ({ sender: String(r.sender), count: Number(r.n) || 0 }));
		const one = (q: string) => Number(([...sql.exec(q)][0] as { n?: number } | undefined)?.n ?? 0) || 0;
		return {
			countingSince,
			counted,
			estimated,
			failures,
			spamSenders,
			storage: {
				database: sql.databaseSize,
				attachments: one(`SELECT COALESCE(SUM(size), 0) AS n FROM attachments`),
				files: files.usage().bytes,
				backups: one(`SELECT COALESCE(SUM(size), 0) AS n FROM backups WHERE status = 'done'`),
			},
		};
	}

	/**
	 * Admin > Reports > Find an email: mail to or from an address (or with words in its subject) since
	 * `since`, and what happened to it. Drafts are left out. No message text leaves the mailbox.
	 */
	find(q: string, since: string, mailbox: string): FoundEmail[] {
		const sql = this.sql;
		const like = likeAnywhere(q);
		const folders = new Map([...sql.exec(`SELECT id, name FROM folders`)].map((r) => [String(r.id), String(r.name)]));
		const rows = [...sql.exec(
			`SELECT id, date, folder_id, sender, recipient, cc, subject, raw_headers FROM emails
			  WHERE substr(date, 1, 10) >= ?1 AND folder_id != ?2
			    AND (lower(sender) LIKE ?3 ESCAPE '\\' OR lower(COALESCE(sender_name, '')) LIKE ?3 ESCAPE '\\'
			      OR lower(recipient) LIKE ?3 ESCAPE '\\' OR lower(COALESCE(cc, '')) LIKE ?3 ESCAPE '\\'
			      OR lower(COALESCE(subject, '')) LIKE ?3 ESCAPE '\\')
			  ORDER BY date DESC LIMIT ${MAX_FIND_ROWS + 1}`,
			since, Folders.DRAFT, like,
		)];
		const found: FoundEmail[] = rows.map((r) => {
			const folder = String(r.folder_id);
			const base = { at: String(r.date), mailbox, id: String(r.id), folderId: folder, from: String(r.sender ?? ""), to: [r.recipient, r.cc].filter(Boolean).join(", "), subject: String(r.subject ?? "") };
			if (folder === Folders.SENT) return { ...base, status: "sent" };
			if (folder === Folders.SCHEDULED) return { ...base, status: "scheduled" };
			if (folder === Folders.TRASH) return { ...base, status: "bin" };
			if (folder === Folders.SPAM) {
				const why = reasonFromHeaders(r.raw_headers as string | null);
				return { ...base, status: "spam", ...(why.length ? { why } : {}) };
			}
			return { ...base, status: "delivered", ...(folder !== Folders.INBOX ? { folder: folders.get(folder) ?? folder } : {}) };
		});
		// Sends that failed never reach Sent, so they're only here.
		for (const r of sql.exec(
			`SELECT at, recipient, error FROM send_failures WHERE at >= ?1 AND (lower(recipient) LIKE ?2 ESCAPE '\\' OR lower(error) LIKE ?2 ESCAPE '\\') ORDER BY at DESC LIMIT 50`,
			Date.parse(`${since}T00:00:00Z`), like,
		)) {
			found.push({ at: new Date(Number(r.at)).toISOString(), mailbox, from: mailbox, to: String(r.recipient), subject: "", status: "failed", error: String(r.error) });
		}
		return found;
	}
}
