// Mail App: the Mailboxes page's address manager for one mailbox. The admin adds and removes its extra
// addresses (aliases) and chooses the catch-all and masked email here; the name and signature for each address are
// set by the mailbox's user in Settings › Addresses. Each change saves straight away.

import { Button, Input, Loader, Switch, Text, useKumoToastManager } from "@cloudflare/kumo";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { fill } from "~/lib/attachments";
import { useAddresses, useChangeAddresses } from "~/queries/addresses";
import copy from "~/copy/settings.en-GB.json";
import { FindBox, ShowMoreButton, useShowMore } from "~/components/ShowMore";

const t = copy.addresses;
const a = copy.addressAdmin;

export default function MailboxAddresses({ mailboxId }: { mailboxId: string }) {
	const { data, isLoading } = useAddresses(mailboxId);
	const change = useChangeAddresses();
	const toastManager = useKumoToastManager();
	const [entry, setEntry] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [local, domain] = [mailboxId.split("@")[0], mailboxId.split("@")[1]];
	// With more than one domain, the admin types the part before the @ and picks the domain.
	const [pickedDomain, setPickedDomain] = useState(domain.toLowerCase());

	const add = (e: FormEvent) => {
		e.preventDefault();
		const raw = entry.trim();
		if (!raw) return;
		// Typing just "hello" means hello@ the chosen domain (the mailbox's own if there's only one).
		const address = raw.includes("@") ? raw : `${raw}@${pickDomain ? pickedDomain : domain}`;
		setError(null);
		change.mutate({ mailboxId, change: { kind: "add", address } }, {
			onSuccess: () => setEntry(""),
			onError: (err) => setError(err instanceof Error ? err.message : t.failed),
		});
	};
	const remove = (address: string) => {
		if (!window.confirm(fill(t.removeConfirm, { address }))) return;
		change.mutate({ mailboxId, change: { kind: "remove", address } }, {
			onError: () => toastManager.add({ title: t.failed, variant: "error" }),
		});
	};

	const aliasList = useShowMore(data?.aliases ?? [], { text: (x) => x.address });
	const catchAllList = useShowMore(data?.catchAll ?? [], { text: (c) => c.domain });
	const maskedList = useShowMore(data?.masked ?? []);

	if (isLoading || !data) return <div className="flex justify-center py-8"><Loader size="sm" /></div>;
	const pickDomain = data.domains.length > 1;

	return (
		<div className="space-y-5">
			<div>
				<p className="text-sm text-kumo-subtle mb-3">{a.intro}</p>
				{data.aliases.length > 0 ? (<>
					<FindBox list={aliasList} label={t.find} className="mb-2" />
					<ul className="mb-3 divide-y divide-kumo-line rounded-lg border border-kumo-line">
						{aliasList.shown.map((alias) => (
							<li key={alias.address} className="flex items-center justify-between gap-2 px-3 py-1.5">
								<span className="truncate font-mono text-xs text-kumo-default">{alias.address}</span>
								<Button variant="ghost" size="sm" shape="square" icon={<TrashIcon size={14} />} aria-label={fill(a.removeLabel, { address: alias.address })} onClick={() => remove(alias.address)} />
							</li>
						))}
					</ul>
					<ShowMoreButton list={aliasList} className="mb-3" />
				</>) : (
					<p className="text-xs text-kumo-subtle mb-3">{t.none}</p>
				)}
				<form onSubmit={add} className="flex items-end gap-2">
					<div className="flex-1 min-w-0">
						<Input label={t.addLabel} placeholder={pickDomain ? "hello" : fill(t.addPlaceholder, { domain })} value={entry} onChange={(e) => setEntry(e.target.value)} />
					</div>
					{pickDomain && (
						<div className="flex h-9 shrink-0 items-center gap-1.5">
							<span className="text-sm text-kumo-subtle">@</span>
							<select
								aria-label={t.domainLabel}
								value={pickedDomain}
								onChange={(e) => setPickedDomain(e.target.value)}
								disabled={entry.includes("@")}
								className="h-9 max-w-[8.5rem] sm:max-w-[12rem] rounded-lg border border-kumo-line bg-kumo-base px-2.5 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring disabled:opacity-50"
							>
								{data.domains.map((d) => <option key={d} value={d}>{d}</option>)}
							</select>
						</div>
					)}
					<Button type="submit" variant="secondary" icon={<PlusIcon size={14} />} loading={change.isPending && !!entry}>{t.add}</Button>
				</form>
				{error && <div className="mt-2"><Text variant="error" size="sm">{error}</Text></div>}
				<p className="mt-3 text-xs text-kumo-subtle">{fill(t.plusTip, { example: `${local}+shops@${domain}` })}</p>
			</div>

			<div className="border-t border-kumo-line pt-4">
				<div className="text-sm font-medium text-kumo-default mb-1">{t.catchAllTitle}</div>
				<p className="text-xs text-kumo-subtle mb-3">{t.catchAllIntro}</p>
				<FindBox list={catchAllList} label={t.findDomain} className="mb-3" />
				<div className="space-y-3">
					{catchAllList.shown.map(({ domain: d, mailbox }) => (
						<div key={d}>
							<Switch
								label={fill(t.catchAllSwitch, { domain: d })}
								checked={mailbox === mailboxId.toLowerCase()}
								onCheckedChange={(on) => change.mutate({ mailboxId, change: { kind: "catchAll", domain: d, on } }, {
									onError: () => toastManager.add({ title: t.failed, variant: "error" }),
								})}
							/>
							{mailbox && mailbox !== mailboxId.toLowerCase() && (
								<p className="mt-1 text-xs text-kumo-subtle">{fill(t.catchAllElsewhere, { mailbox, domain: d })}</p>
							)}
							{mailbox !== mailboxId.toLowerCase() && data.masked?.some((m) => m.domain === d && m.mailbox) && (
								<p className="mt-1 text-xs text-kumo-subtle">{fill(t.catchAllReplacesMasked, { domain: d })}</p>
							)}
						</div>
					))}
				</div>
				<ShowMoreButton list={catchAllList} className="mt-3" />
				{data.catchAll.some((c) => c.mailbox === mailboxId.toLowerCase()) && <p className="mt-3 text-xs text-kumo-subtle">{t.catchAllSpam}</p>}
			</div>

			{/* Mail App: masked email. Each domain has a catch-all or masked email, not both. */}
			{data.masked && (
				<div className="border-t border-kumo-line pt-4">
					<div className="text-sm font-medium text-kumo-default mb-1">{t.maskedTitle}</div>
					<p className="text-xs text-kumo-subtle mb-3">{t.maskedIntro}</p>
					<div className="space-y-3">
						{maskedList.shown.map(({ domain: d, mailbox }) => {
							const mine = mailbox === mailboxId.toLowerCase();
							const caught = data.catchAll.find((c) => c.domain === d)?.mailbox;
							return (
								<div key={d}>
									<Switch
										label={fill(t.maskedSwitch, { domain: d })}
										checked={mine}
										onCheckedChange={(on) => change.mutate({ mailboxId, change: { kind: "masked", domain: d, on } }, {
											onError: () => toastManager.add({ title: t.failed, variant: "error" }),
										})}
									/>
									{mailbox && !mine && <p className="mt-1 text-xs text-kumo-subtle">{fill(t.maskedElsewhere, { mailbox, domain: d })}</p>}
									{!mine && caught && <p className="mt-1 text-xs text-kumo-subtle">{fill(t.maskedReplacesCatchAll, { domain: d })}</p>}
								</div>
							);
						})}
					</div>
					<ShowMoreButton list={maskedList} className="mt-3" />
				</div>
			)}
		</div>
	);
}
