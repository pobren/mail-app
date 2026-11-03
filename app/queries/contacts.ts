// Mail App addition (not part of upstream Agentic Inbox).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useContacts(mailboxId: string | undefined) {
	return useQuery({
		queryKey: queryKeys.contacts(mailboxId ?? ""),
		queryFn: () => api.listContacts(mailboxId!),
		enabled: !!mailboxId,
		staleTime: 60_000,
	});
}

export function useSaveContact(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ email, name, notes }: { email: string; name: string; notes: string }) => api.saveContact(mailboxId!, email, { name, notes }),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.contacts(mailboxId ?? "") }),
	});
}

export function useRemoveContact(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (email: string) => api.removeContact(mailboxId!, email),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.contacts(mailboxId ?? "") }),
	});
}

/** Adds imported people, a batch at a time so a big file doesn't make one huge request. */
export function useImportContacts(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (people: { email: string; name: string; notes: string }[]) => {
			let added = 0;
			for (let i = 0; i < people.length; i += 500) {
				added += (await api.importContacts(mailboxId!, people.slice(i, i + 500))).added;
			}
			return added;
		},
		onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.contacts(mailboxId ?? "") }),
	});
}
