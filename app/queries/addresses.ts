// Mail App: a mailbox's extra addresses, catch-all and masked email.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { type AddressBookView, type AddressesView, type MaskedChange, type MaskedView } from "~/services/api";
import { queryKeys } from "./keys";

export function useAddresses(mailboxId: string | undefined) {
	return useQuery<AddressesView>({
		queryKey: mailboxId ? queryKeys.addresses(mailboxId) : ["addresses", "_disabled"],
		queryFn: () => api.getAddresses(mailboxId!),
		enabled: !!mailboxId,
	});
}

/** Every mailbox's extra addresses and the catch-all (the Mailboxes page). */
export function useAddressBook(enabled = true) {
	return useQuery<AddressBookView>({ queryKey: queryKeys.addressBook, queryFn: () => api.getAddressBook(), enabled });
}

type Change =
	| { kind: "add"; address: string; name?: string; signature?: string }
	| { kind: "update"; address: string; name?: string; signature?: string }
	| { kind: "remove"; address: string }
	| { kind: "catchAll"; domain: string; on: boolean }
	| { kind: "masked"; domain: string; on: boolean };

/** Every change returns the mailbox's addresses as they now stand, which replace the cached copy. */
export function useChangeAddresses() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, change }: { mailboxId: string; change: Change }) => {
			switch (change.kind) {
				case "add": return api.addAddress(mailboxId, { address: change.address, name: change.name, signature: change.signature });
				case "update": return api.updateAddress(mailboxId, change.address, { name: change.name, signature: change.signature });
				case "remove": return api.removeAddress(mailboxId, change.address);
				case "catchAll": return api.setCatchAll(mailboxId, change.domain, change.on);
				case "masked": return api.setMaskedDomain(mailboxId, change.domain, change.on);
			}
		},
		onSuccess: (view, { mailboxId }) => {
			qc.setQueryData(queryKeys.addresses(mailboxId), view);
			// The catch-all can move between mailboxes, so refetch the others too.
			qc.invalidateQueries({ queryKey: ["addresses"], predicate: (q) => q.queryKey[1] !== mailboxId });
			qc.invalidateQueries({ queryKey: ["masked"] });
		},
	});
}

/** Mail App: the mailbox's masked addresses. */
export function useMasked(mailboxId: string | undefined, enabled = true) {
	return useQuery<MaskedView>({
		queryKey: mailboxId ? queryKeys.masked(mailboxId) : ["masked", "_disabled"],
		queryFn: () => api.getMasked(mailboxId!),
		enabled: !!mailboxId && enabled,
	});
}

/** Make a masked address, or change one. Each returns the list as it now stands. */
export function useChangeMasked() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, address, change, create }: { mailboxId: string; address?: string; change?: MaskedChange; create?: { label?: string; domain?: string; expires?: string | null; once?: boolean } }) =>
			create ? api.newMasked(mailboxId, create) : api.changeMasked(mailboxId, address!, change ?? {}),
		onSuccess: (view, { mailboxId }) => qc.setQueryData(queryKeys.masked(mailboxId), { ...view, created: undefined }),
	});
}
