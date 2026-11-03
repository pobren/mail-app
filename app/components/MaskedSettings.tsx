// Mail App: Settings › Masked email. Make a fresh address for each website, Keep or Block ones that
// arrived out of the blue, switch any off (mail to it is then sent back), and see possible leaks.
// Which domains a mailbox has masked email at is set by the admin on the Mailboxes page. Each change
// saves straight away.

import { Badge, Button, Input, Loader, Switch, Text, useKumoToastManager } from "@cloudflare/kumo";
import { CopyIcon, MaskHappyIcon, WarningIcon } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { maskedEnded, type MaskedAddress } from "shared/masked";
import { fill } from "~/lib/attachments";
import { useChangeMasked, useMasked } from "~/queries/addresses";
import { useUpdateMailbox } from "~/queries/mailboxes";
import type { MailboxSettings } from "~/types";
import copy from "~/copy/settings.en-GB.json";
import { FindBox, ShowMoreButton, shortList, useShowMore } from "~/components/ShowMore";

const t = copy.masked;
const selectClass = "h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-2.5 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring";
const DAY = 86_400_000;

type Ends = "never" | "once" | "1" | "7" | "30" | "date";

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default function MaskedSettings({ mailboxId, settings }: { mailboxId: string; settings?: MailboxSettings }) {
	const { data, isLoading } = useMasked(mailboxId);
	const list = useShowMore(data?.addresses ?? [], { text: (m) => `${m.address} ${m.label ?? ""} ${m.sites.join(" ")}` });
	if (isLoading || !data) return <div className="flex justify-center py-8"><Loader size="sm" /></div>;

	if (data.domains.length === 0) {
		const [before, after] = t.notOn.split("{link}");
		return (
			<Card>
				<p className="text-sm text-kumo-subtle">{t.intro}</p>
				<p className="mt-3 text-sm text-kumo-default">
					{before}<Link to="/" className="text-kumo-link underline">{t.notOnLink}</Link>{after}
				</p>
			</Card>
		);
	}

	return (<>
		<Card>
			<p className="text-sm text-kumo-subtle mb-4">{t.intro}</p>
			<NewMasked mailboxId={mailboxId} domains={data.domains} />
		</Card>

		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<FindBox list={list} label={t.find} className="mb-2" />
			{data.addresses.length === 0 ? (
				<p className="text-sm text-kumo-subtle">{t.none}</p>
			) : (
				<ul className="divide-y divide-kumo-line rounded-lg border border-kumo-line">
					{list.shown.map((m) => <MaskedRow key={m.address} mailboxId={mailboxId} m={m} />)}
				</ul>
			)}
			<ShowMoreButton list={list} className="mt-3" />
			<p className="mt-3 text-xs text-kumo-subtle">{fill(t.makeUp, { example: `shop.anything@${data.domains[0]}` })}</p>
		</div>

		<KeepNewSetting mailboxId={mailboxId} settings={settings} />
	</>);
}

function Card({ children }: { children: React.ReactNode }) {
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-2">
				<MaskHappyIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{t.title}</span>
			</div>
			{children}
		</div>
	);
}

function NewMasked({ mailboxId, domains }: { mailboxId: string; domains: string[] }) {
	const change = useChangeMasked();
	const toastManager = useKumoToastManager();
	const [label, setLabel] = useState("");
	const [domain, setDomain] = useState(domains[0]);
	const [ends, setEnds] = useState<Ends>("never");
	const [date, setDate] = useState("");
	const [made, setMade] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const submit = (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		const expires = ends === "date" ? (date ? new Date(`${date}T23:59:59`).toISOString() : null)
			: ends === "1" || ends === "7" || ends === "30" ? new Date(Date.now() + Number(ends) * DAY).toISOString() : null;
		change.mutate({ mailboxId, create: { label: label.trim() || undefined, domain, expires, once: ends === "once" } }, {
			onSuccess: (view) => { setMade(view.created ?? null); setLabel(""); },
			onError: (err) => setError(err instanceof Error ? err.message : t.failed),
		});
	};
	const copyIt = async (address: string) => {
		try { await navigator.clipboard.writeText(address); toastManager.add({ title: t.copied }); } catch { /* the address is on screen to copy by hand */ }
	};

	return (
		<form onSubmit={submit} className="space-y-3">
			<div className="text-sm font-medium text-kumo-default">{t.newTitle}</div>
			<div>
				<Input label={t.label} placeholder={t.labelPlaceholder} value={label} onChange={(e) => setLabel(e.target.value)} />
				<p className="mt-1 text-xs text-kumo-subtle">{t.labelHint}</p>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				{domains.length > 1 && (
					<label className="block">
						<span className="block text-sm font-medium text-kumo-default mb-1">{t.domain}</span>
						<select value={domain} onChange={(e) => setDomain(e.target.value)} className={selectClass}>
							{domains.map((d) => <option key={d} value={d}>{d}</option>)}
						</select>
					</label>
				)}
				<label className="block">
					<span className="block text-sm font-medium text-kumo-default mb-1">{t.ends}</span>
					<select value={ends} onChange={(e) => setEnds(e.target.value as Ends)} className={selectClass}>
						<option value="never">{t.endsNever}</option>
						<option value="once">{t.endsOnce}</option>
						<option value="1">{t.endsDay}</option>
						<option value="7">{t.endsWeek}</option>
						<option value="30">{t.endsMonth}</option>
						<option value="date">{t.endsDate}</option>
					</select>
				</label>
				{ends === "date" && (
					<Input label={t.endsDateLabel} type="date" value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
				)}
			</div>
			<div className="flex justify-end">
				<Button type="submit" variant="primary" loading={change.isPending}>{t.make}</Button>
			</div>
			{error && <Text variant="error" size="sm">{error}</Text>}
			{made && (
				<div className="rounded-lg border border-kumo-brand/40 bg-kumo-brand/5 px-3 py-3">
					<p className="text-xs text-kumo-subtle mb-1.5">{t.made}</p>
					<div className="flex items-center justify-between gap-2">
						<span className="truncate font-mono text-base font-semibold text-kumo-default">{made}</span>
						<Button type="button" variant="secondary" size="sm" icon={<CopyIcon size={14} />} onClick={() => copyIt(made)}>{t.copy}</Button>
					</div>
				</div>
			)}
		</form>
	);
}

