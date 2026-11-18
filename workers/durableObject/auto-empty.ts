// Mail App, 2026: auto-empty the Bin and Spam. Once a day, emails that have been in the Bin or Spam for
// longer than the mailbox's setting (Settings > Mail) are deleted for good, with their attachments, which
// keeps storage down. Off until someone picks a number of days. When each email arrived there is kept
// in bin_since by triggers (migration 27), so moving mail any way at all counts.

import { Folders } from "../../shared/folders";
import { AUTO_EMPTY_CHOICES, type AutoEmptySettings } from "../../shared/auto-empty";
import type { Env } from "../types";

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 200;

export class AutoEmpty {
	constructor(private ctx: DurableObjectState, private env: Env) {}

	private get sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	async settings(): Promise<AutoEmptySettings> {
		const saved = (await this.ctx.storage.get<AutoEmptySettings>("autoEmpty")) ?? null;
		return { trashDays: saved?.trashDays ?? 0, spamDays: saved?.spamDays ?? 0 };
	}

	async update(change: Partial<AutoEmptySettings>): Promise<AutoEmptySettings> {
		const now = await this.settings();
		const ok = (n: unknown) => typeof n === "number" && (AUTO_EMPTY_CHOICES as readonly number[]).includes(n);
		const next = {
			trashDays: ok(change.trashDays) ? change.trashDays! : now.trashDays,
			spamDays: ok(change.spamDays) ? change.spamDays! : now.spamDays,
		};
		await this.ctx.storage.put("autoEmpty", next);
		if (next.trashDays || next.spamDays) await this.book();
		else await this.ctx.storage.delete("autoEmptyNext");
		return next;
	}

	/** Next run, about 3 am UTC tomorrow at a random minute, unless one is already booked. */
	private async book(): Promise<void> {
		if (await this.ctx.storage.get<number>("autoEmptyNext")) return;
		const at = new Date();
		at.setUTCDate(at.getUTCDate() + 1);
		at.setUTCHours(3, Math.floor(Math.random() * 60), 0, 0);
		await this.ctx.storage.put("autoEmptyNext", at.getTime());
		const current = await this.ctx.storage.getAlarm();
		if (current === null || at.getTime() < current) await this.ctx.storage.setAlarm(at.getTime());
	}

	async nextDue(): Promise<number | null> {
		return (await this.ctx.storage.get<number>("autoEmptyNext")) ?? null;
	}

	/** Deletes what's due, if the daily run is due. Returns how many emails went. */
	async onAlarm(): Promise<number> {
		const due = await this.nextDue();
		if (due === null || due > Date.now()) return 0;
		await this.ctx.storage.delete("autoEmptyNext");
		const { trashDays, spamDays } = await this.settings();
		let gone = 0;
		if (trashDays) gone += await this.emptyOlderThan(Folders.TRASH, trashDays);
		if (spamDays) gone += await this.emptyOlderThan(Folders.SPAM, spamDays);
		if (trashDays || spamDays) await this.book();
		return gone;
	}

	/** Deletes emails that have been in the folder for more than `days` days. */
	async emptyOlderThan(folder: string, days: number): Promise<number> {
		const cutoff = Date.now() - days * DAY;
		let total = 0;
		for (;;) {
			const ids = [...this.sql.exec(
				`SELECT b.email_id AS id FROM bin_since b JOIN emails e ON e.id = b.email_id
				 WHERE b.folder_id = ?1 AND e.folder_id = ?1 AND b.since < ?2 LIMIT ${BATCH}`, folder, cutoff,
			)].map((r) => String(r.id));
			if (ids.length === 0) break;
			const marks = ids.map((_, i) => `?${i + 1}`).join(",");
			const files = [...this.sql.exec(`SELECT id, email_id, filename FROM attachments WHERE email_id IN (${marks})`, ...ids)]
				.map((r) => `attachments/${r.email_id}/${r.id}/${r.filename}`);
			if (files.length) {
				for (let i = 0; i < files.length; i += 1000) await this.env.BUCKET.delete(files.slice(i, i + 1000));
			}
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(`DELETE FROM attachments WHERE email_id IN (${marks})`, ...ids);
				this.sql.exec(`DELETE FROM email_labels WHERE email_id IN (${marks})`, ...ids);
				this.sql.exec(`DELETE FROM emails WHERE id IN (${marks})`, ...ids);
			});
			total += ids.length;
			if (ids.length < BATCH) break;
		}
		return total;
	}
}
