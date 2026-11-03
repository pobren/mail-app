// Mail App addition (not part of upstream Agentic Inbox).
// On the Mailboxes page: mark a mailbox as shared (a team address like sales@) and tick who can open it.
// The same choices can be made person by person on the People page.
import { Button, Dialog, Switch, useKumoToastManager } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { FindBox, useShowMore } from "~/components/ShowMore";
import { fill } from "~/lib/attachments";
import { queryKeys } from "~/queries/keys";
import { usePeople } from "~/queries/people";
import api from "~/services/api";
import copy from "~/copy/mailboxes.en-GB.json";

/** The Shared switch and the list of people to tick. Used when making a mailbox and when changing one. */
export function SharedPicker({ shared, onShared, picked, onPicked, me, alwaysList = false }: {
	shared: boolean;
	onShared: (on: boolean) => void;
	picked: Set<string>;
	onPicked: (next: Set<string>) => void;
	me: string | undefined;
	/** Show the people even when the mailbox isn't shared (when changing an existing mailbox). */
	alwaysList?: boolean;
}) {
	const { data } = usePeople();
	const people = (data?.people ?? []).filter((p) => p.status !== "suspended");
	// The box scrolls, so nobody is folded away, but a long list of people gets a Find box.
	const list = useShowMore(people, { limit: Infinity, text: (p) => `${p.name} ${p.email}` });
	const toggle = (email: string) => {
		const next = new Set(picked);
		if (next.has(email)) next.delete(email);
		else next.add(email);
		onPicked(next);
	};
	return (
		<div className="space-y-3">
			<div>
				<Switch label={copy.sharedSwitch} checked={shared} onCheckedChange={onShared} />
				<p className="mt-1 text-xs text-kumo-subtle">{copy.sharedHelp}</p>
			</div>
			{(shared || alwaysList) && (
				<div>
					<div className="mb-1.5 text-sm font-medium text-kumo-default">{copy.whoHeading}</div>
					{people.length <= 1 && <p className="text-xs text-kumo-subtle">{copy.whoEmpty}</p>}
					<FindBox list={list} label={copy.findPerson} className="mb-2" />
					<div className="max-h-56 space-y-1 overflow-y-auto">
						{list.shown.map((p) => (
							<label key={p.email} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-kumo-tint">
								<input
									type="checkbox"
									checked={picked.has(p.email)}
									onChange={() => toggle(p.email)}
									className="size-4 shrink-0 cursor-pointer accent-kumo-brand"
								/>
								<span className="truncate text-kumo-default">{p.name}{p.email === me ? ` (${copy.you})` : ""}</span>
								<span className="ml-auto truncate text-xs text-kumo-subtle">{p.email}</span>
							</label>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

/** The "People" dialog on a mailbox's row. */
export default function MailboxPeopleDialog({ mailbox, shared: wasShared, users, me, onClose }: {
	mailbox: string | null;
	shared: boolean;
	users: string[];
	me: string | undefined;
	onClose: () => void;
}) {
	const qc = useQueryClient();
	const toast = useKumoToastManager();
	const [shared, setShared] = useState(wasShared);
	const [picked, setPicked] = useState<Set<string>>(new Set(users));
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		setShared(wasShared || users.length > 1);
		setPicked(new Set(users));
	}, [mailbox]); // eslint-disable-line react-hooks/exhaustive-deps

	const save = async () => {
		if (!mailbox) return;
		setSaving(true);
		try {
			await api.setMailboxPeople(mailbox, { people: [...picked], shared });
			await Promise.all([
				qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all }),
				qc.invalidateQueries({ queryKey: queryKeys.people }),
				qc.invalidateQueries({ queryKey: queryKeys.me }),
			]);
			toast.add({ title: copy.saved });
			onClose();
		} catch (e) {
			toast.add({ title: e instanceof Error ? e.message : "Something went wrong", variant: "error" });
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog.Root open={!!mailbox} onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-base font-semibold mb-2 break-all">{fill(copy.whoTitle, { mailbox: mailbox ?? "" })}</Dialog.Title>
				<Dialog.Description className="text-kumo-subtle text-sm mb-4">{copy.whoIntro}</Dialog.Description>
				<SharedPicker shared={shared} onShared={setShared} picked={picked} onPicked={setPicked} me={me} alwaysList />
				<div className="flex justify-end gap-2 pt-5">
					<Dialog.Close render={(props) => <Button {...props} variant="secondary" size="sm">{copy.cancel}</Button>} />
					<Button variant="primary" size="sm" loading={saving} onClick={save}>{copy.save}</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
