// Mail App addition (not part of upstream Agentic Inbox).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useNotes(mailboxId: string | undefined, bin = false) {
	return useQuery({
		queryKey: [...queryKeys.notes(mailboxId ?? ""), bin ? "bin" : "notes"],
		queryFn: () => api.listNotes(mailboxId!, bin),
		enabled: !!mailboxId,
	});
}

/** Any change to notes: the list and the Bin are fetched again. */
export function useNoteChange<T, V>(mailboxId: string | undefined, fn: (vars: V) => Promise<T>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.notes(mailboxId ?? "") }),
	});
}
