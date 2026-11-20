// Mail App: the Mailboxes page's address manager for one mailbox. The admin adds and removes its extra
// addresses (aliases) and chooses the catch-all and masked email here; the name and signature for each address are
// set by the mailbox's user in Settings › Addresses. Each change saves straight away.
// Catch-all and masked email are one list: only the domains where this mailbox has one show, each with a
// Catch-all or Masked email choice, and a picker turns one on for another domain. So an install with
// many domains stays short (Chris has 25+).

import { Button, Input, Loader, Text, useKumoToastManager } from "@cloudflare/kumo";
import { CheckCircleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { fill } from "~/lib/attachments";
import { type AddressChange, useAddresses, useChangeAddresses } from "~/queries/addresses";
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

			<DomainCatchAll mailboxId={mailboxId} data={data} />
		</div>
	);
}

const SELECT = "h-9 rounded-lg border border-kumo-line bg-kumo-base px-2.5 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring disabled:opacity-50";

type Mode = "catchAll" | "masked";
type AddressesData = NonNullable<ReturnType<typeof useAddresses>["data"]>;
/** Turn on for every domain at once: the picker's first choice. */
const EVERY = "*";

/** Mail App: the domains this mailbox is the catch-all or gets masked email at, and a picker to add one. */
function DomainCatchAll({ mailboxId, data }: { mailboxId: string; data: AddressesData }) {
	const change = useChangeAddresses();
	const toastManager = useKumoToastManager();
	const me = mailboxId.toLowerCase();
	const hasMasked = !!data.masked;

	// Who has what at each domain. A domain has a catch-all or masked email, not both.
	const catchAllAt = new Map(data.catchAll.map((c) => [c.domain, c.mailbox]));
	const maskedAt = new Map((data.masked ?? []).map((m) => [m.domain, m.mailbox]));
	const modeOf = (d: string): Mode | null => (catchAllAt.get(d) === me ? "catchAll" : maskedAt.get(d) === me ? "masked" : null);
	const mine = data.domains.filter((d) => modeOf(d)).map((d) => ({ domain: d, mode: modeOf(d) as Mode }));
	const others = data.domains.filter((d) => !modeOf(d));
	/** The other mailbox with a catch-all or masked email at a domain, if there is one. */
	const elsewhere = (d: string): { mailbox: string; mode: Mode } | null => {
		const c = catchAllAt.get(d);
		if (c && c !== me) return { mailbox: c, mode: "catchAll" };
		const m = maskedAt.get(d);
		if (m && m !== me) return { mailbox: m, mode: "masked" };
		return null;
	};

	const list = useShowMore(mine, { text: (x) => x.domain });
	const [pick, setPick] = useState("");
	const [mode, setMode] = useState<Mode>("catchAll");
	const [busy, setBusy] = useState(false);
	const picked = others.includes(pick) || pick === EVERY ? pick : "";

	const save = (c: AddressChange) => change.mutateAsync({ mailboxId, change: c });
	const failed = () => toastManager.add({ title: t.failed, variant: "error" });

	const switchMode = (d: string, to: Mode) => save({ kind: to, domain: d, on: true }).catch(failed);
	const turnOff = (d: string, from: Mode) => save({ kind: from, domain: d, on: false }).catch(failed);
	const turnOn = async (e: FormEvent) => {
		e.preventDefault();
		if (!picked) return;
		const domains = picked === EVERY ? others : [picked];
		const taken = domains.filter((d) => elsewhere(d));
		if (picked === EVERY && taken.length > 0 && !window.confirm(fill(t.domainEveryConfirm, { count: String(taken.length) }))) return;
		setBusy(true);
		try {
			// One at a time, so each save sees the last one.
			for (const d of domains) await save({ kind: mode, domain: d, on: true });
			toastManager.add({ title: picked === EVERY ? fill(t.domainOnMany, { count: String(domains.length) }) : fill(t.domainOn, { domain: picked }) });
			setPick("");
		} catch {
			failed();
		} finally {
			setBusy(false);
		}
	};

	const now = picked && picked !== EVERY ? elsewhere(picked) : null;
	const pickedNote = now && fill(now.mode === "catchAll" ? t.domainMovesCatchAll : t.domainMovesMasked, { mailbox: now.mailbox, domain: picked });
	const modeLabel = (m: Mode) => (m === "catchAll" ? t.modeCatchAll : t.modeMasked);

	return (
		<div className="border-t border-kumo-line pt-4">
			<div className="text-sm font-medium text-kumo-default mb-1">{hasMasked ? t.domainTitle : t.catchAllTitle}</div>
			<p className="text-xs text-kumo-subtle mb-3">{hasMasked ? t.domainIntro : t.catchAllIntro}</p>

			{mine.length > 0 ? (<>
				<FindBox list={list} label={t.findDomain} className="mb-2" />
				<ul className="mb-3 divide-y divide-kumo-line rounded-lg border border-kumo-line">
					{list.shown.map(({ domain: d, mode: m }) => (
						<li key={d} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
							<span className="min-w-0 flex-1 truncate text-sm text-kumo-default">{d}</span>
							{hasMasked ? (
								<select aria-label={fill(t.domainModeLabel, { domain: d })} value={m} disabled={busy || change.isPending} onChange={(e) => switchMode(d, e.target.value as Mode)} className={SELECT}>
									<option value="catchAll">{t.modeCatchAll}</option>
									<option value="masked">{t.modeMasked}</option>
								</select>
							) : (
								<span className="text-xs text-kumo-subtle">{t.modeCatchAll}</span>
							)}
							<Button variant="ghost" size="sm" shape="square" icon={<TrashIcon size={14} />} aria-label={fill(t.domainOffLabel, { what: modeLabel(m), domain: d })} title={fill(t.domainOffLabel, { what: modeLabel(m), domain: d })} disabled={busy} onClick={() => turnOff(d, m)} />
						</li>
					))}
				</ul>
				<ShowMoreButton list={list} className="mb-3" />
			</>) : (
				<p className="text-xs text-kumo-subtle mb-3">{t.domainNone}</p>
			)}

			{others.length > 0 ? (
				<form onSubmit={turnOn}>
					<div className="text-sm font-medium text-kumo-default mb-1.5">{t.domainAddLabel}</div>
					<div className="flex flex-wrap items-center gap-2">
						<select aria-label={t.domainLabel} value={picked} onChange={(e) => setPick(e.target.value)} disabled={busy} className={`${SELECT} min-w-0 flex-1 basis-48`}>
							<option value="" disabled>{t.domainPick}</option>
							{others.length > 1 && <option value={EVERY}>{fill(t.domainEvery, { count: String(others.length) })}</option>}
							{others.map((d) => {
								const other = elsewhere(d);
								const tag = other && fill(other.mode === "catchAll" ? t.domainTagCatchAll : t.domainTagMasked, { mailbox: other.mailbox });
								return <option key={d} value={d}>{tag ? `${d} (${tag})` : d}</option>;
							})}
						</select>
						{hasMasked && (
							<select aria-label={t.domainModePick} value={mode} onChange={(e) => setMode(e.target.value as Mode)} disabled={busy} className={SELECT}>
								<option value="catchAll">{t.modeCatchAll}</option>
								<option value="masked">{t.modeMasked}</option>
							</select>
						)}
						<Button type="submit" variant="secondary" icon={<CheckCircleIcon size={14} />} loading={busy} disabled={!picked}>{t.domainTurnOn}</Button>
					</div>
					{pickedNote && <p className="mt-2 text-xs text-kumo-subtle">{pickedNote}</p>}
				</form>
			) : (
				<p className="text-xs text-kumo-subtle">{t.domainAll}</p>
			)}
			{mine.some((x) => x.mode === "catchAll") && <p className="mt-3 text-xs text-kumo-subtle">{t.catchAllSpam}</p>}
		</div>
	);
}
