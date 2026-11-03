// Mail App, 2026: backups of a mailbox. A backup is one standard .mbox file (every folder, with each
// message's folder, labels and read/starred state kept in its headers), stored in this install's own R2
// bucket in numbered pieces so it can be built a bit at a time. Runs inside the mailbox's Durable Object,
// one step per alarm, so a big mailbox never hits a time limit. Every night a new backup is made and
// only the newest few are kept.
// The mailbox's alarm is shared with calendar reminders, so the nightly time is kept in next_at and
// the alarm is only ever brought forward (setEarliest), never pushed back past a reminder.

import { mboxEntry, type StoredEmail, type StoredFile } from "../../shared/mbox";
import type { Env } from "../types";

/** Stop a step after this much mail, or this long, and carry on in the next one. */
const PIECE_BYTES = 8 * 1024 * 1024;
const STEP_MS = 10_000;
/** A step that finds the job hasn't moved for this long treats it as stuck and starts it again. */
const STUCK_MS = 30 * 60_000;
export const KEEP_CHOICES = [1, 2, 3, 5, 7] as const;

export interface BackupRow {
	id: string;
	kind: "nightly" | "manual";
	status: "running" | "done" | "failed";
	started_at: string;
	finished_at: string | null;
	emails: number;
	total: number;
	size: number;
	pieces: number;
	error: string | null;
}

export interface BackupSettings {
	nightly: boolean;
	keep: number;
	/** When the next nightly backup is due, if one is. */
	next: string | null;
}

type Sql = SqlStorage;

