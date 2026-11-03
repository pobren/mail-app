// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: added getSetupStatus and getUpdate; the admin sending check; drafts can carry attachments; download links; contacts; labels; contact import; extra addresses; team access; the calendar; the API & webhooks page; Admin > Backups; Files; passkeys; masked email; snooze and reminders; the company details footer; calendar sharing; Admin > Branding and Reports.

import type { ForwardingSettings, ForwardingStatus } from "shared/forwarding";
import { noteServerBuild } from "~/lib/new-version";
import type { Backup, BackupList, Email, Folder, Mailbox } from "~/types";
import type { SetupStatus } from "shared/setup";
import type { SendingStatus } from "shared/sending";
import type { ApiKey, Delivery, Scope, Webhook, WebhookEvent } from "shared/api";
import type { PasskeyView } from "shared/passkeys";
import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";

export type SendingAnswer = SendingStatus & { domain: string | null; planUrl: string; installerUrl: string };
import type { Contact } from "shared/contacts";
import type { Label, LabelColor } from "shared/labels";
import type { Calendar, CalendarColor, CalendarEvent, EditScope, EventInput, Guest, GuestStatus, Occurrence, Organizer } from "shared/calendar";
import type { ShareLevel } from "shared/calendar-shares";
import type { FeedLevel } from "shared/calendar-feeds";

/** Mail App: a calendar's subscribe link, with links that open the subscribe step in each app. */
export interface CalendarFeedView {
	url: string;
	level: FeedLevel;
	links: { apple: string; google: string; outlook: string };
}

/** Mail App: a calendar someone else shared with you. */
export interface SharedCalendar extends Calendar {
	owner: string;
	ownerName: string;
	level: ShareLevel;
}
import type { Alias } from "shared/addresses";
import type { MaskedAddress } from "shared/masked";
import type { FileItem, FileListing, FileUsage } from "shared/files";
import type { Note, NoteInput } from "shared/notes";
import type { CompanyDetails } from "shared/company";
import type { Branding } from "shared/branding";
import type { FindAnswer, ReportsAnswer } from "shared/reports";
import type { SpamFilterSettings } from "shared/spam-ai";

/** Mail App: Admin > Spam filter. */
export interface SpamFilterAnswer { settings: SpamFilterSettings; checksToday: number }

/** Mail App: a mailbox's extra addresses, as Settings and the composer see them. */
export interface AddressesView {
	aliases: Alias[];
	/** Each of your domains, and the mailbox that gets mail for every other address there (null: none). */
	catchAll: { domain: string; mailbox: string | null }[];
	/** Each of your domains, and the mailbox that gets masked email there (null: none). */
	masked?: { domain: string; mailbox: string | null }[];
	domains: string[];
}

/** Mail App: a mailbox's masked addresses, and the domains it has masked email at. */
export interface MaskedView {
	addresses: MaskedAddress[];
	domains: string[];
	/** Only when one was just made. */
	created?: string;
}
export type MaskedChange = { label?: string; expires?: string | null; once?: boolean; status?: "on" | "off"; trustSite?: string };

/** Mail App: the Mailboxes page's Domains card. */
/** Mail App: Admin > API & webhooks. */
export interface PasskeysView { on: boolean; passkeys: PasskeyView[]; suggestedName: string; max: number }

export interface DeveloperView {
	apiOn: boolean;
	baseUrl: string;
	mailboxes: string[];
	keys: Omit<ApiKey, "hash">[];
	webhooks: Webhook[];
	limits: { keys: number; webhooks: number };
}

export interface DomainsView {
	domains: { name: string; main: boolean; removable: boolean; mailboxes: number; checks: { id: string; status: "ok" | "fix" | "unknown" }[] }[];
}

/** Mail App: one mailbox's backups on Admin > Backups. */
export interface MailboxBackups {
	mailbox: string;
	canOpen: boolean;
	latest: Backup | null;
	running: Backup | null;
	failed: Backup | null;
	count: number;
	settings: BackupList["settings"] | null;
	error?: string;
}

export interface AllBackupsView {
	mailboxes: MailboxBackups[];
}

