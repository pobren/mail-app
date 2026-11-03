// Mail App: the domains this install gets email for (the admin Domains page).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useDomains(enabled = true) {
	return useQuery({ queryKey: queryKeys.domains, queryFn: () => api.getDomains(), enabled });
}

/** After a domain is added or removed, everything that lists domains is out of date. */
function refreshAll(qc: ReturnType<typeof useQueryClient>) {
	return Promise.all([
		qc.invalidateQueries({ queryKey: queryKeys.domains }),
		qc.invalidateQueries({ queryKey: queryKeys.config }),
		qc.invalidateQueries({ queryKey: ["addresses"] }),
	]);
}

export function useRemoveDomain() {
	const qc = useQueryClient();
	return useMutation({ mutationFn: (domain: string) => api.removeDomain(domain), onSuccess: () => refreshAll(qc) });
}

export function useAddDomains() {
	const qc = useQueryClient();
	return useMutation({ mutationFn: (domains: string[]) => api.addDomains(domains), onSuccess: () => refreshAll(qc) });
}

export function useRefreshDomains() {
	const qc = useQueryClient();
	return () => refreshAll(qc);
}
