// Mail App, 2026: Notes, kept in the mailbox's own database (see shared/notes.ts). Each person sees the
// notes they wrote and the ones shared with everyone who can open the mailbox; nobody else's private
// notes. Reminders are checked from the mailbox's alarm, shared with backups, calendar reminders,
// webhook retries and snoozes. The words a reminder will show are worked out when the note is saved,
// as only then do we know whether other people use the mailbox.

import {
	BIN_DAYS, MAX_NOTES, cleanItems, reminderWords, type Note, type NoteColour, type NoteInput,
} from "../../shared/notes";
import { notifyDevices } from "../lib/push";
import type { Env } from "../types";

export interface NoteViewer {
	email: string;
	name: string;
}

type Row = Record<string, SqlStorageValue>;

/** A reminder that was due more than this long ago (the alarm was held up) is dropped rather than sent. */
const STALE_MS = 6 * 3_600_000;

function toNote(row: Row, viewer: string): Note {
	let items: Note["items"] = [];
	try { items = cleanItems(JSON.parse(String(row.items ?? "[]"))); } catch { /* left empty */ }
	return {
		id: String(row.id),
		title: String(row.title ?? ""),
		body: String(row.body ?? ""),
		items,
		checklist: Number(row.checklist) === 1,
		colour: String(row.colour ?? "none") as NoteColour,
		pinned: Number(row.pinned) === 1,
		shared: Number(row.shared) === 1,
		remindAt: row.remind_at == null ? null : Number(row.remind_at),
		reminded: Number(row.reminded) === 1,
		ownerEmail: String(row.owner_email),
		ownerName: String(row.owner_name ?? ""),
		mine: String(row.owner_email) === viewer,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		binnedAt: row.binned_at ? String(row.binned_at) : null,
	};
}

export class Notes {
	constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

	private get sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	private row(id: string): Row | undefined {
		return [...this.sql.exec(`SELECT * FROM notes WHERE id = ?1`, id)][0];
	}

	/** Can this person see the note? Their own, or one shared with the mailbox. */
	private visible(row: Row | undefined, viewer: string): row is Row {
		return !!row && (String(row.owner_email) === viewer || Number(row.shared) === 1);
	}

	/** The notes this person can see: `bin` for the ones in the Bin. Old ones in the Bin go first. */
	list(viewer: NoteViewer, bin = false): Note[] {
		this.tidy();
		const rows = this.sql.exec(
			`SELECT * FROM notes WHERE (owner_email = ?1 OR shared = 1) AND binned_at IS ${bin ? "NOT NULL" : "NULL"}
			 ORDER BY pinned DESC, updated_at DESC LIMIT ${MAX_NOTES}`,
			viewer.email,
		);
		return [...rows].map((r) => toNote(r, viewer.email));
	}

	get(id: string, viewer: NoteViewer): Note | null {
		const row = this.row(id);
		return this.visible(row, viewer.email) ? toNote(row, viewer.email) : null;
	}

	/** Makes a note. Returns "full" when the mailbox already has as many as it can keep. */
	async create(input: NoteInput, viewer: NoteViewer, sharedMailbox: boolean): Promise<Note | "full"> {
		const count = Number([...this.sql.exec(`SELECT COUNT(*) AS n FROM notes WHERE binned_at IS NULL`)][0]?.n ?? 0);
		if (count >= MAX_NOTES) return "full";
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		this.sql.exec(
			`INSERT INTO notes (id, owner_email, owner_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)`,
			id, viewer.email, viewer.name, now,
		);
		const made = await this.update(id, { ...input, shared: sharedMailbox && input.shared === true }, viewer, sharedMailbox);
		return made as Note;
	}

