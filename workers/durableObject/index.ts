// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: contacts; labels; contact import; acting on whole conversations; backups; the list says which extra address an email came to; inbox rules run on mail already in the Inbox; knowsSender for the spam checks; the calendar and its invites; Files; Notes; snooze and "Remind me if no reply"; scheduled send; the daily tally for Admin > Reports; learning from Spam and Not spam.

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";
import { sendLimitError } from "../lib/send-limit";
import { buildContacts, cleanSenderName, displayName, type SavedContactRow } from "../../shared/contacts";
import { MAX_LABELS, type Label, type LabelColor } from "../../shared/labels";
import { Backups } from "./backup";
import { Calendars, type Viewer } from "./calendar";
import { WebhookRetries } from "./webhooks";
import { Files, type FileViewer } from "./files";
import { Reminders, inFolderSql } from "./reminders";
import { Notes, type NoteViewer } from "./notes";
import type { NoteInput } from "../../shared/notes";
import { MailStats } from "./stats";
import type { CountKind } from "../../shared/reports";
import { ScheduledSends } from "./scheduled";
import { SpamLearning } from "./spam-learning";
import type { CalendarColor, EditScope, EventInput, GuestStatus, Organizer } from "../../shared/calendar";
import type { ShareLevel } from "../../shared/calendar-shares";
import { DELIVERED_TO_HEADER } from "../../shared/addresses";
import { bodyText, ruleMatches, type InboxRule, type RuleMessage } from "../../shared/rules";

/** Mail App: a conversation is every message sharing a thread_id; a message on its own is its own conversation. */
/** The name in a stored email's From header, or "" (headers are kept as [{ key, value }]). */
function fromHeaderName(rawHeaders: string | null | undefined): string {
	if (!rawHeaders) return "";
	try {
		const from = (JSON.parse(rawHeaders) as { key: string; value: string }[]).find((h) => h.key?.toLowerCase() === "from");
		return from && !from.value.includes("=?") ? displayName(from.value) : "";
	} catch {
		return "";
	}
}

const THREAD_KEY_SQL = "COALESCE(thread_id, id)";

/** Mail App: what the tick boxes in the list can do to the chosen conversations. */
export type ConversationAction = "move" | "read" | "unread" | "delete";

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
// Mail App: the address an incoming email came in on (an extra address or the catch-all), from the header
// Mail App adds when it arrives, so the list can show which address it was sent to.
const DELIVERED_TO_SQL = (t: string) => `(CASE WHEN json_valid(${t}.raw_headers) THEN (
	SELECT json_extract(h.value, '$.value') FROM json_each(${t}.raw_headers) h
	WHERE LOWER(json_extract(h.value, '$.key')) = '${DELIVERED_TO_HEADER}' LIMIT 1
) END)`;

const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, typeof schema.emails[keyof typeof schema.emails]>;

interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
	/** Mail App: a label's name. */
	label?: string;
}

interface GetEmailsOptions {
	folder?: string;
	thread_id?: string;
	page?: number;
	limit?: number;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	sender_name?: string | null;
	sent_by?: string | null;
	sent_by_name?: string | null;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	/** Mail App: nightly and on-demand backups (see backup.ts). */
	backups: Backups;

	/** Mail App: the mailbox's calendars and reminders (see calendar.ts). */
	calendar: Calendars;

	/** Mail App: webhook events waiting to be tried again (see webhooks.ts). */
	webhookRetries: WebhookRetries;

	/** Mail App: Files, the mailbox's private storage (see files.ts). */
	files: Files;

	/** Mail App: snooze and "Remind me if no reply" (see reminders.ts). */
	reminders: Reminders;

	/** Mail App: Notes (see notes.ts). */
	notes: Notes;

	/** Mail App: emails waiting to be sent at a chosen time (see scheduled.ts). */
	scheduled: ScheduledSends;