/** Mail App: every mailbox's extra addresses and the catch-all, as the Mailboxes page sees them. */
export interface AddressBookView {
	aliases: Alias[];
	/** Domain → the mailbox that is its catch-all. */
	catchAll: Record<string, string>;
	domains: string[];
}
import type { OutgoingAttachment } from "~/lib/attachments";
import type { LogAction, PersonStatus, Plan, Role } from "shared/people";

/** Mail App: a calendar invite in an email, as the invite card shows it. */
export interface EmailInvite {
	method: string;
	cancelled: boolean;
	title: string;
	when: string;
	allDay: boolean;
	start: string;
	end: string;
	timeZone: string;
	location: string;
	meetingUrl: string;
	repeats: boolean;
	/** Just one date of a repeating event, changed on its own. */
	oneDate: boolean;
	organizer: Organizer | null;
	guests: Guest[];
	/** It's one of our own events (a copy of an invite we sent, or an answer to one). */
	ours: boolean;
	inCalendar: boolean;
	eventId: string | null;
	myStatus: GuestStatus | null;
	outdated: boolean;
	answer: Guest | null;
}

/** Mail App: a calendar reminder coming up, for the open app to show. */
export interface UpcomingReminder { at: string; eventId: string; occurrence: string | null; title: string; startAt: string; allDay: boolean; location: string; minutes: number }

/** Mail App: who is signed in. `plan` is only there for admins. */
/** A trial or a lock, told to everyone so the app can show a banner. */
export interface Me { email: string; name: string; role: Role; mailboxes: string[]; signature?: string; plan?: Plan }

/** Mail App: a person on the People page. */
export interface PersonView {
	email: string;
	name: string;
	role: Role;
	status: PersonStatus;
	mailboxes: string[];
	adminAccess: string[];
	invitedAt: string;
	lastSeenAt: string | null;
}

/** Mail App: whether Mail App keeps Cloudflare's sign-in list up to date itself, and any problem doing so. */
export interface SignInState { automatic: boolean; error?: string; count: number; accountId: string | null }

export interface PeoplePage {
	people: PersonView[];
	/** Who installed Mail App: always an admin, can't be paused or removed. */
	owner: string | null;
	plan: Plan & { count: number };
	mailboxes: string[];
	signIn: SignInState;
}

/** Mail App: what happened to one row of an Import users file. */
export type ImportResult = { line: number; email: string; added: boolean; error?: string; invite?: InviteResult };
export type InviteResult = { sent: true } | { sent: false; error: string; text: string; subject: string };

export interface MailboxAccess {
	people: { email: string; name: string }[];
	shared: boolean;
	admins: { email: string; name: string }[];
	log: { at: string; action: LogAction; by: string; byName: string; who?: string; whoName?: string }[];
}

export interface LinkSummary { token: string; filename: string; size: number; protected: boolean; created: string; expires: string }

const REQUEST_TIMEOUT_MS = 30_000;

/** Mail App: what to say when the server gives no reason of its own, instead of "Request failed: 500". */
export function fallbackMessage(status: number): string {
	if (status === 404) return "That couldn't be found. It may have been moved or deleted.";
	if (status === 403) return "You don't have access to that.";
	if (status === 413) return "That's too big to send in one go.";
	if (status === 429) return "Too many requests in a short time. Please wait a minute and try again.";
	if (status >= 500) return "Mail App couldn't finish that just now. Please try again in a moment.";
	return "That didn't work. Please check and try again.";
}

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super((body.error as string) || fallbackMessage(status));
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

async function request<T>(
	url: string,
	options: RequestInit = {},
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		// Mail App: Cloudflare's sign-in has run out (it lasts 30 days, however much the app is used).
		if (res.status === 401) signInNeeded();
		noteServerBuild(res.headers.get("App-Build"));
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} catch (e) {
		// Mail App: when sign-in has run out, Cloudflare sends requests off to its sign-in page, which the browser
		// refuses to follow for the app's own requests, so they fail like a lost connection.
		if (e instanceof TypeError && typeof navigator !== "undefined" && navigator.onLine) signInNeeded();
		throw e;
	} finally {
		clearTimeout(timeout);
	}
}

/** Mail App: tells the page (see SignInAgain in root.tsx) that it may need to sign in again. */
export const SIGN_IN_EVENT = "mailapp:sign-in-needed";
function signInNeeded() {
	if (typeof window !== "undefined") window.dispatchEvent(new Event(SIGN_IN_EVENT));
}

