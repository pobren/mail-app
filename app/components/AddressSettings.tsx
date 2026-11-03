// Mail App: Settings › Addresses. The extra addresses (aliases) that arrive in this inbox, each with
// its own name and signature. Which addresses a mailbox has, and the catch-all, are set by the admin
// on the Mailboxes page (MailboxAddresses.tsx). Each change saves straight away.

import { Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { AtIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import type { Alias } from "shared/addresses";
import { fill } from "~/lib/attachments";
import { useAddresses, useChangeAddresses } from "~/queries/addresses";
import { useUpdateMailbox } from "~/queries/mailboxes";
import type { MailboxSettings } from "~/types";
import copy from "~/copy/settings.en-GB.json";
import { FindBox, ShowMoreButton, shortList, useShowMore } from "~/components/ShowMore";

const t = copy.addresses;
const textareaClass = "w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring";

export default function AddressSettings({ mailboxId, mainName, settings }: { mailboxId: string; mainName: string; settings?: MailboxSettings }) {
	const { data, isLoading } = useAddresses(mailboxId);
	const [editing, setEditing] = useState<string | null>(null);
	const aliasList = useShowMore(data?.aliases ?? [], { text: (x) => `${x.address} ${x.name ?? ""}` });
	if (isLoading || !data) return <div className="flex justify-center py-8"><Loader size="sm" /></div>;

	const [before, after] = t.setUpOn.split("{link}");
	const caught = data.catchAll.filter((c) => c.mailbox === mailboxId.toLowerCase()).map((c) => c.domain);
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-2">
				<AtIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{t.title}</span>
			</div>
			<p className="text-xs text-kumo-subtle mb-3">{t.intro}</p>
			<FindBox list={aliasList} label={t.find} className="mb-2" />
			<ul className="mb-3 divide-y divide-kumo-line rounded-lg border border-kumo-line">
				<li className="px-3 py-2">
					<div className="flex items-center justify-between gap-2">
						<span className="truncate font-mono text-xs text-kumo-default">{mailboxId}</span>
						<span className="shrink-0 text-xs text-kumo-subtle">{t.main}</span>
					</div>
					<p className="mt-0.5 text-xs text-kumo-subtle">{t.mainNote}</p>
				</li>
				{aliasList.shown.map((alias) => (
					<li key={alias.address} className="px-3 py-2">
						{editing === alias.address ? (
							<AliasEditor mailboxId={mailboxId} alias={alias} mainName={mainName} onDone={() => setEditing(null)} />
						) : (
							<div className="flex items-center justify-between gap-2">
								<div className="min-w-0">
									<div className="truncate font-mono text-xs text-kumo-default">{alias.address}</div>
									<div className="truncate text-xs text-kumo-subtle">
										{alias.name || mainName}{alias.signature ? ` · ${alias.signature.split("\n")[0]}` : ""}
									</div>
								</div>
								<Button variant="ghost" size="xs" icon={<PencilSimpleIcon size={12} />} onClick={() => setEditing(alias.address)} aria-label={`${t.edit} ${alias.address}`}>
									{t.edit}
								</Button>
							</div>
						)}
					</li>
				))}
			</ul>
			<ShowMoreButton list={aliasList} className="mb-3" />
			{data.aliases.length === 0 && <p className="text-xs text-kumo-subtle mb-3">{t.none}</p>}
			{data.aliases.length > 0 && <ReplyFromSetting mailboxId={mailboxId} settings={settings} aliases={data.aliases} />}
			{caught.length > 0 && <p className="text-xs text-kumo-subtle mb-3">{fill(t.isCatchAll, { domains: caught.length > 2 ? shortList(caught) : caught.join(" and ") })}</p>}
			<p className="text-xs text-kumo-subtle">
				{before}<Link to="/" className="text-kumo-link underline">{t.setUpLink}</Link>{after}
			</p>
		</div>
	);
}

/** "Reply from": the address the email was sent to (the default), the main address, or one chosen address. */
function ReplyFromSetting({ mailboxId, settings, aliases }: { mailboxId: string; settings?: MailboxSettings; aliases: Alias[] }) {
	const update = useUpdateMailbox();
	const toastManager = useKumoToastManager();
	const main = mailboxId.toLowerCase();
	const stored = settings?.replyFrom;
	// A chosen address that's since been removed shows as the default, which is what replies use.
	const value = stored === "main" || aliases.some((a) => a.address === stored) ? stored! : "received";
	const choose = (replyFrom: string) => {
		update.mutate({ mailboxId, settings: { ...settings, replyFrom } }, {
			onSuccess: () => toastManager.add({ title: t.saved }),
			onError: () => toastManager.add({ title: t.failed, variant: "error" }),
		});
	};
	return (
		<div className="mb-3">
			<label htmlFor="reply-from" className="block text-sm font-medium text-kumo-default mb-1">{t.replyFromLabel}</label>
			<select
				id="reply-from"
				value={value}
				onChange={(e) => choose(e.target.value)}
				className="w-full rounded-lg border border-kumo-line bg-kumo-base px-2.5 py-1.5 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring"
			>
				<option value="received">{t.replyFromReceived}</option>
				<option value="main">{fill(t.replyFromMain, { address: main })}</option>
				{aliases.map((a) => <option key={a.address} value={a.address}>{fill(t.replyFromAlways, { address: a.address })}</option>)}
			</select>
			<p className="mt-1 text-xs text-kumo-subtle">{t.replyFromNote}</p>
		</div>
	);
}

function AliasEditor({ mailboxId, alias, mainName, onDone }: { mailboxId: string; alias: Alias; mainName: string; onDone: () => void }) {
	const change = useChangeAddresses();
	const toastManager = useKumoToastManager();
	const [name, setName] = useState(alias.name ?? "");
	const [signature, setSignature] = useState(alias.signature ?? "");

	const save = (e: FormEvent) => {
		e.preventDefault();
		change.mutate({ mailboxId, change: { kind: "update", address: alias.address, name: name.trim(), signature: signature.trim() } }, {
			onSuccess: () => { toastManager.add({ title: t.saved }); onDone(); },
			onError: () => toastManager.add({ title: t.failed, variant: "error" }),
		});
	};
	return (
		<form onSubmit={save} className="space-y-3 py-1">
			<div className="font-mono text-xs text-kumo-default">{alias.address}</div>
			<Input label={t.name} placeholder={fill(t.namePlaceholder, { name: mainName })} value={name} onChange={(e) => setName(e.target.value)} />
			<label className="block">
				<span className="block text-base font-medium text-kumo-default mb-1.5">{t.signature}</span>
				<textarea value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={t.signaturePlaceholder} rows={3} className={textareaClass} />
			</label>
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onClick={onDone}>{t.cancel}</Button>
				<Button type="submit" variant="primary" size="sm" loading={change.isPending}>{t.save}</Button>
			</div>
		</form>
	);
}