export class Backups {
	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
	) {}

	private get sql(): Sql {
		return this.ctx.storage.sql;
	}

	/** Where this mailbox's backups live in R2. Uses the Durable Object's own id, which never changes. */
	private prefix(id: string): string {
		return `backups/${this.ctx.id.toString()}/${id}/`;
	}

	pieceKey(id: string, n: number): string {
		return `${this.prefix(id)}${String(n).padStart(5, "0")}.mbox`;
	}

	list(): BackupRow[] {
		return [...this.sql.exec(
			`SELECT id, kind, status, started_at, finished_at, emails, total, size, pieces, error FROM backups ORDER BY started_at DESC`,
		)] as unknown as BackupRow[];
	}

	get(id: string): BackupRow | null {
		return ([...this.sql.exec(
			`SELECT id, kind, status, started_at, finished_at, emails, total, size, pieces, error FROM backups WHERE id = ?1`, id,
		)][0] as unknown as BackupRow) ?? null;
	}

	private running(): BackupRow | null {
		return ([...this.sql.exec(`SELECT * FROM backups WHERE status = 'running' LIMIT 1`)][0] as unknown as BackupRow) ?? null;
	}

	async settings(): Promise<BackupSettings> {
		const row = [...this.sql.exec(`SELECT nightly, keep, next_at FROM backup_settings WHERE id = 1`)][0];
		const nightly = !!row?.nightly;
		const next = row?.next_at == null ? null : Number(row.next_at);
		return { nightly, keep: Number(row?.keep ?? 3), next: nightly && next && !this.running() ? new Date(next).toISOString() : null };
	}

	/** When the nightly backup is next due, for the shared alarm (null when off or already running). */
	nextDue(): number | null {
		const row = [...this.sql.exec(`SELECT nightly, next_at FROM backup_settings WHERE id = 1`)][0];
		return row?.nightly && row.next_at != null && !this.running() ? Number(row.next_at) : null;
	}

	/** Books the alarm for `at` unless it's already booked sooner (by a reminder, say). */
	private async setEarliest(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || at < current || current <= Date.now()) await this.ctx.storage.setAlarm(at);
	}

	/**
	 * Called whenever the mailbox is opened: remembers which mailbox this is (so the nightly job can
	 * check it still exists) and makes sure the next nightly backup is booked.
	 */
	async remember(mailboxId: string): Promise<void> {
		this.sql.exec(`UPDATE backup_settings SET mailbox_id = ?1 WHERE id = 1 AND (mailbox_id IS NULL OR mailbox_id <> ?1)`, mailboxId);
		if (this.running()) return;
		const row = [...this.sql.exec(`SELECT nightly, next_at FROM backup_settings WHERE id = 1`)][0];
		if (row?.nightly && (row.next_at == null || (await this.ctx.storage.getAlarm()) === null)) await this.bookNightly();
	}

	async update(change: { nightly?: boolean; keep?: number }): Promise<BackupSettings> {
		if (change.nightly !== undefined) this.sql.exec(`UPDATE backup_settings SET nightly = ?1 WHERE id = 1`, change.nightly ? 1 : 0);
		if (change.keep !== undefined && (KEEP_CHOICES as readonly number[]).includes(change.keep)) {
			this.sql.exec(`UPDATE backup_settings SET keep = ?1 WHERE id = 1`, change.keep);
			await this.prune();
		}
		if (change.nightly === false) this.sql.exec(`UPDATE backup_settings SET next_at = NULL WHERE id = 1`);
		else if (change.nightly === true && !this.running()) await this.bookNightly();
		return this.settings();
	}

	/** Next night, between 2 and 3 am UK time (UTC is near enough), at a random minute to spread the load. */
	private async bookNightly(): Promise<void> {
		const at = new Date();
		at.setUTCDate(at.getUTCDate() + (at.getUTCHours() >= 2 ? 1 : 0));
		at.setUTCHours(2, Math.floor(Math.random() * 60), 0, 0);
		this.sql.exec(`UPDATE backup_settings SET next_at = ?1 WHERE id = 1`, at.getTime());
		await this.setEarliest(at.getTime());
	}

	/** Starts a backup, or returns the one already running. */
	async start(kind: "nightly" | "manual"): Promise<BackupRow> {
		const now = Date.now();
		const current = this.running();
		if (current) return current;
		const id = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") + "-" + crypto.randomUUID().slice(0, 6);
		const total = Number([...this.sql.exec(`SELECT COUNT(*) AS n FROM emails`)][0]?.n ?? 0);
		this.sql.exec(
			`INSERT INTO backups (id, kind, status, started_at, total) VALUES (?1, ?2, 'running', ?3, ?4)`,
			id, kind, new Date(now).toISOString(), total,
		);
		this.sql.exec(`UPDATE backup_settings SET next_at = NULL WHERE id = 1`);
		await this.setEarliest(now + 100);
		return this.get(id)!;
	}

	/** Runs from the Durable Object's alarm: the next piece of a running backup, or tonight's backup. */
	async onAlarm(): Promise<void> {
		const job = this.running();
		if (job) {
			const result = await this.step(job);
			if (result === "finished") await this.afterJob();
			else await this.setEarliest(Date.now() + (result === "more" ? 200 : 30_000));
			return;
		}
		const row = [...this.sql.exec(`SELECT mailbox_id, nightly, next_at FROM backup_settings WHERE id = 1`)][0];
		if (!row?.nightly) return;
		// The alarm may have woken for a reminder. Before next_at existed, the alarm was always the nightly one.
		if (row.next_at != null && Date.now() < Number(row.next_at) - 60_000) return;
		// A mailbox that has been removed gets no more backups.
		if (row.mailbox_id && !(await this.env.BUCKET.head(`mailboxes/${row.mailbox_id}.json`))) return;
		await this.start("nightly");
	}

	private async afterJob(): Promise<void> {
		await this.prune();
		if ((await this.settings()).nightly) await this.bookNightly();
	}

	/** Builds the next piece: "finished" when the backup is complete (or has been given up), "retry" after an error. */
	private async step(job: BackupRow & { cursor_date?: string | null; cursor_id?: string | null }): Promise<"finished" | "more" | "retry"> {
		const startedAt = Date.now();
		try {
			const folderNames = new Map([...this.sql.exec(`SELECT id, name FROM folders`)].map((r) => [String(r.id), String(r.name)]));
			const labelNames = new Map([...this.sql.exec(`SELECT id, name FROM labels`)].map((r) => [String(r.id), String(r.name)]));
			let cursorDate = (job.cursor_date as string | null) ?? "";
			let cursorId = (job.cursor_id as string | null) ?? "";
			const parts: string[] = [];
			let bytes = 0;
			let count = 0;
			let done = false;

			while (bytes < PIECE_BYTES && Date.now() - startedAt < STEP_MS) {
				const batch = [...this.sql.exec(
					`SELECT * FROM emails WHERE (COALESCE(date, ''), id) > (?1, ?2) ORDER BY COALESCE(date, ''), id LIMIT 20`,
					cursorDate, cursorId,
				)] as unknown as (StoredEmail & { folder_id: string; date: string | null })[];
				if (batch.length === 0) { done = true; break; }
				for (const email of batch) {
					const files = await this.files(email.id);
					const labels = [...this.sql.exec(`SELECT label_id FROM email_labels WHERE email_id = ?1`, email.id)]
						.map((r) => labelNames.get(String(r.label_id)))
						.filter((n): n is string => !!n);
					const entry = mboxEntry(email, files, { folder: folderNames.get(email.folder_id) ?? email.folder_id, labels });
					parts.push(entry);
					bytes += entry.length;
					count += 1;
					cursorDate = email.date ?? "";
					cursorId = email.id;
					if (bytes >= PIECE_BYTES) break;
				}
			}

			let size = 0;
			let pieces = job.pieces;
			if (parts.length) {
				const body = new TextEncoder().encode(parts.join(""));
				await this.env.BUCKET.put(this.pieceKey(job.id, pieces), body, { httpMetadata: { contentType: "application/mbox" } });
				size = body.length;
				pieces += 1;
			}
			this.sql.exec(
				`UPDATE backups SET emails = emails + ?2, size = size + ?3, pieces = ?4, cursor_date = ?5, cursor_id = ?6,
				 status = ?7, finished_at = ?8 WHERE id = ?1`,
				job.id, count, size, pieces, cursorDate, cursorId,
				done ? "done" : "running", done ? new Date().toISOString() : null,
			);
			return done ? "finished" : "more";
		} catch (e) {
			// A job that keeps failing is given up, so it doesn't block every later backup.
			const age = Date.now() - new Date(job.started_at).getTime();
			if (age > STUCK_MS) {
				this.sql.exec(`UPDATE backups SET status = 'failed', error = ?2, finished_at = ?3 WHERE id = ?1`,
					job.id, String((e as Error).message ?? e).slice(0, 300), new Date().toISOString());
				return "finished";
			}
			console.error("Backup step failed, trying again shortly:", (e as Error).message);
			return "retry";
		}
	}

	private async files(emailId: string): Promise<StoredFile[]> {
		const rows = [...this.sql.exec(
			`SELECT id, filename, mimetype, content_id, disposition FROM attachments WHERE email_id = ?1`, emailId,
		)];
		const out: StoredFile[] = [];
		for (const r of rows) {
			const obj = await this.env.BUCKET.get(`attachments/${emailId}/${r.id}/${r.filename}`);
			if (!obj) continue; // the file has gone; the rest of the email is still worth keeping
			out.push({
				filename: String(r.filename),
				mimetype: String(r.mimetype),
				content_id: r.content_id as string | null,
				disposition: r.disposition as string | null,
				bytes: new Uint8Array(await obj.arrayBuffer()),
			});
		}
		return out;
	}

	/** Keeps the newest finished backups (as many as the setting says) and removes the rest. */
	private async prune(): Promise<void> {
		const keep = (await this.settings()).keep;
		const old = [...this.sql.exec(
			`SELECT id FROM backups WHERE status <> 'running' ORDER BY (status = 'done') DESC, started_at DESC LIMIT -1 OFFSET ?1`, keep,
		)].map((r) => String(r.id));
		for (const id of old) await this.remove(id);
	}

	async remove(id: string): Promise<boolean> {
		const row = this.get(id);
		if (!row) return false;
		const keys: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.env.BUCKET.list({ prefix: this.prefix(id), cursor });
			keys.push(...page.objects.map((o) => o.key));
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
		for (let i = 0; i < keys.length; i += 1000) await this.env.BUCKET.delete(keys.slice(i, i + 1000));
		this.sql.exec(`DELETE FROM backups WHERE id = ?1`, id);
		if (row.status === "running" && !this.running()) await this.afterJob();
		return true;
	}
}
