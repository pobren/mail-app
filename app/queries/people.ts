// Mail App addition (not part of upstream Agentic Inbox): team access.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

/** Who is signed in, and whether they're an admin. */
export function useMe() {
	return useQuery({ queryKey: queryKeys.me, queryFn: () => api.getMe(), staleTime: 60_000 });
}

/** Saves your own name and personal signature. */
export function useUpdateMe() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (change: { name?: string; signature?: string }) => api.updateMe(change),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.me }),
	});
}

export function usePeople(enabled = true) {
	return useQuery({ queryKey: queryKeys.people, queryFn: () => api.getPeople(), enabled });
}

export function useMailboxAccess(mailboxId: string | undefined) {
	return useQuery({
		queryKey: queryKeys.mailboxAccess(mailboxId ?? "_none"),
		queryFn: () => api.getMailboxAccess(mailboxId!),
		enabled: !!mailboxId,
	});
}
