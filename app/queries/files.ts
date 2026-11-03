// Mail App addition (not part of upstream Agentic Inbox).
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useFiles(mailboxId: string | undefined, folderId: string | null) {
	return useQuery({
		queryKey: [...queryKeys.files(mailboxId ?? ""), "folder", folderId ?? ""],
		queryFn: () => api.listFiles(mailboxId!, folderId),
		enabled: !!mailboxId,
		placeholderData: keepPreviousData,
		retry: false,
	});
}

export function useFileBin(mailboxId: string | undefined, enabled = true) {
	return useQuery({
		queryKey: [...queryKeys.files(mailboxId ?? ""), "bin"],
		queryFn: () => api.fileBin(mailboxId!),
		enabled: !!mailboxId && enabled,
	});
}

export function useFileSearch(mailboxId: string | undefined, q: string) {
	return useQuery({
		queryKey: [...queryKeys.files(mailboxId ?? ""), "search", q],
		queryFn: () => api.searchFiles(mailboxId!, q),
		enabled: !!mailboxId && q.trim().length > 0,
		placeholderData: keepPreviousData,
	});
}

/** Any change to files: everything Files shows is fetched again. */
export function useFileChange<T, V>(mailboxId: string | undefined, fn: (vars: V) => Promise<T>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.files(mailboxId ?? "") }),
	});
}