	/**
	 * Changes a note. Only the person who wrote it can share it or stop sharing it. Returns "missing"
	 * when the person can't see it, "not-yours" when they try to change who can see someone else's.
	 */
	async update(id: string, input: NoteInput, viewer: NoteViewer, sharedMailbox: boolean): Promise<Note | "missing" | "not-yours"> {
		const row = this.row(id);
		if (!this.visible(row, viewer.email)) return "missing";
		const mine = String(row.owner_email) === viewer.email;
		if (input.shared !== undefined && input.shared !== (Number(row.shared) === 1) && !mine) return "not-yours";
		const before = toNote(row, viewer.email);
		const next: Note = {
			...before,
			...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
			updatedAt: new Date().toISOString(),
		};
		// Sharing only means something in a mailbox other people use.
		if (!sharedMailbox) next.shared = false;
		const remindChanged = input.remindAt !== undefined && input.remindAt !== before.remindAt;
		const words = next.remindAt === null ? null : reminderWords(next, sharedMailbox);
		this.sql.exec(
			`UPDATE notes SET title = ?2, body = ?3, items = ?4, checklist = ?5, colour = ?6, pinned = ?7, shared = ?8,
			 remind_at = ?9, reminded = ?10, reminder_title = ?11, reminder_body = ?12, updated_at = ?13 WHERE id = ?1`,
			id, next.title, next.body, JSON.stringify(next.items), next.checklist ? 1 : 0, next.colour, next.pinned ? 1 : 0, next.shared ? 1 : 0,
			next.remindAt, remindChanged ? 0 : before.reminded ? 1 : 0, words?.title ?? null, words?.body ?? null, next.updatedAt,
		);
		if (remindChanged && next.remindAt !== null) await this.book(next.remindAt);
		return this.get(id, viewer)!;
	}

	/** Moves notes to the Bin. Returns how many it moved. */
	toBin(ids: string[], viewer: NoteViewer): number {
		return this.#mark(ids, viewer, new Date().toISOString());
	}

	/** Takes notes back out of the Bin. */
	restore(ids: string[], viewer: NoteViewer): number {
		return this.#mark(ids, viewer, null);
	}

	#mark(ids: string[], viewer: NoteViewer, binnedAt: string | null): number {
		let n = 0;
		this.ctx.storage.transactionSync(() => {
			for (const id of ids) {
				if (!this.visible(this.row(id), viewer.email)) continue;
				this.sql.exec(`UPDATE notes SET binned_at = ?2 WHERE id = ?1`, id, binnedAt);
				n++;
			}
		});
		return n;
	}

	/** Deletes notes in the Bin for good. With no ids, everything this person can see in the Bin. */
	deleteForever(ids: string[] | null, viewer: NoteViewer): number {
		const targets = ids ?? this.list(viewer, true).map((n) => n.id);
		let n = 0;
		this.ctx.storage.transactionSync(() => {
			for (const id of targets) {
				const row = this.row(id);
				if (!this.visible(row, viewer.email) || !row.binned_at) continue;
				this.sql.exec(`DELETE FROM notes WHERE id = ?1`, id);
				n++;
			}
		});
		return n;
	}

	/** Notes in the Bin for more than BIN_DAYS go for good. */
	tidy(now = Date.now()): void {
		this.sql.exec(`DELETE FROM notes WHERE binned_at IS NOT NULL AND binned_at < ?1`, new Date(now - BIN_DAYS * 86_400_000).toISOString());
	}

	private async book(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || at < current) await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 100));
	}

	/** When the alarm next needs to wake for a note's reminder, or null. */
	nextDue(): number | null {
		const row = [...this.sql.exec(`SELECT MIN(remind_at) AS at FROM notes WHERE reminded = 0 AND remind_at IS NOT NULL AND binned_at IS NULL`)][0];
		return row?.at == null ? null : Number(row.at);
	}

	/** From the alarm: sends the reminders that are due to every device with notifications on. */
	async onAlarm(mailboxId: string | null, now = Date.now()): Promise<void> {
		const due = [...this.sql.exec(
			`SELECT id, remind_at, reminder_title, reminder_body FROM notes WHERE reminded = 0 AND remind_at IS NOT NULL AND remind_at <= ?1 AND binned_at IS NULL`,
			now,
		)];
		if (!due.length) return;
		this.sql.exec(`UPDATE notes SET reminded = 1 WHERE reminded = 0 AND remind_at IS NOT NULL AND remind_at <= ?1`, now);
		if (!mailboxId) return;
		for (const r of due) {
			if (Number(r.remind_at) < now - STALE_MS) continue;
			await notifyDevices(this.env, mailboxId, {
				title: String(r.reminder_title ?? "Note reminder"),
				body: String(r.reminder_body ?? ""),
				url: `/mailbox/${encodeURIComponent(mailboxId)}/notes?note=${r.id}`,
			}).catch((e) => console.error("Note reminder failed:", (e as Error).message));
		}
	}
}
