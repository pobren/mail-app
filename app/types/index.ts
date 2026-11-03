// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: added aiEnabled, the spam lists and templates to MailboxSettings; out-of-office dates; contact photos and automatic contacts switches; labels on emails; who can open a mailbox (team access); inbox rules.

import type { ReminderInfo } from "shared/reminders";
import type { SpamSettings } from "shared/spam";
import type { EmailTemplate } from "shared/templates";
import type { AutoReplySettings } from "shared/autoreply";
import type { InboxRule } from "shared/rules";

export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}

export interface MailboxSettings extends SpamSettings {
	/** Mail App: inbox rules, top first. */
	rules?: InboxRule[];
	fromName?: string;
	forwarding?: { enabled: boolean; email: string };
	signature?: SignatureSettings;
	autoReply?: AutoReplySettings;
	agentSystemPrompt?: string;
	/** Mail App: AI assistant on/off. Missing means off. */
	aiEnabled?: boolean;
	/** Mail App: the Workers AI model that writes drafts (see shared/ai.ts AI_MODELS). */
	aiModel?: string;
	/** Mail App: saved emails to start from. */
	templates?: EmailTemplate[];
	/** Mail App: show contact photos from Gravatar. Missing means off. */
	showPhotos?: boolean;
	/** Mail App: add everyone you email to Contacts automatically. Missing means on. */
	autoContacts?: boolean;
	/** Mail App: which address replies come from: "received" (the address the email was sent to; the default), "main", or one of the mailbox's addresses. */
	replyFrom?: string;
	/** Mail App: keep new masked addresses without asking. Missing means ask (Keep or Block). */
	maskedKeepNew?: boolean;
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	settings?: MailboxSettings;
	/** Mail App: false for someone else's mailbox, which an admin sees on the Mailboxes page but can't open without it being logged. */
	canOpen?: boolean;
	/** Mail App: admins only: who uses this mailbox. */
	people?: { email: string; name: string }[];
	/** Mail App: two or more people use it, so each signs their emails with their own name. */
	shared?: boolean;
}

export interface Email {
	id: string;
	thread_id?: string | null;
	folder_id?: string | null;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string;
	bcc?: string;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	/** The name in the sender's From line, such as "Hannah Clarke". Missing on older mail without one. */
	sender_name?: string | null;
	/** Mail App: in a shared mailbox, the name of the team member who sent it. */
	sent_by_name?: string | null;
	attachments?: Attachment[];
	snippet?: string | null;
	// Thread aggregate fields (only present in threaded list view)
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
	/** Mail App: the address it came in on, when it arrived (threaded list view only). */
	delivered_to?: string | null;
	/** Mail App: ids of the labels on this email's conversation. */
	labels?: string[];
	/** Mail App: for the list, when the conversation was last brought back to the Inbox, or its date. */
	shown_at?: string | null;
	/** Mail App: for the list, when a snoozed conversation comes back (ms). */
	snoozed_until?: number | null;
	/** Mail App: for the list, when "Remind me if no reply" is due (ms), or "due" once it's back in the Inbox. */
	no_reply?: number | "due" | null;
	/** Mail App: the open email's conversation's snooze and reminder. */
	reminders?: ReminderInfo[];
	/** Mail App: for an email waiting in Scheduled, when it goes (ms). */
	send_at?: number | null;
}

export interface Attachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string;
	disposition?: string;
}

export interface Folder {
	id: string;
	name: string;
	unreadCount: number;
}

// Mail App: backups (see workers/durableObject/backup.ts)
export interface Backup {
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

export interface BackupList {
	backups: Backup[];
	settings: { nightly: boolean; keep: number; next: string | null };
}
