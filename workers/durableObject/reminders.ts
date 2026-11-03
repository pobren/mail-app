// Mail App, 2026: snooze and "Remind me if no reply" (see shared/reminders.ts). Snoozing moves a
// conversation's messages into the Snoozed folder; when it's due they go back to the Inbox, at the top
// and unread. A "no-reply" reminder leaves the sent email in Sent; when it's due and nobody has
// answered, the conversation shows in the Inbox too (see inReminderInbox) until it's dealt with. New
// mail in a conversation wakes a snooze early and ends a "no-reply" reminder. Due times are checked
// from the Durable Object's alarm, shared with backups, calendar reminders and webhook retries.

import { Folders } from "../../shared/folders";
import type { ReminderInfo, ReminderKind } from "../../shared/reminders";

const THREAD_KEY_SQL = "COALESCE(thread_id, id)";

/**
 * SQL for "this message is in the folder ?1", which in the Inbox also takes in sent emails whose "no
 * reply" reminder is due. `t` is the emails table's alias, or "" for none.
 */
export function inFolderSql(t = ""): string {
	const p = t ? `${t}.` : "";
	return `(${p}folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
		OR (?1 = '${Folders.INBOX}' AND ${p}folder_id = '${Folders.SENT}'
			AND COALESCE(${p}thread_id, ${p}id) IN (SELECT thread_key FROM reminders WHERE kind = 'no-reply' AND shown = 1)))`;
}

export class Reminders {
	constructor(private ctx: DurableObjectState) {}

