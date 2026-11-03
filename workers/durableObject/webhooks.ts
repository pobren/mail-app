// Mail App, 2026: webhook events that didn't get through the first time. Each mailbox keeps its own
// in its database and tries them again from the Durable Object's alarm (shared with backups and
// reminders; see MailboxDO.alarm), after 1 minute, 10 minutes and 1 hour. Then it gives up; every
// try is in the webhook's delivery log.

import { MAX_TRIES, RETRY_DELAYS } from "../../shared/api";
import { loadApiBook, sendOnce } from "../lib/api";
import type { Env } from "../types";

export class WebhookRetries {
	constructor(
		private ctx: DurableObjectState,
		private env: Env,
	) {}

	private get sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	/** Books another try of a delivery, `attempt` being the try that just failed. */
	async queue(input: { id: string; webhookId: string; event: string; body: string; attempt: number }): Promise<void> {
		if (input.attempt >= MAX_TRIES) return;
		const at = Date.now() + RETRY_DELAYS[input.attempt - 1] * 1000;
		this.sql.exec(
			`INSERT OR REPLACE INTO webhook_retries (id, webhook_id, event, body, attempt, due_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
			input.id, input.webhookId, input.event, input.body, input.attempt + 1, at,
		);
		const current = await this.ctx.storage.getAlarm();
		if (current === null || at < current) await this.ctx.storage.setAlarm(at);
	}

	nextDue(): number | null {
		const row = [...this.sql.exec(`SELECT MIN(due_at) AS at FROM webhook_retries`)][0];
		return row?.at == null ? null : Number(row.at);
	}

	/** From the alarm: tries again every delivery that's due. */
	async onAlarm(now = Date.now()): Promise<void> {
		const due = [...this.sql.exec(`SELECT * FROM webhook_retries WHERE due_at <= ?1 LIMIT 20`, now)];
		if (!due.length) return;
		const book = await loadApiBook(this.env.BUCKET);
		for (const row of due) {
			const id = String(row.id);
			this.sql.exec(`DELETE FROM webhook_retries WHERE id = ?1`, id);
			const hook = book.webhooks.find((w) => w.id === String(row.webhook_id));
			if (!hook || hook.paused) continue;
			const attempt = Number(row.attempt);
			const result = await sendOnce(this.env, hook, String(row.event) as never, String(row.body), id, attempt);
			if (!result.ok && result.retry) await this.queue({ id, webhookId: hook.id, event: String(row.event), body: String(row.body), attempt });
		}
	}
}