function get<T>(url: string, opts?: { params?: Record<string, string>; responseType?: string; signal?: AbortSignal }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string, body?: unknown) {
	return request<T>(url, { method: "DELETE", body: body != null ? JSON.stringify(body) : undefined });
}

function patch<T>(url: string, body: unknown) {
	return request<T>(url, { method: "PATCH", body: JSON.stringify(body) });
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

// ---------- API client ----------

const api = {
	// Config
	getConfig: () =>
		get<{ domains: string[]; emailAddresses: string[]; downloadLinks?: boolean }>("/api/v1/config"),
	// Mail App: whether a newer Mail App release is available.
	getUpdate: () =>
		get<{ available: boolean; current?: string; latest?: string; url?: string; changesUrl?: string }>("/api/v1/update"),

	// Ready to send (added for Mail App): admins only
	getSending: () => get<SendingAnswer>("/api/v1/sending"),
	checkSending: () => post<SendingAnswer>("/api/v1/sending/check"),

	// Setup wizard (added for Mail App)
	getSetupStatus: () => get<SetupStatus>("/api/v1/setup/status"),

	// Mailboxes
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown, team?: { shared: boolean; people: string[] }) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings, ...team }),
	/** Mail App: admins choose who uses a mailbox and whether it's shared. */
	setMailboxPeople: (mailboxId: string, change: { people: string[]; shared: boolean }) =>
		put<{ shared: boolean; people: { email: string; name: string }[] }>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/people`, change),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: unknown) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}`),

	// Notes (added for Mail App).
	listNotes: (mailboxId: string, bin = false) =>
		get<{ notes: Note[]; sharedMailbox: boolean }>(`/api/v1/mailboxes/${mailboxId}/notes`, bin ? { params: { bin: "1" } } : undefined),
	createNote: (mailboxId: string, input: NoteInput) =>
		post<Note>(`/api/v1/mailboxes/${mailboxId}/notes`, input),
	updateNote: (mailboxId: string, id: string, input: NoteInput) =>
		put<Note>(`/api/v1/mailboxes/${mailboxId}/notes/${id}`, input),
	binNotes: (mailboxId: string, ids: string[]) =>
		post<{ binned: number }>(`/api/v1/mailboxes/${mailboxId}/notes/bin`, { ids }),
	restoreNotes: (mailboxId: string, ids: string[]) =>
		post<{ restored: number }>(`/api/v1/mailboxes/${mailboxId}/notes/restore`, { ids }),
	deleteNotesForever: (mailboxId: string, ids: string[] | "all") =>
		post<{ deleted: number }>(`/api/v1/mailboxes/${mailboxId}/notes/delete`, ids === "all" ? { all: true } : { ids }),

	// Files (added for Mail App). Uploads are in ~/lib/file-upload.
	listFiles: (mailboxId: string, folderId: string | null) =>
		get<FileListing & { usage: FileUsage }>(`/api/v1/mailboxes/${mailboxId}/files`, folderId ? { params: { folder: folderId } } : undefined),
	fileBin: (mailboxId: string) =>
		get<{ items: FileItem[]; usage: FileUsage }>(`/api/v1/mailboxes/${mailboxId}/files/bin`),
	searchFiles: (mailboxId: string, q: string) =>
		get<(FileItem & { folderName: string | null })[]>(`/api/v1/mailboxes/${mailboxId}/files/search`, { params: { q } }),
	createFileFolder: (mailboxId: string, parentId: string | null, name: string) =>
		post<FileItem>(`/api/v1/mailboxes/${mailboxId}/files/folders`, { parentId, name }),
	renameFile: (mailboxId: string, id: string, name: string) =>
		patch<FileItem>(`/api/v1/mailboxes/${mailboxId}/files/${id}`, { name }),
	moveFiles: (mailboxId: string, ids: string[], parentId: string | null) =>
		post<{ moved: number }>(`/api/v1/mailboxes/${mailboxId}/files/move`, { ids, parentId }),
	binFiles: (mailboxId: string, ids: string[]) =>
		post<{ binned: number }>(`/api/v1/mailboxes/${mailboxId}/files/bin`, { ids }),
	restoreFiles: (mailboxId: string, ids: string[]) =>
		post<{ restored: number }>(`/api/v1/mailboxes/${mailboxId}/files/restore`, { ids }),
	deleteFilesForever: (mailboxId: string, ids: string[]) =>
		post<{ deleted: number }>(`/api/v1/mailboxes/${mailboxId}/files/delete`, { ids }),
	emptyFileBin: (mailboxId: string) =>
		post<{ deleted: number }>(`/api/v1/mailboxes/${mailboxId}/files/empty-bin`),
	saveAttachmentToFiles: (mailboxId: string, emailId: string, attachmentId: string) =>
		post<{ item: FileItem; folder: FileItem }>(`/api/v1/mailboxes/${mailboxId}/files/from-email`, { emailId, attachmentId }),

	// Contacts (added for Mail App)
	listContacts: (mailboxId: string) =>
		get<Contact[]>(`/api/v1/mailboxes/${mailboxId}/contacts`),
	saveContact: (mailboxId: string, email: string, details: { name: string; notes: string }) =>
		put<void>(`/api/v1/mailboxes/${mailboxId}/contacts/${encodeURIComponent(email)}`, details),
	importContacts: (mailboxId: string, contacts: { email: string; name: string; notes: string }[]) =>
		post<{ added: number }>(`/api/v1/mailboxes/${mailboxId}/contacts/import`, { contacts }),
	removeContact: (mailboxId: string, email: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/contacts/${encodeURIComponent(email)}`),

	// Extra addresses (added for Mail App)
	getDomains: () => get<DomainsView>("/api/v1/domains"),

	// Mail App: passkeys (Settings > Account)
	getPasskeys: () => get<PasskeysView>("/api/v1/passkeys"),
	passkeyOptions: () => post<{ options: PublicKeyCredentialCreationOptionsJSON; state: string }>("/api/v1/passkeys/options"),
	addPasskey: (input: { state: string; name: string; response: RegistrationResponseJSON }) => post<PasskeyView>("/api/v1/passkeys", input),
	deletePasskey: (id: string) => del<void>(`/api/v1/passkeys/${encodeURIComponent(id)}`),

	// Mail App: API & webhooks
	getDeveloper: () => get<DeveloperView>("/api/v1/developer"),
	createApiKey: (input: { name: string; mailboxes: string[]; scopes: Scope[] }) =>
		post<{ key: string; record: Omit<ApiKey, "hash"> }>("/api/v1/developer/keys", input),
	deleteApiKey: (id: string) => del<void>(`/api/v1/developer/keys/${encodeURIComponent(id)}`),
	createWebhook: (input: { name: string; url: string; events: WebhookEvent[]; mailboxes: string[] }) =>
		post<Webhook>("/api/v1/developer/webhooks", input),
	pauseWebhook: (id: string, paused: boolean) => patch<Webhook>(`/api/v1/developer/webhooks/${encodeURIComponent(id)}`, { paused }),
	deleteWebhook: (id: string) => del<void>(`/api/v1/developer/webhooks/${encodeURIComponent(id)}`),
	testWebhook: (id: string) => post<Delivery>(`/api/v1/developer/webhooks/${encodeURIComponent(id)}/test`),
	getDeliveries: (id: string) => get<{ deliveries: Delivery[] }>(`/api/v1/developer/webhooks/${encodeURIComponent(id)}/deliveries`),
	addDomains: (domains: string[]) => post<{ added: string[]; skipped: string[] }>("/api/v1/domains", { domains }),
	removeDomain: (domain: string) => del<void>(`/api/v1/domains/${encodeURIComponent(domain)}`),
	getAddressBook: () => get<AddressBookView>("/api/v1/addresses"),

	// Mail App: team access
	getMe: () => get<Me>("/api/v1/me"),
	updateMe: (change: { name?: string; signature?: string }) => put<{ email: string; name: string; signature: string }>("/api/v1/me", change),
	getPeople: () => get<PeoplePage>("/api/v1/people"),
	invitePerson: (input: { email: string; name: string; role: Role; mailboxes: string[]; newMailbox?: { email: string; name?: string } }) =>
		post<{ person: PersonView; invite: InviteResult; signIn: SignInState }>("/api/v1/people", input),
	changePerson: (email: string, change: { name?: string; role?: Role; mailboxes?: string[]; status?: "active" | "suspended" }) =>
		patch<{ person: PersonView; signIn: SignInState }>(`/api/v1/people/${encodeURIComponent(email)}`, change),
	resendInvite: (email: string, reset = false) =>
		post<{ invite: InviteResult }>(`/api/v1/people/${encodeURIComponent(email)}/invite`, { reset }),
	removePerson: (email: string, mailboxes: "keep" | "hand-over" | "delete", handTo?: string) =>
		del<{ removed: string; signIn: SignInState }>(`/api/v1/people/${encodeURIComponent(email)}`, { mailboxes, handTo }),
	importPeople: (rows: { line: number; name: string; email: string; role: string; mailbox: string }[], sendInvites: boolean) =>
		post<{ results: ImportResult[]; signIn: SignInState }>("/api/v1/people/import", { rows, sendInvites }),
	retrySignInSync: () => post<{ ok: boolean; signIn: SignInState }>("/api/v1/people-sync"),
	saveAccessToken: (token: string) => put<{ ok: boolean; signIn: SignInState }>("/api/v1/access-token", { token }),
	setAdminAccess: (mailbox: string, open: boolean) =>
		put<{ open: boolean }>(`/api/v1/admin-access/${encodeURIComponent(mailbox)}`, { open }),
	getMailboxAccess: (mailboxId: string) => get<MailboxAccess>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/access`),
	getAddresses: (mailboxId: string) =>
		get<AddressesView>(`/api/v1/mailboxes/${mailboxId}/addresses`),
	addAddress: (mailboxId: string, alias: { address: string; name?: string; signature?: string }) =>
		post<AddressesView>(`/api/v1/mailboxes/${mailboxId}/addresses`, alias),
	updateAddress: (mailboxId: string, address: string, changes: { name?: string; signature?: string }) =>
		put<AddressesView>(`/api/v1/mailboxes/${mailboxId}/addresses/${encodeURIComponent(address)}`, changes),
	removeAddress: (mailboxId: string, address: string) =>
		del<AddressesView>(`/api/v1/mailboxes/${mailboxId}/addresses/${encodeURIComponent(address)}`),
	setCatchAll: (mailboxId: string, domain: string, on: boolean) =>
		put<AddressesView>(`/api/v1/mailboxes/${mailboxId}/catch-all`, { domain, on }),
	setMaskedDomain: (mailboxId: string, domain: string, on: boolean) =>
		put<AddressesView>(`/api/v1/mailboxes/${mailboxId}/masked-domain`, { domain, on }),

	// Masked email (added for Mail App)
	getMasked: (mailboxId: string) => get<MaskedView>(`/api/v1/mailboxes/${mailboxId}/masked`),
	newMasked: (mailboxId: string, input: { label?: string; domain?: string; expires?: string | null; once?: boolean }) =>
		post<MaskedView>(`/api/v1/mailboxes/${mailboxId}/masked`, input),
	changeMasked: (mailboxId: string, address: string, change: MaskedChange) =>
		put<MaskedView>(`/api/v1/mailboxes/${mailboxId}/masked/${encodeURIComponent(address)}`, change),

	// Labels (added for Mail App)
	listLabels: (mailboxId: string) =>
		get<Label[]>(`/api/v1/mailboxes/${mailboxId}/labels`),
	createLabel: (mailboxId: string, label: { name: string; color?: LabelColor }) =>
		post<Label>(`/api/v1/mailboxes/${mailboxId}/labels`, label),
	updateLabel: (mailboxId: string, id: string, changes: { name?: string; color?: LabelColor }) =>
		put<Label>(`/api/v1/mailboxes/${mailboxId}/labels/${id}`, changes),
	reorderLabels: (mailboxId: string, ids: string[]) =>
		put<void>(`/api/v1/mailboxes/${mailboxId}/labels/order`, { ids }),
	deleteLabel: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/labels/${id}`),
	setEmailLabels: (mailboxId: string, emailId: string, changes: { add?: string[]; remove?: string[] }) =>
		put<{ labels: string[] }>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/labels`, changes),

	// Calendar (added for Mail App)
	listCalendars: (mailboxId: string) =>
		get<Calendar[]>(`/api/v1/mailboxes/${mailboxId}/calendar/calendars`),
	createCalendar: (mailboxId: string, cal: { name: string; color?: CalendarColor; sourceUrl?: string; tz?: string }) =>
		post<Calendar>(`/api/v1/mailboxes/${mailboxId}/calendar/calendars`, cal),
	importCalendarFile: async (mailboxId: string, id: string, file: File) => {
		const res = await fetch(`/api/v1/mailboxes/${mailboxId}/calendar/calendars/${id}/import?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, {
			method: "POST", headers: { "content-type": "text/calendar" }, body: await file.text(),
		});
		const body = (await res.json().catch(() => ({}))) as { added?: number; skipped?: number; error?: string };
		if (!res.ok) throw new ApiError(res.status, body);
		return body as { added: number; skipped: number };
	},
	refreshCalendar: (mailboxId: string, id: string) =>
		post<Calendar>(`/api/v1/mailboxes/${mailboxId}/calendar/calendars/${id}/refresh`, {}),
	updateCalendar: (mailboxId: string, id: string, changes: { name?: string; color?: CalendarColor }) =>
		put<Calendar>(`/api/v1/mailboxes/${mailboxId}/calendar/calendars/${id}`, changes),
	deleteCalendar: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/calendar/calendars/${id}`),
	// Calendar sharing (added for Mail App)
	calendarShareCounts: (mailboxId: string) =>
		get<{ counts: Record<string, number> }>(`/api/v1/mailboxes/${mailboxId}/calendar/shares`),
	getCalendarShares: (mailboxId: string, id: string) =>
		get<{ shares: { with: string; level: ShareLevel }[]; people: { email: string; name: string }[] }>(`/api/v1/mailboxes/${mailboxId}/calendar/calendars/${id}/shares`),
	saveCalendarShares: (mailboxId: string, id: string, shares: { with: string; level: ShareLevel }[]) =>
		put<{ shares: { with: string; level: ShareLevel }[] }>(`/api/v1/mailboxes/${mailboxId}/calendar/calendars/${id}/shares`, { shares }),
	getCalendarFeed: (mailboxId: string, id: string) =>
		get<{ feed: CalendarFeedView | null }>(`/api/v1/mailboxes/${mailboxId}/calendar/calendars/${id}/feed`),
	saveCalendarFeed: (mailboxId: string, id: string, level: FeedLevel, renew = false) =>
		post<{ feed: CalendarFeedView | null }>(`/api/v1/mailboxes/${mailboxId}/calendar/calendars/${id}/feed`, { level, renew }),
	deleteCalendarFeed: (mailboxId: string, id: string) =>
		del<{ feed: null }>(`/api/v1/mailboxes/${mailboxId}/calendar/calendars/${id}/feed`),
	listSharedCalendars: () => get<SharedCalendar[]>("/api/v1/shared-calendars"),
	listSharedEvents: (from: string, to: string) =>
		get<(Occurrence & { owner: string })[]>("/api/v1/shared-calendars/events", { params: { from, to } }),
	createSharedEvent: (owner: string, event: EventInput) =>
		post<CalendarEvent>(`/api/v1/shared-calendars/${encodeURIComponent(owner)}/events`, event),
	updateSharedEvent: (owner: string, id: string, event: EventInput, scope: EditScope, occurrence: string | null) =>
		put<CalendarEvent>(`/api/v1/shared-calendars/${encodeURIComponent(owner)}/events/${id}`, { event, scope, occurrence }),
	deleteSharedEvent: (owner: string, id: string, scope: EditScope, occurrence: string | null) =>
		del<{ ok: boolean }>(`/api/v1/shared-calendars/${encodeURIComponent(owner)}/events/${id}?${new URLSearchParams({ scope, ...(occurrence ? { occurrence } : {}) })}`),
	listCalendarEvents: (mailboxId: string, from: string, to: string) =>
		get<Occurrence[]>(`/api/v1/mailboxes/${mailboxId}/calendar/events`, { params: { from, to } }),
	createCalendarEvent: (mailboxId: string, event: EventInput, notify = false) =>
		post<CalendarEvent & { inviteProblem?: string | null }>(`/api/v1/mailboxes/${mailboxId}/calendar/events${notify ? "?notify=1" : ""}`, event),
	updateCalendarEvent: (mailboxId: string, id: string, event: EventInput, scope: EditScope, occurrence: string | null, notify = false) =>
		put<CalendarEvent & { inviteProblem?: string | null }>(`/api/v1/mailboxes/${mailboxId}/calendar/events/${id}`, { event, scope, occurrence, notify }),
	deleteCalendarEvent: (mailboxId: string, id: string, scope: EditScope, occurrence: string | null, notify = false) =>
		del<{ ok: boolean; inviteProblem?: string | null }>(`/api/v1/mailboxes/${mailboxId}/calendar/events/${id}?${new URLSearchParams({ scope, ...(occurrence ? { occurrence } : {}), ...(notify ? { notify: "1" } : {}) })}`),
	// An invite that came by email, and our answer to it.
	getInvite: (mailboxId: string, emailId: string, tz: string) =>
		get<{ invite: EmailInvite | null }>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/invite`, { params: { tz } }),
	answerInvite: (mailboxId: string, emailId: string, answer: GuestStatus | "remove", tz: string) =>
		post<{ ok: boolean; inCalendar: boolean; eventId?: string | null; myStatus?: GuestStatus; problem?: string | null }>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/invite?${new URLSearchParams({ tz })}`, { answer }),
	upcomingReminders: (mailboxId: string) =>
		get<UpcomingReminder[]>(`/api/v1/mailboxes/${mailboxId}/calendar/reminders`),

	// Spam (added for Mail App)
	spamAction: (mailboxId: string, action: "block" | "not-spam" | "unblock", sender: string, emailId?: string) =>
		post<{ settings: unknown }>(`/api/v1/mailboxes/${mailboxId}/spam/${action}`, { sender, emailId }),
	saveRules: (mailboxId: string, rules: unknown[]) =>
		put<{ settings: unknown }>(`/api/v1/mailboxes/${mailboxId}/rules`, { rules }),
	getForwarding: (mailboxId: string) =>
		get<{ forwarding: ForwardingSettings; status: ForwardingStatus | null }>(`/api/v1/mailboxes/${mailboxId}/forwarding`),
	saveForwarding: (mailboxId: string, forwarding: ForwardingSettings) =>
		put<{ forwarding: ForwardingSettings; status: ForwardingStatus | null }>(`/api/v1/mailboxes/${mailboxId}/forwarding`, forwarding),
	applyRule: (mailboxId: string, ruleId: string) =>
		post<{ changed: number }>(`/api/v1/mailboxes/${mailboxId}/rules/${encodeURIComponent(ruleId)}/apply`, {}),

	// Emails
	listEmails: (mailboxId: string, params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/emails`, { params, signal: opts?.signal }),
	sendEmail: (mailboxId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails`, email),
	// Mail App: scheduled send. Another time (or "now" to send it straight away), or back to Drafts.
	rescheduleEmail: (mailboxId: string, id: string, at: number | "now") =>
		post<{ send_at: number }>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/schedule`, at === "now" ? { now: true } : { send_at: at }),
	unscheduleEmail: (mailboxId: string, id: string) =>
		post<{ ok: true }>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/unschedule`, {}),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, { signal: opts?.signal }),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	deleteEmail: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, { folderId }),
	// Mail App: backups
	listBackups: (mailboxId: string) =>
		get<BackupList>(`/api/v1/mailboxes/${mailboxId}/backups`),
	startBackup: (mailboxId: string) =>
		post<Backup>(`/api/v1/mailboxes/${mailboxId}/backups`),
	updateBackupSettings: (mailboxId: string, change: { nightly?: boolean; keep?: number }) =>
		put<BackupList["settings"]>(`/api/v1/mailboxes/${mailboxId}/backups/settings`, change),
	deleteBackup: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/backups/${id}`),
	/** Mail App: Admin > Backups, every mailbox at once. */
	getAllBackups: () => get<AllBackupsView>("/api/v1/admin/backups"),
	backUpAll: () => post<{ started: number; of: number }>("/api/v1/admin/backups"),
	backUpMailbox: (mailboxId: string) => post<Backup>(`/api/v1/admin/backups/${encodeURIComponent(mailboxId)}`),
	backupDownloadUrl: (mailboxId: string, id: string) =>
		`/api/v1/mailboxes/${mailboxId}/backups/${id}/download`,
	/** Sends one batch of messages read from an .mbox file. */
	importMessages: async (mailboxId: string, messages: Uint8Array[], folder: string): Promise<{ added: number; skipped: number; failed: number }> => {
		const form = new FormData();
		form.set("folder", folder);
		messages.forEach((m, n) => form.append("m", new Blob([m as Uint8Array<ArrayBuffer>], { type: "message/rfc822" }), `${n}.eml`));
		const res = await fetch(`/api/v1/mailboxes/${mailboxId}/import`, { method: "POST", body: form, signal: AbortSignal.timeout(180_000) });
		if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))) as Record<string, unknown>);
		return res.json();
	},
	// Mail App: act on several conversations at once, and "Mark all as read".
	updateConversations: (mailboxId: string, ids: string[], action: "move" | "read" | "unread" | "delete", folderId?: string, fromFolder?: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/conversations`, { ids, action, folderId, fromFolder }),
	// Mail App: snooze, and "Remind me if no reply".
	snooze: (mailboxId: string, ids: string[], until: number, fromFolder?: string) =>
		post<{ snoozed: number }>(`/api/v1/mailboxes/${mailboxId}/snooze`, { ids, until, fromFolder }),
	unsnooze: (mailboxId: string, ids: string[]) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/unsnooze`, { ids }),
	setReminder: (mailboxId: string, emailId: string, at: number) =>
		put<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reminder`, { at }),
	cancelReminder: (mailboxId: string, emailId: string, kind: "snooze" | "no-reply") =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reminder?kind=${kind}`),
	// Mail App: Admin > Company details.
	getCompany: () => get<CompanyDetails>("/api/v1/company"),
	saveCompany: (details: CompanyDetails) => put<CompanyDetails>("/api/v1/company", details),
	// Mail App: Admin > Branding.
	getBranding: () => get<Branding>("/api/v1/branding"),
	saveBranding: (branding: Pick<Branding, "name" | "colour" | "supportEmail">) => put<Branding>("/api/v1/branding", branding),
	uploadLogo: (file: Blob, size: { width: number; height: number }) =>
		request<Branding>(`/api/v1/branding/logo?width=${size.width}&height=${size.height}`, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } }),
	removeLogo: () => del<Branding>("/api/v1/branding/logo"),
	// Mail App: Admin > Reports.
	getReports: (days: number) => get<ReportsAnswer>("/api/v1/reports", { params: { days: String(days) } }),
	findInReports: (q: string, days: number) => get<FindAnswer>("/api/v1/reports/find", { params: { q, days: String(days) } }),
	// Mail App: Admin > Spam filter, and what a mailbox has learnt from Spam and Not spam.
	getSpamFilter: () => get<SpamFilterAnswer>("/api/v1/spam-filter"),
	saveSpamFilter: (settings: SpamFilterSettings) => put<SpamFilterAnswer>("/api/v1/spam-filter", settings),
	getSpamLearning: (mailboxId: string) => get<{ spam: number; ham: number }>(`/api/v1/mailboxes/${mailboxId}/spam/learning`),
	markAllRead: (mailboxId: string, where: { folderId?: string; labelId?: string }) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/mark-all-read`, where),
	getThread: (mailboxId: string, threadId: string, opts?: { signal?: AbortSignal }) =>
		get<Email[]>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}`, { signal: opts?.signal }),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		get<Blob>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`, { responseType: "blob" }),
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
			draft_id?: string;
			/** Mail App: which of the mailbox's addresses it's from. */
			from?: string;
			attachments?: OutgoingAttachment[];
		},
	) => post<{ draft_id: string }>(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`, email),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`, email),

	// Download links (added for Mail App). Uploads go through app/lib/links.ts.
	listLinks: (mailboxId: string) =>
		get<LinkSummary[]>(`/api/v1/mailboxes/${mailboxId}/links`),
	deleteLink: (mailboxId: string, token: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/links/${token}`),

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`),

	// Search
	searchEmails: (mailboxId: string, params: Record<string, string>) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/search`, { params }),
};

export default api;
