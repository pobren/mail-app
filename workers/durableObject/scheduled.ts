// Mail App, 2026: scheduled send, the mailbox's side (see shared/scheduled.ts). Each row is an email in
// the Scheduled folder and when it goes. The alarm (shared with backups, reminders and the rest) sends
// what's due: it moves to Sent, dated when it went. One that Cloudflare refuses goes to Drafts and
// the mailbox's devices are told why. An email taken out of Scheduled (deleted, say) is simply dropped.

import { Folders } from "../../shared/folders";
import { SEND_LATE_MS, failedWords, scheduledKey } from "../../shared/scheduled";
import { sendFailureText } from "../../shared/sending";
import { emitEvent } from "../lib/api";
import { notifyDevices } from "../lib/push";
import type { ScheduledPayload } from "../lib/scheduled-send";
import { sendTracked } from "../lib/sending";
import type { Env } from "../types";
import type { MailStats } from "./stats";

/** What the alarm needs from the rest of the mailbox. */
export interface SendHost {
	checkSendRateLimit(recipients?: number): Promise<string | null>;
	remindIfNoReply(emailId: string, at: number): Promise<boolean>;
}

/** How long to wait before trying again when the sending limit is reached. */
const LIMIT_RETRY_MS = 15 * 60_000;

export class ScheduledSends {
	constructor(private readonly ctx: DurableObjectState, private readonly env: Env, private readonly tally?: MailStats) {}

	private get sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	private async book(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		const when = Math.max(at, Date.now() + 100);
		if (current === null || when < current) await this.ctx.storage.setAlarm(when);
	}

	/** Books an email (already filed in Scheduled) to go at `sendAt`. */
	async schedule(mailbox: string, emailId: string, sendAt: number): Promise<void> {
		this.sql.exec(
			`INSERT OR REPLACE INTO scheduled_sends (email_id, mailbox, send_at, created_at) VALUES (?1, ?2, ?3, ?4)`,
			emailId, mailbox.toLowerCase(), sendAt, Date.now(),
		);
		await this.book(sendAt);
	}

	/** When a scheduled email goes (ms), or null if it isn't scheduled. */
	sendAt(emailId: string): number | null {
		const row = [...this.sql.exec(`SELECT send_at FROM scheduled_sends WHERE email_id = ?1`, emailId)][0];
		return row ? Number(row.send_at) : null;
	}

	/** Gives a scheduled email another time (`Date.now()` to send it straight away). False if it isn't scheduled. */
	async reschedule(emailId: string, sendAt: number): Promise<boolean> {
		if (this.sendAt(emailId) === null) return false;
		this.sql.exec(`UPDATE scheduled_sends SET send_at = ?2 WHERE email_id = ?1`, emailId, sendAt);
		await this.book(sendAt);
		return true;
	}

	/**
	 * Takes a scheduled email back to Drafts to be changed. A reply's in_reply_to goes back to the id of
	 * the email it answers, which is what a draft keeps. Returns the mailbox (for R2) or null.
	 */
	unschedule(emailId: string): string | null {
		const row = [...this.sql.exec(`SELECT mailbox FROM scheduled_sends WHERE email_id = ?1`, emailId)][0];
		if (!row) return null;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(`DELETE FROM scheduled_sends WHERE email_id = ?1`, emailId);
			this.#toDrafts(emailId);
		});
		return String(row.mailbox);
	}

	#toDrafts(emailId: string): void {
		this.sql.exec(
			`UPDATE emails SET folder_id = ?2,
			 in_reply_to = COALESCE((SELECT o.id FROM emails o WHERE o.message_id = emails.in_reply_to AND o.id <> emails.id LIMIT 1), in_reply_to)
			 WHERE id = ?1 AND folder_id = ?3`,
			emailId, Folders.DRAFT, Folders.SCHEDULED,
		);
	}

	/** When the alarm next needs to wake for a scheduled email, or null. */
	nextDue(): number | null {
		const row = [...this.sql.exec(`SELECT MIN(send_at) AS at FROM scheduled_sends`)][0];
		return row?.at == null ? null : Number(row.at);
	}

	/** From the alarm: sends what's due. */
	async onAlarm(host: SendHost, now = Date.now()): Promise<void> {
		const due = [...this.sql.exec(`SELECT email_id, mailbox, send_at FROM scheduled_sends WHERE send_at <= ?1 ORDER BY send_at`, now)];
		for (const row of due) {
			const id = String(row.email_id);
			const mailbox = String(row.mailbox);
			const stillThere = [...this.sql.exec(`SELECT subject FROM emails WHERE id = ?1 AND folder_id = ?2`, id, Folders.SCHEDULED)][0];
			if (!stillThere) {
				this.sql.exec(`DELETE FROM scheduled_sends WHERE email_id = ?1`, id);
				await this.env.BUCKET.delete(scheduledKey(mailbox, id));
				continue;
			}
			const subject = String(stillThere.subject ?? "");
			const obj = await this.env.BUCKET.get(scheduledKey(mailbox, id));
			const payload = obj ? ((await obj.json().catch(() => null)) as ScheduledPayload | null) : null;
			if (!payload) {
				await this.#failed(mailbox, id, subject, "Its contents couldn't be found.");
				continue;
			}
			const limit = await host.checkSendRateLimit(payload.recipients);
			if (limit) {
				// Over the sending limit for now: try again shortly, unless it's very late already.
				if (now - Number(row.send_at) > SEND_LATE_MS) await this.#failed(mailbox, id, subject, limit);
				else await this.reschedule(id, now + LIMIT_RETRY_MS);
				continue;
			}
			try {
				await sendTracked(this.env, payload.params, this.tally && { countMail: (k) => this.tally!.count(k), sendFailed: (to, error) => this.tally!.failed(to, error) });
			} catch (e) {
				console.error("Scheduled email failed:", (e as { code?: string })?.code ?? "", (e as Error)?.message ?? e);
				await this.#failed(mailbox, id, subject, sendFailureText(e));
				continue;
			}
			const sentAt = new Date().toISOString();
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(`DELETE FROM scheduled_sends WHERE email_id = ?1`, id);
				this.sql.exec(`UPDATE emails SET folder_id = ?2, date = ?3 WHERE id = ?1`, id, Folders.SENT, sentAt);
			});
			await this.env.BUCKET.delete(scheduledKey(mailbox, id));
			if (payload.remindAfterMs) await host.remindIfNoReply(id, Date.now() + payload.remindAfterMs).catch(() => false);
			emitEvent(this.env, this.ctx as unknown as ExecutionContext, "email.sent", mailbox, { ...payload.event, folder: Folders.SENT, date: sentAt });
		}
	}

	async #failed(mailbox: string, id: string, subject: string, reason: string): Promise<void> {
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(`DELETE FROM scheduled_sends WHERE email_id = ?1`, id);
			this.#toDrafts(id);
		});
		await this.env.BUCKET.delete(scheduledKey(mailbox, id));
		const words = failedWords(subject, reason);
		await notifyDevices(this.env, mailbox, { ...words, url: `/mailbox/${encodeURIComponent(mailbox)}/emails/${Folders.DRAFT}` })
			.catch((e) => console.error("Couldn't tell devices a scheduled email failed:", (e as Error).message));
	}
}