function MaskedRow({ mailboxId, m }: { mailboxId: string; m: MaskedAddress }) {
	const change = useChangeMasked();
	const toastManager = useKumoToastManager();
	const ended = maskedEnded(m);
	const set = (c: Parameters<typeof change.mutate>[0]["change"]) => change.mutate({ mailboxId, address: m.address, change: c }, {
		onError: () => toastManager.add({ title: t.failed, variant: "error" }),
	});
	const status = m.status === "waiting" ? <Badge variant="primary">{t.waiting}</Badge>
		: m.status === "off" ? <Badge variant="secondary">{t.off}</Badge>
		: ended ? <Badge variant="secondary">{t.ended}</Badge>
		: <Badge variant="outline">{t.on}</Badge>;
	const details = [
		m.count === 0 ? t.countNone : m.count === 1 ? t.countOne : fill(t.count, { count: m.count }),
		m.sites.length ? fill(t.sites, { sites: shortList(m.sites) }) : null,
		m.once ? (ended ? fill(t.endedOn, { date: shortDate(m.last ?? m.created) }) : t.endsAfterOne)
			: m.expires ? fill(ended ? t.endedOn : t.endsOn, { date: shortDate(m.expires) }) : null,
	].filter(Boolean).join(" · ");

	return (
		<li className="px-3 py-2.5">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className={`truncate font-mono text-sm ${m.status === "off" || ended ? "text-kumo-subtle line-through" : "text-kumo-default"}`}>{m.address}</span>
						{status}
					</div>
					{m.label && <div className="truncate text-sm text-kumo-default">{m.label}</div>}
					<div className="truncate text-xs text-kumo-subtle">{details}</div>
				</div>
				<div className="flex shrink-0 gap-1">
					{m.status === "waiting" ? (<>
						<Button size="sm" variant="primary" onClick={() => set({ status: "on" })}>{t.keep}</Button>
						<Button size="sm" variant="secondary" onClick={() => set({ status: "off" })}>{t.block}</Button>
					</>) : m.status === "off" ? (
						<Button size="sm" variant="ghost" onClick={() => set({ status: "on" })}>{t.switchOn}</Button>
					) : !ended ? (
						<Button size="sm" variant="ghost" onClick={() => set({ status: "off" })}>{t.switchOff}</Button>
					) : null}
				</div>
			</div>
			{m.status === "waiting" && <p className="mt-1.5 text-xs text-kumo-subtle">{t.waitingNote}</p>}
			{m.leak && m.status !== "off" && (
				<div className="mt-2 rounded-md bg-kumo-warning/10 px-2.5 py-2 sm:flex sm:items-center sm:gap-2">
					<div className="flex flex-1 items-start gap-2">
						<WarningIcon size={14} weight="fill" className="mt-0.5 shrink-0 text-kumo-warning" />
						<span className="text-xs text-kumo-default">{fill(t.leakNote, { site: m.leak })}</span>
					</div>
					<div className="mt-2 flex gap-1 sm:mt-0 sm:shrink-0">
						<Button size="xs" variant="primary" onClick={() => set({ status: "off" })}>{t.switchOff}</Button>
						<Button size="xs" variant="secondary" onClick={() => set({ trustSite: m.leak })}>{t.trust}</Button>
					</div>
				</div>
			)}
		</li>
	);
}

function KeepNewSetting({ mailboxId, settings }: { mailboxId: string; settings?: MailboxSettings }) {
	const update = useUpdateMailbox();
	const toastManager = useKumoToastManager();
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<Switch
				label={t.keepNewTitle}
				checked={!!settings?.maskedKeepNew}
				onCheckedChange={(on) => update.mutate({ mailboxId, settings: { ...settings, maskedKeepNew: on } }, {
					onSuccess: () => toastManager.add({ title: t.saved }),
					onError: () => toastManager.add({ title: t.failed, variant: "error" }),
				})}
			/>
			<p className="mt-2 text-xs text-kumo-subtle">{t.keepNewNote}</p>
		</div>
	);
}
