// Mail App: labels.

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Label, LabelColor } from "shared/labels";
import api from "~/services/api";
import type { Email } from "~/types";
import { queryKeys } from "./keys";

export function useLabels(mailboxId: string | undefined) {
	return useQuery<Label[]>({
		queryKey: mailboxId ? queryKeys.labels(mailboxId) : ["labels", "_disabled"],
		queryFn: () => api.listLabels(mailboxId!),
		enabled: !!mailboxId,
	});
}

export function useCreateLabel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, name, color }: { mailboxId: string; name: string; color?: LabelColor }) =>
			api.createLabel(mailboxId, { name, color }),
		onSuccess: (_data, { mailboxId }) => qc.invalidateQueries({ queryKey: queryKeys.labels(mailboxId) }),
	});
}

export function useUpdateLabel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, id, ...changes }: { mailboxId: string; id: string; name?: string; color?: LabelColor }) =>
			api.updateLabel(mailboxId, id, changes),
		onSuccess: (_data, { mailboxId }) => qc.invalidateQueries({ queryKey: queryKeys.labels(mailboxId) }),
	});
}

/** Saves a new label order, showing it straight away. */
export function useReorderLabels() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, labels }: { mailboxId: string; labels: Label[] }) =>
			api.reorderLabels(mailboxId, labels.map((l) => l.id)),
		onMutate: async ({ mailboxId, labels }) => {
			await qc.cancelQueries({ queryKey: queryKeys.labels(mailboxId) });
			const before = qc.getQueryData<Label[]>(queryKeys.labels(mailboxId));
			qc.setQueryData(queryKeys.labels(mailboxId), labels);
			return { before };
		},
		onError: (_err, { mailboxId }, ctx) => {
			if (ctx?.before) qc.setQueryData(queryKeys.labels(mailboxId), ctx.before);
		},
		onSettled: (_data, _err, { mailboxId }) => qc.invalidateQueries({ queryKey: queryKeys.labels(mailboxId) }),
	});
}

export function useDeleteLabel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, id }: { mailboxId: string; id: string }) => api.deleteLabel(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.labels(mailboxId) });
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		},
	});
}

/** The conversation an email belongs to, as the server groups labels. */
export function threadKey(email: Pick<Email, "id" | "thread_id">) {
	return email.thread_id || email.id;
}

/** Changes `labels` on every cached email in the conversation, so chips update straight away. */
function patchCachedLabels(qc: QueryClient, mailboxId: string, key: string, change: (labels: string[]) => string[]) {
	const patch = (e: Email) => (threadKey(e) === key ? { ...e, labels: change(e.labels ?? []) } : e);
	for (const [queryKey, data] of qc.getQueriesData<unknown>({ queryKey: ["emails", mailboxId] })) {
		if (!data) continue;
		if (Array.isArray(data)) qc.setQueryData(queryKey, (data as Email[]).map(patch));
		else if (typeof data === "object" && "emails" in data) {
			const list = data as { emails: Email[] };
			qc.setQueryData(queryKey, { ...list, emails: list.emails.map(patch) });
		} else if (typeof data === "object" && "id" in data) qc.setQueryData(queryKey, patch(data as Email));
	}
}

/** Adds or removes labels on the conversation an email belongs to. */
export function useSetEmailLabels() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, email, add = [], remove = [] }: { mailboxId: string; email: Email; add?: string[]; remove?: string[] }) =>
			api.setEmailLabels(mailboxId, email.id, { add, remove }),
		onMutate: async ({ mailboxId, email, add = [], remove = [] }) => {
			await qc.cancelQueries({ queryKey: ["emails", mailboxId] });
			patchCachedLabels(qc, mailboxId, threadKey(email), (labels) =>
				[...new Set([...labels.filter((l) => !remove.includes(l)), ...add])],
			);
		},
		onSettled: (_data, _err, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			qc.invalidateQueries({ queryKey: queryKeys.labels(mailboxId) });
		},
	});
}