	/** Mail App: the daily tally for Admin > Reports (see stats.ts). */
	stats: MailStats;
	/** Mail App: learning from Spam and Not spam (see spam-learning.ts). */
	spamLearning: SpamLearning;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
		this.backups = new Backups(this.ctx, env);
		this.calendar = new Calendars(this.ctx, env);
		this.webhookRetries = new WebhookRetries(this.ctx, env);
		this.files = new Files(this.ctx);
		this.reminders = new Reminders(this.ctx);
		this.notes = new Notes(this.ctx, env);
		this.stats = new MailStats(this.ctx);
		this.scheduled = new ScheduledSends(this.ctx, env, this.stats);
		this.spamLearning = new SpamLearning(this.ctx);
	}

	// ── Mail App: Admin > Reports ───────────────────────────────────────

	async countMail(kinds: CountKind[]) { this.stats.count(kinds); return true; }
	async sendFailed(recipient: string, error: string) { this.stats.failed(recipient, error); return true; }
	async mailReport(since: string) { return this.stats.report(since, this.files); }
	async findMail(q: string, since: string, mailbox: string) { return this.stats.find(q, since, mailbox); }

	// ── Mail App: Notes ─────────────────────────────────────────────────

	async listNotes(viewer: NoteViewer, bin = false) { return this.notes.list(viewer, bin); }
	async createNote(input: NoteInput, viewer: NoteViewer, sharedMailbox: boolean) { return this.notes.create(input, viewer, sharedMailbox); }
	async updateNote(id: string, input: NoteInput, viewer: NoteViewer, sharedMailbox: boolean) { return this.notes.update(id, input, viewer, sharedMailbox); }
	async binNotes(ids: string[], viewer: NoteViewer) { return this.notes.toBin(ids, viewer); }
	async restoreNotes(ids: string[], viewer: NoteViewer) { return this.notes.restore(ids, viewer); }
	async deleteNotesForever(ids: string[] | null, viewer: NoteViewer) { return this.notes.deleteForever(ids, viewer); }

	// ── Mail App: scheduled send ────────────────────────────────────────

	async scheduleSend(mailbox: string, emailId: string, sendAt: number) { return this.scheduled.schedule(mailbox, emailId, sendAt); }
	async rescheduleSend(emailId: string, sendAt: number) { return this.scheduled.reschedule(emailId, sendAt); }
	async unscheduleSend(emailId: string) { return this.scheduled.unschedule(emailId); }

	// ── Mail App: snooze and "Remind me if no reply" ────────────────────

	async snooze(ids: string[], until: number, fromFolder?: string) { return this.reminders.snooze(ids, until, fromFolder); }
	async unsnooze(ids: string[]) { this.reminders.unsnooze(ids); return true; }
	async remindIfNoReply(emailId: string, at: number) { return this.reminders.remindIfNoReply(emailId, at); }
	async cancelReminder(emailId: string, kind: "snooze" | "no-reply") { this.reminders.cancel(emailId, kind); return true; }

	// ── Mail App: Files ─────────────────────────────────────────────────

	async listFiles(parentId: string | null) { return this.files.list(parentId); }
	async getFile(id: string) { return this.files.get(id); }
	async fileBin() { return this.files.bin(); }
	async searchFiles(query: string) { return this.files.search(query); }
	async fileUsage() { return this.files.usage(); }
	async createFileFolder(parentId: string | null, name: string, viewer: FileViewer) { return this.files.createFolder(parentId, name, viewer); }
	async topFileFolder(name: string, viewer: FileViewer) { return this.files.topFolder(name, viewer); }
	async addFile(input: { id: string; parentId: string | null; name: string; size: number; type: string; uploadId: string | null }, viewer: FileViewer) { return this.files.addFile(input, viewer); }
	async pendingFileUpload(id: string) { return this.files.pendingUpload(id); }
	async finishFileUpload(id: string) { return this.files.finishUpload(id); }
	async dropFileUpload(id: string) { return this.files.dropUpload(id); }
	async renameFile(id: string, name: string) { return this.files.rename(id, name); }
	async moveFiles(ids: string[], parentId: string | null) { return this.files.move(ids, parentId); }
	async binFiles(ids: string[]) { return this.files.toBin(ids); }
	async restoreFiles(ids: string[]) { return this.files.restore(ids); }
	async deleteFilesForever(ids: string[]) { return this.files.deleteForever(ids); }
	async emptyFileBin() { return this.files.emptyBin(); }
	async tidyFiles() { return this.files.tidy(); }

	// ── Mail App: backups ───────────────────────────────────────────────

	// The one alarm serves backups, calendar reminders, webhook retries, snoozes, note reminders and scheduled emails: each runs if it's due, then the alarm
	// is booked for whichever comes next.
	async alarm() {
		try {
			await this.backups.onAlarm();
		} finally {
			const row = [...this.ctx.storage.sql.exec(`SELECT mailbox_id FROM backup_settings WHERE id = 1`)][0];
			await this.calendar.onAlarm(row?.mailbox_id ? String(row.mailbox_id) : null).catch((e) => console.error("Calendar reminders:", (e as Error).message));
			await this.webhookRetries.onAlarm().catch((e) => console.error("Webhook retries:", (e as Error).message));
			try { this.reminders.onAlarm(); } catch (e) { console.error("Snoozes and reminders:", (e as Error).message); }
			await this.notes.onAlarm(row?.mailbox_id ? String(row.mailbox_id) : null).catch((e) => console.error("Note reminders:", (e as Error).message));
			await this.scheduled.onAlarm(this).catch((e) => console.error("Scheduled send:", (e as Error).message));
			const due = [await this.ctx.storage.getAlarm(), this.backups.nextDue(), this.calendar.nextDue(), this.webhookRetries.nextDue(), this.reminders.nextDue(), this.notes.nextDue(), this.scheduled.nextDue()].filter((t): t is number => t !== null);
			if (due.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...due)));
		}
	}

	/** Mail App: books another try of a webhook event that didn't get through. */
	async queueWebhookRetry(input: { id: string; webhookId: string; event: string; body: string; attempt: number }) {
		await this.webhookRetries.queue(input);
	}

	async rememberMailbox(mailboxId: string) {
		await this.backups.remember(mailboxId);
	}

	async listBackups() {
		return { backups: this.backups.list(), settings: await this.backups.settings() };
	}

	async startBackup() {
		return this.backups.start("manual");
	}

	async updateBackupSettings(change: { nightly?: boolean; keep?: number }) {
		return this.backups.update(change);
	}

	async removeBackup(id: string) {
		return this.backups.remove(id);
	}

	// ── Mail App: calendar ──────────────────────────────────────────────

	async listCalendars() {
		return this.calendar.list();
	}

	async createCalendar(name: string, color: CalendarColor, source?: { url: string; tz: string }) {
		return this.calendar.createCalendar(name, color, source);
	}

	async importCalendarEvents(calendarId: string, items: Parameters<Calendars["importEvents"]>[1], viewer: Viewer) {
		return this.calendar.importEvents(calendarId, items, viewer);
	}

	async outsideCalendarSource(id: string) {
		return this.calendar.outsideSource(id);
	}

	async replaceOutsideCalendar(id: string, result: Parameters<Calendars["replaceOutside"]>[1]) {
		return this.calendar.replaceOutside(id, result);
	}

	async updateCalendar(id: string, changes: { name?: string; color?: CalendarColor }) {
		return this.calendar.updateCalendar(id, changes);
	}

	async removeCalendar(id: string) {
		return this.calendar.removeCalendar(id);
	}

	async calendarOccurrences(fromMs: number, toMs: number, viewer: Viewer, shared?: { calendarId: string; level: ShareLevel }) {
		return this.calendar.occurrences(fromMs, toMs, viewer, shared);
	}

	async createCalendarEvent(input: EventInput, viewer: Viewer) {
		return this.calendar.createEvent(input, viewer);
	}

	async changeCalendarEvent(id: string, input: EventInput, scope: EditScope, occurrence: string | null, viewer: Viewer) {
		return this.calendar.changeEvent(id, input, scope, occurrence, viewer);
	}

	async removeCalendarEvent(id: string, scope: EditScope, occurrence: string | null, viewer: Viewer) {
		return this.calendar.removeEvent(id, scope, occurrence, viewer);
	}

	async upcomingReminders(fromMs: number, toMs: number, viewer: Viewer) {
		return this.calendar.upcoming(fromMs, toMs, viewer);
	}

	async getCalendarEvent(id: string) {
		return this.calendar.get(id);
	}

	async calendarEventByUid(uid: string, recurrenceId: string | null = null) {
		return this.calendar.byUid(uid, recurrenceId);
	}

	async calendarChangedDates(uid: string) {
		return this.calendar.changedDates(uid);
	}

	async saveCalendarInvite(input: EventInput, invite: { uid: string; organizer: Organizer | null; sequence: number; exceptions: string[]; recurrenceId?: string | null }, viewer: Viewer) {
		return this.calendar.saveInvite(input, invite, viewer);
	}

	async setCalendarGuestStatus(uid: string, email: string, status: GuestStatus, name?: string, recurrenceId: string | null = null) {
		return this.calendar.setGuestStatus(uid, email, status, name, recurrenceId);
	}

	async removeCalendarInvite(uid: string, recurrenceId: string | null = null) {
		return this.calendar.removeInvite(uid, recurrenceId);
	}

	async feedCalendar(calendarId: string, level: "all" | "busy") {
		return this.calendar.feedIcs(calendarId, level);
	}

	async exportCalendar(calendarId: string | null, viewer: Viewer) {
		return this.calendar.exportIcs(calendarId, viewer);
	}

	/** Mail App: which of these Message-IDs are already in the mailbox, so an import never adds mail twice. */
	async knownMessageIds(ids: string[]): Promise<string[]> {
		const found: string[] = [];
		for (let i = 0; i < ids.length; i += 90) {
			const part = ids.slice(i, i + 90);
			const rows = this.ctx.storage.sql.exec(
				`SELECT DISTINCT message_id FROM emails WHERE message_id IN (${part.map((_, n) => `?${n + 1}`).join(",")})`,
				...part,
			);
			for (const r of rows) found.push(String(r.message_id));
		}
		return found;
	}

	/**
	 * Mail App: adds restored or imported mail. Each message joins the conversation it belongs to if that's
	 * already here, and gets its labels. Mail whose Message-ID is already here is skipped.
	 */
	async importEmails(items: { email: EmailData; attachments: AttachmentData[]; folderId: string; labelIds: string[] }[]) {
		const sql = this.ctx.storage.sql;
		const added: string[] = [];
		for (const item of items) {
			const { email } = item;
			if (email.message_id && [...sql.exec(`SELECT 1 FROM emails WHERE message_id = ?1 LIMIT 1`, email.message_id)].length) continue;
			let refs: string[] = [];
			try { refs = JSON.parse(email.email_references || "[]"); } catch { /* none */ }
			const known = await this.findThreadByMessageIds([email.in_reply_to, ...refs].filter((x): x is string => !!x));
			await this.createEmail(item.folderId, { ...email, thread_id: known ?? email.thread_id }, item.attachments);
			for (const labelId of item.labelIds) {
				sql.exec(`INSERT OR IGNORE INTO email_labels (email_id, label_id) SELECT ?1, id FROM labels WHERE id = ?2`, email.id, labelId);
			}
			added.push(email.id);
		}
		return added;
	}

	/** Where a finished backup's pieces are, in order, for downloading. */
	async backupPieces(id: string) {
		const row = this.backups.get(id);
		if (!row || row.status !== "done") return null;
		return { row, keys: Array.from({ length: row.pieces }, (_, n) => this.backups.pieceKey(id, n)) };
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	async getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				sender: schema.emails.sender,
				sender_name: schema.emails.sender_name,
				recipient: schema.emails.recipient,
				cc: schema.emails.cc,
				bcc: schema.emails.bcc,
				date: schema.emails.date,
				read: schema.emails.read,
				starred: schema.emails.starred,
				in_reply_to: schema.emails.in_reply_to,
				email_references: schema.emails.email_references,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
				snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return this.#withLabels(result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		})));
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(options: { folder?: string; thread_id?: string } = {}) {
		const { folder, thread_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			page = 1,
			limit: rawLimit = 25,
		} = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}

		const offset = (page - 1) * limit;

		// Thread grouping strategy:
		// For DRAFT folder: group by in_reply_to (the email being replied to).
		//   This ensures reply-drafts to different emails stay separate, even if
		//   they share a thread_id or subject. New drafts (no in_reply_to) each
		//   get their own group via their unique id.
		// For other folders:
		//   1. Primary: group by thread_id (from email threading headers)
		//   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
		//      for legacy emails that lack threading headers (thread_id IS NULL).
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT COALESCE(NULLIF(sender_name, ''), sender)) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.sender_name, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				folder, limit, offset
			);

			const rows = [...result];
			return this.#withLabels(rows.map((row: any) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
			})));
		}

		// Non-draft folders: full threading logic
		const result = this.ctx.storage.sql.exec(
			`WITH
			folder_emails AS (
				SELECT *,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE ${inFolderSql()}
			),
			thread_to_conversation AS (
				SELECT
					raw_thread_id,
					normalized_subject,
					CASE
						WHEN thread_id IS NOT NULL THEN raw_thread_id
						ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			all_emails_with_conversation AS (
				SELECT
					e.*,
					COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc
					ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT COALESCE(NULLIF(sender_name, ''), sender)) as participants,
					SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE name = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conversation
					WHERE ${inFolderSql()}
				)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.sender_name, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				${DELIVERED_TO_SQL("lif")} as delivered_to,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE name = 'sent' LIMIT 1)
					AND lmc.folder_id != (SELECT id FROM folders WHERE name = 'draft' LIMIT 1)
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft,
				MAX(lif.date, COALESCE(lif.back_at, lif.date)) as shown_at,
				(SELECT due_at FROM reminders r WHERE r.thread_key = COALESCE(lif.thread_id, lif.id) AND r.kind = 'snooze') as snoozed_until,
				(SELECT CASE WHEN r.shown = 1 THEN -1 ELSE r.due_at END FROM reminders r WHERE r.thread_key = COALESCE(lif.thread_id, lif.id) AND r.kind = 'no-reply') as no_reply,
				(SELECT s.send_at FROM scheduled_sends s WHERE s.email_id = lif.id) as send_at
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1
			ORDER BY shown_at DESC
			LIMIT ?2 OFFSET ?3`,
			folder, limit, offset
		);

		const rows = [...result];
		return this.#withLabels(rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
			// Mail App: snoozed until (ms); for "Remind me if no reply", when it's due, or "due" once it's back.
			snoozed_until: row.snoozed_until == null ? null : Number(row.snoozed_until),
			no_reply: row.no_reply == null ? null : Number(row.no_reply) === -1 ? "due" : Number(row.no_reply),
			// Mail App: when a scheduled email goes (ms).
			send_at: row.send_at == null ? null : Number(row.send_at),
		})));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails.
	 */
	async countThreadedEmails(folder: string) {
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)`,
					folder,
				),
			][0] as { total: number } | undefined;
			return row?.total ?? 0;
		}

		const row = [
			...this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT
						COALESCE(thread_id, id) as raw_thread_id,
						thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
					FROM emails
					WHERE ${inFolderSql()}
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						CASE
							WHEN thread_id IS NOT NULL THEN raw_thread_id
							WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
							ELSE raw_thread_id
						END as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT conversation_id) as total
				FROM thread_to_conversation`,
				folder,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		const email = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: emailAttachments,
			labels: this.#labelsByThreadKey([email.thread_id ?? email.id]).get(email.thread_id ?? email.id) ?? [],
			reminders: this.reminders.forThread(email.thread_id ?? email.id),
			send_at: this.scheduled.sendAt(email.id),
		};
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	async getThreadEmails(threadId: string) {
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails WHERE thread_id = ?1 ORDER BY date ASC`,
				threadId,
			),
		] as any[];

		if (emailRows.length === 0) return [];

		const emailIds = emailRows.map((e) => e.id as string);

		// Batch-fetch all attachments for the thread in a single query
		const placeholders = emailIds.map((_, i) => `?${i + 1}`).join(",");
		const attachmentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
				...emailIds,
			),
		] as any[];

		// Group attachments by email_id
		const attachmentsByEmail = new Map<string, any[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		// Mail App: the conversation's snooze and reminder, as getEmail has them (this fills the same cache).
		const reminders = this.reminders.forThread(threadId);
		return this.#withLabels(emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
			reminders,
			send_at: email.folder_id === Folders.SCHEDULED ? this.scheduled.sendAt(String(email.id)) : null,
		})));
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.db
			.update(schema.emails)
			.set(data)
			.where(eq(schema.emails.id, id))
			.run();

		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
			threadId,
		);
		return { threadId, markedRead: true };
	}

	async deleteEmail(id: string) {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		this.db
			.delete(schema.emails)
			.where(eq(schema.emails.id, id))
			.run();
		this.ctx.storage.sql.exec(`DELETE FROM email_labels WHERE email_id = ?1`, id);

		return emailAttachments;
	}

	async getAttachment(id: string) {
		return (
			this.db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.id, id))
				.get() ?? null
		);
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				// Mail App: snoozed mail doesn't count as unread until it's back.
				// Mail App: Scheduled shows how many are waiting to go.
				unreadCount: sql<number>`CASE WHEN ${schema.folders.id} = 'snoozed' THEN 0 WHEN ${schema.folders.id} = 'scheduled' THEN COUNT(${schema.emails.id}) ELSE COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0) END`.mapWith(Number),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	async createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({ id, name, is_deletable })
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		const result = this.db
			.update(schema.folders)
			.set({ name })
			.where(eq(schema.folders.id, id))
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return result;
	}

	async deleteFolder(id: string) {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder || folder.is_deletable === 0) {
			return false;
		}

		this.db
			.delete(schema.folders)
			.where(eq(schema.folders.id, id))
			.run();

		return true;
	}

	/**
	 * Mail App: act on whole conversations at once, for the tick boxes in the list and the Archive button.
	 * Each id is a message shown in the list; moving or deleting takes every message of its conversation
	 * that's in the same folder (so your replies stay in Sent), and read/unread covers the conversation.
	 * Returns the attachments of deleted messages, so their files can be removed too. Mail App: fromFolder is
	 * the folder being looked at, which for a "no reply" reminder back in the Inbox isn't the message's own.
	 */
	async updateConversations(ids: string[], action: ConversationAction, folderId?: string, fromFolder?: string) {
		const sql = this.ctx.storage.sql;
		if (action === "move" && !folderId) return null;
		if (folderId && ![...sql.exec(`SELECT id FROM folders WHERE id = ?1`, folderId)].length) return null;
		const removed: { email_id: string; id: string; filename: string }[] = [];
		// Mail App: moves into or out of Spam, learnt once the move is done.
		const moves: { ids: string[]; from: string }[] = [];
		this.ctx.storage.transactionSync(() => {
			for (const id of ids) {
				const anchor = [...sql.exec(`SELECT ${THREAD_KEY_SQL} AS k, folder_id FROM emails WHERE id = ?1`, id)][0];
				if (!anchor) continue;
				const key = String(anchor.k);
				const source = fromFolder ?? String(anchor.folder_id);
				const sameFolder = `${THREAD_KEY_SQL} = ?1 AND folder_id = ?2`;
				switch (action) {
					case "move":
						if (source === Folders.SPAM || folderId === Folders.SPAM) {
							moves.push({ ids: [...sql.exec(`SELECT id FROM emails WHERE ${sameFolder}`, key, source)].map((r) => String(r.id)), from: source });
						}
						sql.exec(`UPDATE emails SET folder_id = ?3 WHERE ${sameFolder}`, key, source, folderId!);
						break;
					case "read":
						sql.exec(`UPDATE emails SET read = 1 WHERE ${THREAD_KEY_SQL} = ?1 AND read = 0`, key);
						break;
					case "unread":
						sql.exec(`UPDATE emails SET read = 0 WHERE id = ?1`, id);
						break;
					case "delete": {
						const doomed = [...sql.exec(`SELECT id FROM emails WHERE ${sameFolder}`, key, source)].map((r) => String(r.id));
						for (const emailId of doomed) {
							for (const att of sql.exec(`SELECT id, filename FROM attachments WHERE email_id = ?1`, emailId)) {
								removed.push({ email_id: emailId, id: String(att.id), filename: String(att.filename) });
							}
							sql.exec(`DELETE FROM attachments WHERE email_id = ?1`, emailId);
							sql.exec(`DELETE FROM email_labels WHERE email_id = ?1`, emailId);
							sql.exec(`DELETE FROM emails WHERE id = ?1`, emailId);
						}
						break;
					}
				}
				if (action === "move" || action === "delete") this.reminders.afterChange(key, source);
			}
		});
		for (const m of moves) this.spamLearning.moved(m.ids, m.from, folderId!);
		return removed;
	}

	/**
	 * Mail App: runs one inbox rule on mail already in the Inbox ("Apply to existing mail too").
	 * Looks at the newest 5,000 messages. Returns how many conversations it changed.
	 */
	async applyRuleToInbox(rule: InboxRule): Promise<number> {
		const sql = this.ctx.storage.sql;
		const folderId = rule.actions.folder;
		if (folderId && ![...sql.exec(`SELECT id FROM folders WHERE id = ?1`, folderId)].length) return 0;
		const needsBody = rule.conditions.some((c) => c.field === "body");
		const rows = [...sql.exec(
			`SELECT e.id, COALESCE(e.thread_id, e.id) AS k, e.sender, e.sender_name, e.recipient, e.cc, e.subject, ${needsBody ? "e.body" : "'' AS body"}, ${DELIVERED_TO_SQL("e")} AS delivered_to,
				EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = e.id AND COALESCE(a.disposition, 'attachment') != 'inline') AS has_att
			FROM emails e WHERE e.folder_id = ?1 ORDER BY e.date DESC LIMIT 5000`,
			Folders.INBOX,
		)];
		const keys = new Set<string>();
		for (const r of rows) {
			const message: RuleMessage = {
				sender: String(r.sender ?? ""),
				senderName: r.sender_name == null ? null : String(r.sender_name),
				recipients: [String(r.recipient ?? ""), String(r.cc ?? ""), String(r.delivered_to ?? "")].join(",").split(",").map((x) => x.trim()).filter(Boolean),
				subject: String(r.subject ?? ""),
				body: "",
				hasAttachment: !!r.has_att,
			};
			if (!ruleMatches(rule, message, needsBody ? bodyText(String(r.body ?? "")) : "")) continue;
			keys.add(String(r.k));
		}
		const labels = rule.actions.labels ?? [];
		const known = new Set([...sql.exec(`SELECT id FROM labels`)].map((r) => String(r.id)));
		this.ctx.storage.transactionSync(() => {
			for (const key of keys) {
				const inInbox = `${THREAD_KEY_SQL} = ?1 AND folder_id = ?2`;
				if (rule.actions.markRead) sql.exec(`UPDATE emails SET read = 1 WHERE ${inInbox}`, key, Folders.INBOX);
				if (rule.actions.star) sql.exec(`UPDATE emails SET starred = 1 WHERE ${inInbox}`, key, Folders.INBOX);
				for (const labelId of labels) {
					if (!known.has(labelId)) continue;
					sql.exec(`INSERT OR IGNORE INTO email_labels (email_id, label_id) SELECT id, ?1 FROM emails WHERE ${THREAD_KEY_SQL} = ?2`, labelId, key);
				}
				if (folderId && folderId !== Folders.INBOX) sql.exec(`UPDATE emails SET folder_id = ?3 WHERE ${inInbox}`, key, Folders.INBOX, folderId);
			}
		});
		return keys.size;
	}

	/** Mail App: "Mark all as read" for a folder, or for a label's page. */
	async markAllRead(where: { folderId?: string; labelId?: string }) {
		const sql = this.ctx.storage.sql;
		if (where.labelId) {
			sql.exec(
				`UPDATE emails SET read = 1 WHERE read = 0 AND ${THREAD_KEY_SQL} IN (
					SELECT DISTINCT COALESCE(e.thread_id, e.id) FROM email_labels el JOIN emails e ON e.id = el.email_id WHERE el.label_id = ?1
				)`,
				where.labelId,
			);
		} else if (where.folderId) {
			sql.exec(`UPDATE emails SET read = 1 WHERE read = 0 AND folder_id = ?1`, where.folderId);
		}
		return true;
	}

	async moveEmail(id: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;

		const from = this.db.select({ folder: schema.emails.folder_id }).from(schema.emails).where(eq(schema.emails.id, id)).get()?.folder;
		this.db
			.update(schema.emails)
			.set({ folder_id: folderId })
			.where(eq(schema.emails.id, id))
			.run();
		if (from) this.spamLearning.moved([id], from, folderId);

		return true;
	}

	// ── Search (raw SQL — dynamic condition builder) ───────────────

	/**
	 * Build WHERE conditions and params for search queries.
	 * Shared between searchEmails and countSearchResults.
	 */
	#buildSearchConditions(
		options: SearchFilterOptions,
		tableAlias = "",
	): { conditions: string[]; params: (string | number)[] } {
		const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment, label } = options;
		const prefix = tableAlias ? `${tableAlias}.` : "";
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		let paramIdx = 0;

		const addParam = (value: string | number) => {
			paramIdx++;
			params.push(value);
			return `?${paramIdx}`;
		};

		if (query) {
			const p1 = addParam(`%${query}%`);
			const p2 = addParam(`%${query}%`);
			const p3 = addParam(`%${query}%`);
			const p4 = addParam(`%${query}%`);
			conditions.push(`(${prefix}subject LIKE ${p1} OR ${prefix}body LIKE ${p2} OR ${prefix}sender LIKE ${p3} OR ${prefix}recipient LIKE ${p4} OR ${prefix}cc LIKE ${p4} OR ${prefix}bcc LIKE ${p4})`);
		}
		if (folder) {
			const p = addParam(folder);
			conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
		}
		if (from) { const p = addParam(`%${from}%`); conditions.push(`${prefix}sender LIKE ${p}`); }
		if (to) { const p = addParam(`%${to}%`); conditions.push(`(${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p} OR ${prefix}bcc LIKE ${p})`); }
		if (subject) { const p = addParam(`%${subject}%`); conditions.push(`${prefix}subject LIKE ${p}`); }
		if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
		if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
		if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
		if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
		if (has_attachment) { conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`); }
		if (label) {
			const p = addParam(label);
			conditions.push(`COALESCE(${prefix}thread_id, ${prefix}id) IN (
				SELECT COALESCE(le.thread_id, le.id) FROM email_labels el
				JOIN labels l ON l.id = el.label_id JOIN emails le ON le.id = el.email_id
				WHERE LOWER(l.name) = LOWER(${p}))`);
		}

		return { conditions, params };
	}

	async searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = this.#buildSearchConditions(options, "e");

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = (page - 1) * limit;

		const query = `
			SELECT e.id, e.subject, e.sender, e.sender_name, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
		params.push(limit, offset);

		const result = this.ctx.storage.sql.exec(query, ...params);
		return this.#withLabels([...result].map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
		})));
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	async countSearchResults(options: SearchFilterOptions) {
		const { conditions, params } = this.#buildSearchConditions(options);

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT COUNT(*) as total FROM emails ${where}`;

		const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	async findThreadBySubject(subject: string, senderAddress?: string, viaAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		const result = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
		);

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of result) {
			const rowSubject = String((row as any).subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = String((row as any).senders || "");
				const threadRecipients = String((row as any).recipients || "");
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			// Mail App: mail that came in on an extra address only joins a conversation that address is
			// already part of, so a "Test" to hello@ doesn't land in an older "Test" to your main address.
			const via = viaAddress?.toLowerCase().trim();
			if (via) {
				const people = `${String((row as any).senders || "")},${String((row as any).recipients || "")}`;
				if (!people.includes(via)) continue;
			}

			return String((row as any).thread_id);
		}
		return null;
	}

	/**
	 * Mail App: someone you know: a saved contact, or someone you've sent an email to. Their mail skips
	 * the automatic spam checks (the block list still applies).
	 */
	/** Mail App: how likely new mail is spam, from what this mailbox has learnt (null until it has learnt enough). */
	async learntSpamProbability(tokens: string[]) { return this.spamLearning.probability(tokens); }
	/** Mail App: learn new mail as spam or genuine without anyone pressing anything (very clear cases only). */
	async learnNewEmail(emailId: string, asSpam: boolean, tokens: string[]) { this.spamLearning.learn(emailId, asSpam, tokens); return true; }
	async spamLearningSummary() { return this.spamLearning.summary(); }

	async knowsSender(address: string): Promise<boolean> {
		const a = address.trim().toLowerCase();
		if (!a.includes("@")) return false;
		const sql = this.ctx.storage.sql;
		if ([...sql.exec(`SELECT 1 FROM contacts WHERE email = ?1 AND hidden = 0 LIMIT 1`, a)].length) return true;
		const like = `%${a.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
		return [...sql.exec(
			`SELECT 1 FROM emails WHERE folder_id = ?1 AND (LOWER(recipient) LIKE ?2 ESCAPE '\\' OR LOWER(cc) LIKE ?2 ESCAPE '\\' OR LOWER(bcc) LIKE ?2 ESCAPE '\\') LIMIT 1`,
			Folders.SENT, like,
		)].length > 0;
	}

	/** Mail App: the conversation holding any of these Message-IDs (newest reference first), or null. */
	async findThreadByMessageIds(messageIds: string[]): Promise<string | null> {
		for (const id of [...messageIds].reverse().slice(0, 50)) {
			const row = [...this.ctx.storage.sql.exec(
				`SELECT COALESCE(thread_id, id) AS k FROM emails WHERE message_id = ?1 LIMIT 1`,
				id,
			)][0];
			if (row) return String(row.k);
		}
		return null;
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 * Limits: 20 emails per hour, 100 per day per mailbox.
	 * Returns null if under limit, or an error message string if exceeded.
	 */
	// -- Mail App: contacts --------------------------------------------------

	async getContacts(self: string, fromEmails = true) {
		const sql = this.ctx.storage.sql;
		const saved = [...sql.exec(`SELECT email, name, notes, hidden FROM contacts`)] as unknown as SavedContactRow[];
		const sentRows = [...sql.exec(
			`SELECT recipient, cc, bcc, date FROM emails WHERE folder_id = ?1 ORDER BY date DESC LIMIT 5000`,
			Folders.SENT,
		)] as unknown as { recipient: string | null; cc: string | null; bcc: string | null; date: string | null }[];
		// Names people use for themselves, from the From line of mail they've sent you (newest wins).
		const knownNames = new Map<string, string>();
		for (const row of sql.exec(
			`SELECT sender, raw_headers FROM emails WHERE folder_id NOT IN (?1, ?2, ?3) AND raw_headers IS NOT NULL ORDER BY date DESC LIMIT 2000`,
			Folders.SENT, Folders.DRAFT, Folders.SPAM,
		)) {
			const sender = String(row.sender ?? "").toLowerCase();
			if (!sender || knownNames.has(sender)) continue;
			try {
				const from = (JSON.parse(String(row.raw_headers)) as { key: string; value: string }[]).find((h) => h.key === "from");
				const name = from ? displayName(from.value) : "";
				if (name) knownNames.set(sender, name);
			} catch { /* unreadable headers: no name */ }
		}
		const contacts = buildContacts(saved, sentRows, knownNames, self);
		// Switched off in Settings: only the contacts you've saved yourself (still with how often you've emailed them).
		return fromEmails ? contacts : contacts.filter((c) => c.saved);
	}

	async saveContact(email: string, name: string, notes: string) {
		this.ctx.storage.sql.exec(
			`INSERT INTO contacts (email, name, notes, hidden, updated_at) VALUES (?1, ?2, ?3, 0, ?4)
			 ON CONFLICT(email) DO UPDATE SET name = ?2, notes = ?3, hidden = 0, updated_at = ?4`,
			email.toLowerCase(), name, notes, new Date().toISOString(),
		);
	}

	/**
	 * Adds imported people. Anyone already saved is left as they are; someone you removed comes back,
	 * because importing them is asking for them. Returns how many were added.
	 */
	async importContacts(people: { email: string; name: string; notes: string }[]) {
		const sql = this.ctx.storage.sql;
		const now = new Date().toISOString();
		let added = 0;
		this.ctx.storage.transactionSync(() => {
			for (const p of people) {
				const row = [...sql.exec(`SELECT hidden FROM contacts WHERE email = ?1`, p.email)][0];
				if (row && !row.hidden) continue;
				sql.exec(
					`INSERT INTO contacts (email, name, notes, hidden, updated_at) VALUES (?1, ?2, ?3, 0, ?4)
					 ON CONFLICT(email) DO UPDATE SET name = ?2, notes = ?3, hidden = 0, updated_at = ?4`,
					p.email, p.name, p.notes, now,
				);
				added++;
			}
		});
		return added;
	}

	/** Removes a contact. Someone you've emailed stays hidden, rather than coming back on its own. */
	async removeContact(email: string) {
		this.ctx.storage.sql.exec(
			`INSERT INTO contacts (email, name, notes, hidden, updated_at) VALUES (?1, NULL, NULL, 1, ?2)
			 ON CONFLICT(email) DO UPDATE SET name = NULL, notes = NULL, hidden = 1, updated_at = ?2`,
			email.toLowerCase(), new Date().toISOString(),
		);
	}

	// -- Mail App: labels ------------------------------------------------------

	/** Label ids for each conversation, keyed by COALESCE(thread_id, id). */
	#labelsByThreadKey(keys: string[]): Map<string, string[]> {
		const out = new Map<string, string[]>();
		const unique = [...new Set(keys.filter(Boolean))];
		// Kept in batches well under SQLite's limit on query parameters.
		for (let i = 0; i < unique.length; i += 90) {
			const batch = unique.slice(i, i + 90);
			const placeholders = batch.map((_, j) => `?${j + 1}`).join(",");
			for (const row of this.ctx.storage.sql.exec(
				`SELECT DISTINCT COALESCE(e.thread_id, e.id) AS k, el.label_id AS label_id
				 FROM email_labels el JOIN emails e ON e.id = el.email_id
				 WHERE COALESCE(e.thread_id, e.id) IN (${placeholders})`,
				...batch,
			)) {
				const k = String(row.k);
				const list = out.get(k) ?? [];
				list.push(String(row.label_id));
				out.set(k, list);
			}
		}
		return out;
	}

	/** Adds each row's conversation labels as `labels`. */
	#withLabels<T extends { id: string; thread_id?: string | null }>(rows: T[]): (T & { labels: string[] })[] {
		if (rows.length === 0) return [];
		const byKey = this.#labelsByThreadKey(rows.map((r) => r.thread_id ?? r.id));
		return rows.map((r) => ({ ...r, labels: byKey.get(r.thread_id ?? r.id) ?? [] }));
	}

	async getLabels(): Promise<Label[]> {
		const sql = this.ctx.storage.sql;
		const unread = new Map<string, number>();
		for (const row of sql.exec(
			`WITH labelled AS (
				SELECT DISTINCT el.label_id, COALESCE(e.thread_id, e.id) AS k
				FROM email_labels el JOIN emails e ON e.id = el.email_id
			)
			SELECT l.label_id AS label_id, COUNT(e.id) AS unread
			FROM labelled l JOIN emails e ON ${THREAD_KEY_SQL} = l.k
			WHERE e.read = 0 AND e.folder_id NOT IN (?1, ?2, ?3)
			GROUP BY l.label_id`,
			Folders.TRASH, Folders.SPAM, Folders.DRAFT,
		)) unread.set(String(row.label_id), Number(row.unread) || 0);
		return [...sql.exec(`SELECT id, name, color FROM labels ORDER BY position, LOWER(name)`)].map((row) => ({
			id: String(row.id),
			name: String(row.name),
			color: String(row.color) as LabelColor,
			unreadCount: unread.get(String(row.id)) ?? 0,
		}));
	}

	/** Puts the labels in the order given. Labels missing from the list keep their place after them. */
	async reorderLabels(ids: string[]) {
		const sql = this.ctx.storage.sql;
		const all = [...sql.exec(`SELECT id FROM labels ORDER BY position, LOWER(name)`)].map((r) => String(r.id));
		const known = new Set(all);
		const order = [...new Set(ids.filter((id) => known.has(id))), ...all.filter((id) => !ids.includes(id))];
		this.ctx.storage.transactionSync(() => {
			order.forEach((id, i) => sql.exec(`UPDATE labels SET position = ?2 WHERE id = ?1`, id, i));
		});
	}

	#labelNameTaken(name: string, exceptId?: string) {
		return [...this.ctx.storage.sql.exec(
			`SELECT 1 FROM labels WHERE LOWER(name) = LOWER(?1) AND id != ?2 LIMIT 1`,
			name, exceptId ?? "",
		)].length > 0;
	}

	/** Makes a label. Returns "taken" if the name is in use, "full" at the limit. */
	async createLabel(name: string, color: LabelColor): Promise<Label | "taken" | "full"> {
		if (this.#labelNameTaken(name)) return "taken";
		const count = Number([...this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM labels`)][0]?.n ?? 0);
		if (count >= MAX_LABELS) return "full";
		const id = crypto.randomUUID();
		// New labels go at the bottom of the list.
		this.ctx.storage.sql.exec(
			`INSERT INTO labels (id, name, color, created_at, position)
			 VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(position), -1) + 1 FROM labels))`,
			id, name, color, new Date().toISOString(),
		);
		return { id, name, color, unreadCount: 0 };
	}

	/** Renames or recolours a label. Returns null if it's gone, "taken" if the new name is in use. */
	async updateLabel(id: string, changes: { name?: string; color?: LabelColor }): Promise<Label | "taken" | null> {
		const row = [...this.ctx.storage.sql.exec(`SELECT id, name, color FROM labels WHERE id = ?1`, id)][0];
		if (!row) return null;
		const name = changes.name ?? String(row.name);
		const color = changes.color ?? (String(row.color) as LabelColor);
		if (changes.name && this.#labelNameTaken(name, id)) return "taken";
		this.ctx.storage.sql.exec(`UPDATE labels SET name = ?2, color = ?3 WHERE id = ?1`, id, name, color);
		return { id, name, color };
	}

	/** Deletes a label. The emails stay where they are; they just lose the label. */
	async deleteLabel(id: string) {
		this.ctx.storage.sql.exec(`DELETE FROM email_labels WHERE label_id = ?1`, id);
		const before = [...this.ctx.storage.sql.exec(`SELECT 1 FROM labels WHERE id = ?1`, id)].length;
		this.ctx.storage.sql.exec(`DELETE FROM labels WHERE id = ?1`, id);
		return before > 0;
	}

	/**
	 * Adds and removes labels on the whole conversation an email belongs to.
	 * Returns the conversation's labels afterwards, or null if the email isn't there.
	 */
	async setConversationLabels(emailId: string, add: string[], remove: string[]): Promise<string[] | null> {
		const sql = this.ctx.storage.sql;
		const email = [...sql.exec(`SELECT ${THREAD_KEY_SQL} AS k FROM emails WHERE id = ?1`, emailId)][0];
		if (!email) return null;
		const key = String(email.k);
		const known = new Set([...sql.exec(`SELECT id FROM labels`)].map((r) => String(r.id)));
		this.ctx.storage.transactionSync(() => {
			for (const labelId of remove) {
				sql.exec(
					`DELETE FROM email_labels WHERE label_id = ?1 AND email_id IN (SELECT id FROM emails WHERE ${THREAD_KEY_SQL} = ?2)`,
					labelId, key,
				);
			}
			for (const labelId of add) {
				if (!known.has(labelId)) continue;
				sql.exec(
					`INSERT OR IGNORE INTO email_labels (email_id, label_id) SELECT id, ?1 FROM emails WHERE ${THREAD_KEY_SQL} = ?2`,
					labelId, key,
				);
			}
		});
		return this.#labelsByThreadKey([key]).get(key) ?? [];
	}

	/** Conversations with a label, newest first, from every folder apart from Spam and Trash. */
	async getLabelledEmails(labelId: string, page = 1, rawLimit = 25) {
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const offset = (Math.max(page, 1) - 1) * limit;
		const rows = [...this.ctx.storage.sql.exec(
			`WITH
			keys AS (
				SELECT DISTINCT COALESCE(e.thread_id, e.id) AS k
				FROM email_labels el JOIN emails e ON e.id = el.email_id
				WHERE el.label_id = ?1
			),
			conv AS (
				SELECT e.*, ${THREAD_KEY_SQL} AS k FROM emails e
				WHERE ${THREAD_KEY_SQL} IN (SELECT k FROM keys) AND e.folder_id NOT IN (?2, ?3)
			),
			stats AS (
				SELECT k,
					COUNT(*) AS thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS thread_unread_count,
					GROUP_CONCAT(DISTINCT COALESCE(NULLIF(sender_name, ''), sender)) AS participants,
					SUM(CASE WHEN folder_id = ?4 THEN 1 ELSE 0 END) AS has_draft
				FROM conv GROUP BY k
			),
			latest AS (
				SELECT conv.*, ROW_NUMBER() OVER (PARTITION BY k ORDER BY date DESC) AS rn FROM conv
			)
			SELECT l.id, l.subject, l.sender, l.sender_name, l.recipient, l.date, l.read, l.starred,
				l.thread_id, l.folder_id, l.in_reply_to, l.email_references,
				SUBSTR(l.body, 1, 300) AS snippet,
				s.thread_count, s.thread_unread_count, s.participants, s.has_draft
			FROM latest l JOIN stats s ON s.k = l.k
			WHERE l.rn = 1
			ORDER BY l.date DESC
			LIMIT ?5 OFFSET ?6`,
			labelId, Folders.TRASH, Folders.SPAM, Folders.DRAFT, limit, offset,
		)] as any[];
		return this.#withLabels(rows.map((row) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			has_draft: !!row.has_draft,
		})));
	}

	async countLabelledEmails(labelId: string) {
		const row = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(DISTINCT ${THREAD_KEY_SQL}) AS total FROM emails
			 WHERE folder_id NOT IN (?2, ?3) AND ${THREAD_KEY_SQL} IN (
				SELECT COALESCE(e.thread_id, e.id) FROM email_labels el JOIN emails e ON e.id = el.email_id WHERE el.label_id = ?1
			 )`,
			labelId, Folders.TRASH, Folders.SPAM,
		)][0];
		return Number(row?.total ?? 0);
	}

	/**
	 * Checks a send against this mailbox's limit and, when it's allowed, counts it straight away (one step,
	 * so sends at the same moment can't all slip under the limit). `recipients` is everyone in to, cc and bcc.
	 */
	async checkSendRateLimit(recipients = 1): Promise<string | null> {
		const now = Date.now();
		const n = Math.max(1, Math.floor(Number(recipients) || 1));
		const sql = this.ctx.storage.sql;
		const sum = (since: number) => Number(([...sql.exec(`SELECT COALESCE(SUM(recipients), 0) AS n FROM send_log WHERE sent_at >= ?`, since)][0] as { n: number } | undefined)?.n ?? 0);
		const error = sendLimitError(n, sum(now - 3_600_000), sum(now - 86_400_000));
		if (error) return error;
		sql.exec(`INSERT INTO send_log (sent_at, recipients) VALUES (?, ?)`, now, n);
		sql.exec(`DELETE FROM send_log WHERE sent_at < ?`, now - 2 * 86_400_000);
		return null;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	async createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	) {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;
		const isSent = folderId === Folders.SENT || folderId === Folders.SCHEDULED; // Mail App: and scheduled ones

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		this.db
			.insert(schema.emails)
			.values({
				id: email.id,
				folder_id: folderId,
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
				date: email.date,
				read: isSent ? 1 : (email.read ? 1 : 0),
				starred: email.starred ? 1 : 0,
				body: email.body,
				in_reply_to: email.in_reply_to ?? null,
				email_references: email.email_references ?? null,
				thread_id: email.thread_id ?? null,
				message_id: email.message_id ?? null,
				raw_headers: email.raw_headers ?? null,
				sender_name: cleanSenderName(email.sender_name ?? fromHeaderName(email.raw_headers)) || null,
				sent_by: email.sent_by ?? null,
				sent_by_name: email.sent_by_name ?? null,
			})
			.run();

		if (attachments.length > 0) {
			this.db.insert(schema.attachments).values(attachments).run();
		}
		// Mail App: new mail wakes a snoozed conversation, and ends a "Remind me if no reply".
		this.reminders.onNewMessage(email.thread_id ?? email.id, email.id, folderId);
	}
}
