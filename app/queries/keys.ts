// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: contacts; Files; Notes; labels; extra addresses; team access; the admin pages.

/** Centralised query key factories for cache invalidation. */
export const queryKeys = {
	mailboxes: {
		all: ["mailboxes"] as const,
		detail: (id: string) => ["mailboxes", id] as const,
	},
	emails: {
		list: (mailboxId: string, params: Record<string, string>) =>
			["emails", mailboxId, params] as const,
		detail: (mailboxId: string, emailId: string) =>
			["emails", mailboxId, emailId] as const,
		thread: (mailboxId: string, threadId: string) =>
			["emails", mailboxId, "thread", threadId] as const,
	},
	folders: {
		list: (mailboxId: string) => ["folders", mailboxId] as const,
	},
	search: {
		results: (mailboxId: string, query: string, page: number) =>
			["search", mailboxId, query, page] as const,
	},
	contacts: (mailboxId: string) => ["contacts", mailboxId] as const,
	files: (mailboxId: string) => ["files", mailboxId] as const,
	notes: (mailboxId: string) => ["notes", mailboxId] as const,
	labels: (mailboxId: string) => ["labels", mailboxId] as const,
	addresses: (mailboxId: string) => ["addresses", mailboxId] as const,
	addressBook: ["addresses", "_book"] as const,
	masked: (mailboxId: string) => ["masked", mailboxId] as const,
	domains: ["domains"] as const,
	developer: ["developer"] as const,
	allBackups: ["backups", "_all"] as const,
	deliveries: (webhookId: string) => ["developer", "deliveries", webhookId] as const,
	config: ["config"] as const,
	me: ["me"] as const,
	people: ["people"] as const,
	mailboxAccess: (mailboxId: string) => ["mailbox-access", mailboxId] as const,
	update: ["update"] as const,
	sending: ["sending"] as const,
};