	private get sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	private async book(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || at < current) await this.ctx.storage.setAlarm(at);
	}

	private keyOf(emailId: string): { key: string; folder: string } | null {
		const row = [...this.sql.exec(`SELECT ${THREAD_KEY_SQL} AS k, folder_id FROM emails WHERE id = ?1`, emailId)][0];
		return row ? { key: String(row.k), folder: String(row.folder_id) } : null;
	}

	/**
	 * Snoozes the conversations shown by these messages until `until`: their messages in `fromFolder`
	 * (the folder being looked at, or the message's own) go to Snoozed. Returns how many it snoozed.
	 */
	async snooze(ids: string[], until: number, fromFolder?: string): Promise<number> {
		let count = 0;
		const now = Date.now();
		this.ctx.storage.transactionSync(() => {
			for (const id of ids) {
				const anchor = this.keyOf(id);
				if (!anchor) continue;
				const from = fromFolder ?? anchor.folder;
				if (from === Folders.DRAFT || from === Folders.TRASH || from === Folders.SPAM) continue;
				if (from !== Folders.SNOOZED) {
					this.sql.exec(`UPDATE emails SET folder_id = ?3 WHERE ${THREAD_KEY_SQL} = ?1 AND folder_id = ?2`, anchor.key, from, Folders.SNOOZED);
				}
				// Snoozing a "no reply" reminder that's back in the Inbox puts it off instead.
				this.sql.exec(`DELETE FROM reminders WHERE thread_key = ?1 AND kind = 'no-reply' AND shown = 1`, anchor.key);
				if (![...this.sql.exec(`SELECT 1 FROM emails WHERE ${THREAD_KEY_SQL} = ?1 AND folder_id = ?2 LIMIT 1`, anchor.key, Folders.SNOOZED)].length) continue;
				this.sql.exec(
					`INSERT OR REPLACE INTO reminders (thread_key, kind, due_at, email_id, shown, created_at) VALUES (?1, 'snooze', ?2, NULL, 0, ?3)`,
					anchor.key, until, now,
				);
				count++;
			}
		});
		if (count) await this.book(until);
		return count;
	}

	/** Brings snoozed conversations back to the Inbox now. */
	unsnooze(ids: string[]): void {
		this.ctx.storage.transactionSync(() => {
			for (const id of ids) {
				const anchor = this.keyOf(id);
				if (anchor) this.#wake(anchor.key, new Date().toISOString(), false);
			}
		});
	}

	/** Snoozed messages back to the Inbox, at the top; `unread` marks the newest one unread. */
	#wake(key: string, at: string, unread: boolean): void {
		const latest = [...this.sql.exec(
			`SELECT id FROM emails WHERE ${THREAD_KEY_SQL} = ?1 AND folder_id = ?2 ORDER BY date DESC LIMIT 1`,
			key, Folders.SNOOZED,
		)][0];
		this.sql.exec(`UPDATE emails SET folder_id = ?3, back_at = ?4 WHERE ${THREAD_KEY_SQL} = ?1 AND folder_id = ?2`, key, Folders.SNOOZED, Folders.INBOX, at);
		if (unread && latest) this.sql.exec(`UPDATE emails SET read = 0 WHERE id = ?1`, String(latest.id));
		this.sql.exec(`DELETE FROM reminders WHERE thread_key = ?1 AND kind = 'snooze'`, key);
	}

	/** "Remind me if no reply": brings the sent email's conversation back to the Inbox at `at` if nobody answers. */
	async remindIfNoReply(emailId: string, at: number): Promise<boolean> {
		const anchor = this.keyOf(emailId);
		if (!anchor) return false;
		this.sql.exec(
			`INSERT OR REPLACE INTO reminders (thread_key, kind, due_at, email_id, shown, created_at) VALUES (?1, 'no-reply', ?2, ?3, 0, ?4)`,
			anchor.key, at, emailId, Date.now(),
		);
		await this.book(at);
		return true;
	}

	/** Ends a conversation's reminder of this kind (Cancel, or Done once it's back). */
	cancel(emailId: string, kind: ReminderKind): void {
		const anchor = this.keyOf(emailId);
		if (!anchor) return;
		if (kind === "snooze") this.unsnooze([emailId]);
		else this.sql.exec(`DELETE FROM reminders WHERE thread_key = ?1 AND kind = 'no-reply'`, anchor.key);
	}

	/** A conversation's reminders, for the open email. */
	forThread(key: string): ReminderInfo[] {
		return [...this.sql.exec(`SELECT kind, due_at, shown FROM reminders WHERE thread_key = ?1`, key)].map((r) => ({
			kind: String(r.kind) as ReminderKind,
			due_at: Number(r.due_at),
			shown: !!r.shown,
		}));
	}

	/**
	 * A new message in a conversation (called once it's saved): mail coming in to the Inbox wakes a snooze early, and
	 * any new message other than the reminder's own email ends a "no-reply" reminder, as someone replied
	 * or you've followed it up.
	 */
	onNewMessage(threadKey: string, emailId: string, folderId: string): void {
		if (folderId === Folders.DRAFT || folderId === Folders.SPAM) return;
		if (folderId === Folders.INBOX &&
			[...this.sql.exec(`SELECT 1 FROM reminders WHERE thread_key = ?1 AND kind = 'snooze'`, threadKey)].length) {
			this.#wake(threadKey, new Date().toISOString(), true);
		}
		this.sql.exec(`DELETE FROM reminders WHERE thread_key = ?1 AND kind = 'no-reply' AND COALESCE(email_id, '') != ?2`, threadKey, emailId);
	}

	/**
	 * After the list's tick boxes or the Archive button moved or deleted a conversation: a "no-reply"
	 * reminder that was back in the Inbox has been dealt with, and a snooze with nothing left in Snoozed
	 * has nothing to bring back.
	 */
	afterChange(key: string, fromFolder: string): void {
		if (fromFolder === Folders.INBOX) this.sql.exec(`DELETE FROM reminders WHERE thread_key = ?1 AND kind = 'no-reply' AND shown = 1`, key);
		if (![...this.sql.exec(`SELECT 1 FROM emails WHERE ${THREAD_KEY_SQL} = ?1 AND folder_id = ?2 LIMIT 1`, key, Folders.SNOOZED)].length) {
			this.sql.exec(`DELETE FROM reminders WHERE thread_key = ?1 AND kind = 'snooze'`, key);
		}
	}

	nextDue(): number | null {
		const row = [...this.sql.exec(`SELECT MIN(due_at) AS at FROM reminders WHERE shown = 0`)][0];
		return row?.at == null ? null : Number(row.at);
	}

	/** From the alarm: brings back everything that's due. */
	onAlarm(now = Date.now()): void {
		const due = [...this.sql.exec(`SELECT thread_key, kind, email_id FROM reminders WHERE shown = 0 AND due_at <= ?1 LIMIT 200`, now)];
		if (!due.length) return;
		const at = new Date(now).toISOString();
		this.ctx.storage.transactionSync(() => {
			for (const r of due) {
				const key = String(r.thread_key);
				if (r.kind === "snooze") {
					this.#wake(key, at, true);
					continue;
				}
				const emailId = r.email_id == null ? "" : String(r.email_id);
				if (!emailId || ![...this.sql.exec(`SELECT 1 FROM emails WHERE id = ?1`, emailId)].length) {
					this.sql.exec(`DELETE FROM reminders WHERE thread_key = ?1 AND kind = 'no-reply'`, key);
					continue;
				}
				this.sql.exec(`UPDATE reminders SET shown = 1 WHERE thread_key = ?1 AND kind = 'no-reply'`, key);
				this.sql.exec(`UPDATE emails SET back_at = ?2 WHERE id = ?1`, emailId, at);
			}
		});
	}
}
