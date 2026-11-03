// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: useSpamAction; saving settings refreshes contacts; backups; inbox rules.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { BackupList, Mailbox } from "~/types";
import { queryKeys } from "./keys";

export function useMailboxes() {
	return useQuery<Mailbox[]>({
		queryKey: queryKeys.mailboxes.all,
		queryFn: () => api.listMailboxes() as Promise<Mailbox[]>,
	});
}

export function useMailbox(mailboxId: string | undefined) {
	return useQuery<Mailbox>({
		queryKey: mailboxId
			? queryKeys.mailboxes.detail(mailboxId)
			: ["mailboxes", "_disabled"],
		queryFn: () => api.getMailbox(mailboxId!) as Promise<Mailbox>,
		enabled: !!mailboxId,
	});
}

export function useCreateMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ email, name, team }: { email: string; name: string; team?: { shared: boolean; people: string[] } }) =>
			api.createMailbox(email, name, undefined, team),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useUpdateMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			settings,
		}: { mailboxId: string; settings: unknown }) =>
			api.updateMailbox(mailboxId, settings),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
			// Mail App: the contacts list depends on the "add people from my emails" setting.
			qc.invalidateQueries({ queryKey: queryKeys.contacts(mailboxId) });
		},
	});
}

/** Mail App: block a sender, mark mail as not spam, or unblock. Refreshes the mailbox settings and the email lists. */
export function useSpamAction() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, action, sender, emailId }: {
			mailboxId: string; action: "block" | "not-spam" | "unblock"; sender: string; emailId?: string;
		}) => api.spamAction(mailboxId, action, sender, emailId),
		onSuccess: (_data, { mailboxId, emailId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
			if (!emailId) return;
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
		},
	});
}

/** Mail App: save the whole list of inbox rules. */
export function useSaveRules() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, rules }: { mailboxId: string; rules: unknown[] }) => api.saveRules(mailboxId, rules),
		onSuccess: (_data, { mailboxId }) => qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) }),
	});
}

/** Mail App: run a saved rule on mail already in the Inbox. */
export function useApplyRule() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, ruleId }: { mailboxId: string; ruleId: string }) => api.applyRule(mailboxId, ruleId),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.labels(mailboxId) });
		},
	});
}

export function useDeleteMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (mailboxId: string) => api.deleteMailbox(mailboxId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

/** Mail App: this mailbox's backups. Checks every few seconds while one is being made. */
export function useBackups(mailboxId: string | undefined) {
	return useQuery<BackupList>({
		queryKey: ["backups", mailboxId],
		queryFn: () => api.listBackups(mailboxId!),
		enabled: !!mailboxId,
		refetchInterval: (q) => (q.state.data?.backups.some((b) => b.status === "running") ? 2000 : false),
	});
}

export function useBackupAction() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (a: { mailboxId: string; start?: true; remove?: string; settings?: { nightly?: boolean; keep?: number } }) => {
			if (a.start) await api.startBackup(a.mailboxId);
			if (a.remove) await api.deleteBackup(a.mailboxId, a.remove);
			if (a.settings) await api.updateBackupSettings(a.mailboxId, a.settings);
		},
		onSettled: (_d, _e, { mailboxId }) => qc.invalidateQueries({ queryKey: ["backups", mailboxId] }),
	});
}
