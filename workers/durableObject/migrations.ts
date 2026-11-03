// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: contacts and labels tables; backups; the calendar; snooze and reminders; calendars from other websites; the daily tally for Admin > Reports; learning from Spam and Not spam.

export interface Migration {
	name: string;
	sql: string;
}

/**
 * Minimal migration runner that replaces workers-qb's DOQB.migrations().apply().
 *
 * Uses the `d1_migrations` tracking table for backward compatibility with
 * existing deployments that were managed by workers-qb. New deployments
 * create the same table so the schema is consistent either way.
 */
export function applyMigrations(
	sql: SqlStorage,
	migrations: Migration[],
	storage?: DurableObjectStorage,
): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);

	for (const migration of migrations) {
		const applied = [
			...sql.exec(
				`SELECT 1 FROM d1_migrations WHERE name = ?`,
				migration.name,
			),
		];
		if (applied.length > 0) continue;

		// Strip any existing BEGIN/COMMIT wrapper from the migration SQL.
		// Cloudflare's DO runtime forbids SQL-level transactions -- must use
		// the JS storage.transactionSync() API instead.
		let migrationSql = migration.sql.trim();
		migrationSql = migrationSql.replace(/^\s*BEGIN\s+TRANSACTION\s*;?\s*/i, "");
		migrationSql = migrationSql.replace(/\s*COMMIT\s*;?\s*$/i, "");

		const escapedName = migration.name.replace(/'/g, "''");
		const run = () => {
			sql.exec(migrationSql);
			sql.exec(
				`INSERT INTO d1_migrations (name) VALUES ('${escapedName}')`,
			);
		};

		if (storage) {
			// Preferred: atomic transaction via the DO JS API
			storage.transactionSync(run);
		} else {
			// Fallback: run without explicit transaction (each exec is auto-committed)
			run();
		}
	}
}

interface DurableObjectStorage {
	transactionSync: <T>(closure: () => T) => T;
}

/**
 * Wrap SQL in a transaction so multi-statement migrations are atomic.
 *
 * Without this, a migration like `1_initial_setup` (CREATE + INSERT +
 * CREATE + CREATE) could fail mid-way and leave the database in an
 * inconsistent state that the runner considers "applied" but is
 * actually broken.  SQLite transactions guarantee all-or-nothing.
 *
 * Single-statement migrations don't strictly need it but wrapping
 * uniformly costs nothing and avoids accidental omissions.
 */
function txn(sql: string): string {
	const trimmed = sql.trim();
	// Don't double-wrap if someone already added BEGIN/COMMIT
	if (/^\s*BEGIN\b/i.test(trimmed)) return trimmed;
	return `BEGIN TRANSACTION;\n${trimmed}\nCOMMIT;`;
}

export const mailboxMigrations: Migration[] = [
	{
		name: "1_initial_setup",
		sql: txn(`
            CREATE TABLE folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                is_deletable INTEGER NOT NULL DEFAULT 1
            );

            INSERT INTO folders (id, name, is_deletable) VALUES
                ('inbox', 'Inbox', 0),
                ('sent', 'Sent', 0),
                ('trash', 'Trash', 0),
                ('archive', 'Archive', 0),
                ('spam', 'Spam', 0);

            CREATE TABLE emails (
                id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                subject TEXT,
                sender TEXT,
                recipient TEXT,
                date TEXT,
                read INTEGER DEFAULT 0,
                starred INTEGER DEFAULT 0,
                body TEXT,
                FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
            );

            CREATE TABLE attachments (
                id TEXT PRIMARY KEY,
                email_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                mimetype TEXT NOT NULL,
                size INTEGER NOT NULL,
                content_id TEXT,
                disposition TEXT,
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
            );
        `),
	},
	{
		name: "2_add_email_threading",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
            ALTER TABLE emails ADD COLUMN email_references TEXT;
            ALTER TABLE emails ADD COLUMN thread_id TEXT;

            CREATE INDEX idx_emails_thread_id ON emails(thread_id);
            CREATE INDEX idx_emails_in_reply_to ON emails(in_reply_to);
        `),
	},
	{
		name: "3_add_draft_folder",
		sql: txn(`INSERT INTO folders (id, name, is_deletable) VALUES ('draft', 'Drafts', 0);`),
	},
	{
		name: "4_add_message_id",
		sql: txn(`ALTER TABLE emails ADD COLUMN message_id TEXT;`),
	},
	{
		name: "5_add_raw_headers",
		sql: txn(`ALTER TABLE emails ADD COLUMN raw_headers TEXT;`),
	},
	{
		name: "6_mark_sent_emails_as_read",
		sql: txn(`UPDATE emails SET read = 1 WHERE folder_id = 'sent' AND read = 0;`),
	},
	{
		name: "7_add_cc_bcc",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN cc TEXT;
            ALTER TABLE emails ADD COLUMN bcc TEXT;
        `),
	},
	{
		// No txn() wrapper: Cloudflare's DO runtime requires state.storage.transactionSync()
		// instead of SQL-level BEGIN TRANSACTION. These are idempotent CREATE INDEX IF NOT EXISTS
		// statements so they're safe to run without a transaction.
		name: "8_add_folder_date_indexes",
		sql: `
            CREATE INDEX IF NOT EXISTS idx_emails_folder_id ON emails(folder_id);
            CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
            CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(folder_id, date DESC);
        `,
	},
	{
		// Mail App: saved contact details. Anyone you've emailed shows up without a row here; a row with
		// hidden = 1 means you removed them from your contacts.
		name: "9_add_contacts",
		sql: `
            CREATE TABLE IF NOT EXISTS contacts (
                email TEXT PRIMARY KEY,
                name TEXT,
                notes TEXT,
                hidden INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );
        `,
	},
	{
		// Mail App: labels. A label is put on every message in a conversation, so the whole conversation
		// shows it wherever its messages are.
		name: "10_add_labels",
		sql: `
            CREATE TABLE IF NOT EXISTS labels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS email_labels (
                email_id TEXT NOT NULL,
                label_id TEXT NOT NULL,
                PRIMARY KEY (email_id, label_id),
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE,
                FOREIGN KEY(label_id) REFERENCES labels(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_email_labels_label ON email_labels(label_id);
            CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
        `,
	},
	{
		// Mail App: labels can be put in any order. Existing labels keep their A to Z order.
		name: "11_add_label_position",
		sql: `
            ALTER TABLE labels ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
            UPDATE labels SET position = (SELECT COUNT(*) FROM labels l2 WHERE LOWER(l2.name) < LOWER(labels.name));
        `,
	},
	{
		// Mail App: keep the sender's name ("Hannah Clarke") so lists can show it instead of "hannah".
		// Existing mail gets it from the From line kept in raw_headers; encoded names are skipped.
		name: "12_add_sender_name",
		sql: `
            ALTER TABLE emails ADD COLUMN sender_name TEXT;
            UPDATE emails SET sender_name = (
                SELECT TRIM(REPLACE(REPLACE(SUBSTR(v, 1, INSTR(v, '<') - 1), ',', ' '), '"', ''))
                FROM (
                    SELECT json_extract(h.value, '$.value') AS v FROM json_each(emails.raw_headers) h
                    WHERE LOWER(json_extract(h.value, '$.key')) = 'from' LIMIT 1
                )
                WHERE INSTR(v, '<') > 1 AND v NOT LIKE '%=?%'
            )
            WHERE raw_headers IS NOT NULL AND json_valid(raw_headers);
            UPDATE emails SET sender_name = NULL WHERE sender_name = '' OR sender_name LIKE '%@%';
        `,
	},
	{
		// Mail App: backups. Each is a standard .mbox file kept in R2 in numbered pieces; one job runs at a time.
		name: "13_add_backups",
		sql: `
            CREATE TABLE IF NOT EXISTS backups (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                emails INTEGER NOT NULL DEFAULT 0,
                total INTEGER NOT NULL DEFAULT 0,
                size INTEGER NOT NULL DEFAULT 0,
                pieces INTEGER NOT NULL DEFAULT 0,
                cursor_date TEXT,
                cursor_id TEXT,
                error TEXT
            );
            CREATE TABLE IF NOT EXISTS backup_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                mailbox_id TEXT,
                nightly INTEGER NOT NULL DEFAULT 1,
                keep INTEGER NOT NULL DEFAULT 3
            );
            INSERT OR IGNORE INTO backup_settings (id) VALUES (1);
        `,
	},
	{
		// Mail App: in a shared mailbox, who on the team sent each email (their sign-in address and name).
		name: "14_add_sent_by",
		sql: `
            ALTER TABLE emails ADD COLUMN sent_by TEXT;
            ALTER TABLE emails ADD COLUMN sent_by_name TEXT;
        `,
	},
	{
		// Mail App: the calendar. Times are kept as wall-clock times with their time zone; first_start_ms and
		// last_end_ms (real moments, null = repeats for ever) let a month be found quickly.
		// backup_settings.next_at: when the nightly backup is due, now that reminders share the alarm.
		name: "15_add_calendar",
		sql: `
            CREATE TABLE IF NOT EXISTS calendars (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS calendar_events (
                id TEXT PRIMARY KEY,
                calendar_id TEXT NOT NULL,
                title TEXT NOT NULL,
                all_day INTEGER NOT NULL DEFAULT 0,
                start TEXT NOT NULL,
                end TEXT NOT NULL,
                time_zone TEXT NOT NULL,
                location TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                color TEXT,
                private INTEGER NOT NULL DEFAULT 0,
                repeat TEXT,
                exceptions TEXT NOT NULL DEFAULT '[]',
                reminders TEXT NOT NULL DEFAULT '[]',
                created_by TEXT,
                created_by_name TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                first_start_ms INTEGER NOT NULL,
                last_end_ms INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_calendar_events_calendar ON calendar_events(calendar_id);
            CREATE INDEX IF NOT EXISTS idx_calendar_events_span ON calendar_events(first_start_ms, last_end_ms);
            CREATE TABLE IF NOT EXISTS calendar_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                reminders_checked_at INTEGER,
                next_reminder_at INTEGER
            );
            ALTER TABLE backup_settings ADD COLUMN next_at INTEGER;
        `,
	},
	{
		// Mail App: webhook events that didn't get through, waiting to be tried again (from the shared alarm).
		name: "16_add_webhook_retries",
		sql: `
            CREATE TABLE IF NOT EXISTS webhook_retries (
                id TEXT PRIMARY KEY,
                webhook_id TEXT NOT NULL,
                event TEXT NOT NULL,
                body TEXT NOT NULL,
                attempt INTEGER NOT NULL,
                due_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_webhook_retries_due ON webhook_retries(due_at);
        `,
	},
	{
		// Mail App: calendar invites. uid and organizer are set on events we were invited to; guests (JSON) on
		// any event with people invited; sequence counts the changes we've sent guests; meeting_url is a
		// Teams, Zoom or other video call link.
		name: "17_add_calendar_invites",
		sql: `
            ALTER TABLE calendar_events ADD COLUMN uid TEXT;
            ALTER TABLE calendar_events ADD COLUMN organizer TEXT;
            ALTER TABLE calendar_events ADD COLUMN guests TEXT NOT NULL DEFAULT '[]';
            ALTER TABLE calendar_events ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE calendar_events ADD COLUMN meeting_url TEXT NOT NULL DEFAULT '';
            CREATE INDEX IF NOT EXISTS idx_calendar_events_uid ON calendar_events(uid);
        `,
	},
	{
		name: "18_add_calendar_recurrence_id",
		sql: `
            ALTER TABLE calendar_events ADD COLUMN recurrence_id TEXT;
        `,
	},
	{
		// Mail App: Files, private storage for documents and photos. The files themselves are in R2 at
		// files/<mailbox>/<id>; this keeps their names and folders. upload_id is set while a big file is
		// still going up in parts; binned_at while it's in the Bin.
		name: "19_add_files",
		sql: `
            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                size INTEGER NOT NULL DEFAULT 0,
                type TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                created_by TEXT,
                created_by_name TEXT,
                binned_at TEXT,
                upload_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_id);
            CREATE INDEX IF NOT EXISTS idx_files_binned ON files(binned_at);
        `,
	},
	{
		// Mail App: what this mailbox has sent, counted in recipients (see workers/lib/send-limit.ts). Separate
		// from Sent so emptying Sent doesn't reset the sending limit.
		name: "20_add_send_log",
		sql: `
            CREATE TABLE IF NOT EXISTS send_log (
                sent_at INTEGER NOT NULL,
                recipients INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_send_log_sent_at ON send_log(sent_at);
        `,
	},
	{
		// Mail App: snooze and "Remind me if no reply" (see reminders.ts). One of each kind per conversation
		// (thread_key is COALESCE(thread_id, id)). email_id is the sent email a "no-reply" reminder is
		// for; shown is set once it's due and back in the Inbox. A folder of your own called Snoozed is
		// renamed first, so the new Snoozed folder can have the name. emails.back_at is when a
		// conversation came back to the Inbox, so it goes to the top of the list.
		name: "21_add_reminders",
		sql: `
            UPDATE folders SET name = name || ' (your folder)' WHERE LOWER(name) = 'snoozed' AND id != 'snoozed';
            INSERT OR IGNORE INTO folders (id, name, is_deletable) VALUES ('snoozed', 'Snoozed', 0);
            CREATE TABLE IF NOT EXISTS reminders (
                thread_key TEXT NOT NULL,
                kind TEXT NOT NULL,
                due_at INTEGER NOT NULL,
                email_id TEXT,
                shown INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (thread_key, kind)
            );
            CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(shown, due_at);
            ALTER TABLE emails ADD COLUMN back_at TEXT;
        `,
	},
	{
		// Mail App: calendars from other websites (an .ics link), read only. source_tz reads times the file
		// gives without a zone; refreshed_at and refresh_error say how the last update went.
		name: "22_add_outside_calendars",
		sql: `
            ALTER TABLE calendars ADD COLUMN source_url TEXT;
            ALTER TABLE calendars ADD COLUMN source_tz TEXT;
            ALTER TABLE calendars ADD COLUMN refreshed_at TEXT;
            ALTER TABLE calendars ADD COLUMN refresh_error TEXT;
        `,
	},
	{
		// Mail App: Notes (see notes.ts). owner_email is who wrote it; shared is 1 when everyone who can open the
		// mailbox can see and change it. items is the checklist as JSON. remind_at is when to send a
		// reminder, and reminded is set once it's gone. binned_at is set while it's in the Bin.
		name: "23_add_notes",
		sql: `
            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                body TEXT NOT NULL DEFAULT '',
                items TEXT NOT NULL DEFAULT '[]',
                checklist INTEGER NOT NULL DEFAULT 0,
                colour TEXT NOT NULL DEFAULT 'none',
                pinned INTEGER NOT NULL DEFAULT 0,
                shared INTEGER NOT NULL DEFAULT 0,
                remind_at INTEGER,
                reminded INTEGER NOT NULL DEFAULT 0,
                reminder_title TEXT,
                reminder_body TEXT,
                owner_email TEXT NOT NULL,
                owner_name TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                binned_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes(owner_email);
            CREATE INDEX IF NOT EXISTS idx_notes_remind ON notes(reminded, remind_at);
        `,
	},
	{
		// Mail App: scheduled send (see scheduled.ts). Each row is an email in the Scheduled folder and when it
		// goes; what to send is in R2 at scheduled/<mailbox>/<email>.json. A folder of your own called
		// Scheduled is renamed first, so the new folder can have the name.
		name: "24_add_scheduled_send",
		sql: `
            UPDATE folders SET name = name || ' (your folder)' WHERE LOWER(name) = 'scheduled' AND id != 'scheduled';
            INSERT OR IGNORE INTO folders (id, name, is_deletable) VALUES ('scheduled', 'Scheduled', 0);
            CREATE TABLE IF NOT EXISTS scheduled_sends (
                email_id TEXT PRIMARY KEY,
                mailbox TEXT NOT NULL,
                send_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_scheduled_sends_at ON scheduled_sends(send_at);
        `,
	},
	{
		// Mail App: Admin > Reports (see stats.ts). A tally per day of mail in and out, and the last few sends that
		// failed. The 'start' row marks the day the tally began; earlier days come from the mail itself.
		name: "25_add_daily_counts",
		sql: `
            CREATE TABLE IF NOT EXISTS daily_counts (
                day TEXT NOT NULL,
                kind TEXT NOT NULL,
                n INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (day, kind)
            );
            INSERT OR IGNORE INTO daily_counts (day, kind, n) VALUES (date('now'), 'start', 0);
            CREATE TABLE IF NOT EXISTS send_failures (
                at INTEGER NOT NULL,
                recipient TEXT NOT NULL,
                error TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_send_failures_at ON send_failures(at);
        `,
	},
	{
		// Mail App: learning from Spam and Not spam (see spam-learning.ts). For each word, link and sender, how
		// many spam and genuine emails it was in; which emails were learnt and as what; and when it began.
		name: "26_add_spam_learning",
		sql: `
            CREATE TABLE IF NOT EXISTS spam_tokens (
                token TEXT PRIMARY KEY,
                spam INTEGER NOT NULL DEFAULT 0,
                ham INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS spam_learnt (
                email_id TEXT PRIMARY KEY,
                as_spam INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS spam_meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `,
	},
];
