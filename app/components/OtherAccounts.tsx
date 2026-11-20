// Mail App: Settings › Other accounts. Bring mail in from Gmail, iCloud, Yahoo or any IMAP or POP3 account,
// and send as it through its own server. Pick a provider (its servers are filled in), or Other to type
// them in. The password is checked against the provider before it's saved, then never shown again.
// How it works is in shared/other-accounts.ts; words are in app/copy/other-accounts.en-GB.json.

import { Badge, Button, Input, Loader, Switch, Text, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowClockwiseIcon, CheckCircleIcon, ClockIcon, EnvelopeSimpleIcon, KeyIcon, PencilSimpleIcon, PlugsConnectedIcon,
	PlusIcon, ShieldCheckIcon, TrashIcon, TrayArrowDownIcon, WarningIcon, XIcon,
} from "@phosphor-icons/react";
import { type FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	PRESETS, notPossible, presetById, presetFor, securityForPort, SLOW_AFTER_FAILURES,
	type NewAccountInput, type OtherAccountView, type Protocol, type Security,
} from "shared/other-accounts";
import { fill } from "~/lib/attachments";
import { queryKeys } from "~/queries/keys";
import api, { type OtherAccountsView } from "~/services/api";
import copy from "~/copy/other-accounts.en-GB.json";

const t = copy;
const selectClass = "h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-2.5 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring";

const when = (iso: string) => {
	const d = new Date(iso);
	const today = d.toDateString() === new Date().toDateString();
	const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	return today ? time : `${time} on ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
};

export default function OtherAccounts({ mailboxId }: { mailboxId: string }) {
	const qc = useQueryClient();
	const key = ["other-accounts", mailboxId];
	const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.getOtherAccounts(mailboxId), refetchInterval: 60_000 });
	const [adding, setAdding] = useState(false);
	const toast = useKumoToastManager();

	const changed = (next: OtherAccountsView) => {
		qc.setQueryData(key, next);
		// The From menu reads the mailbox's addresses.
		qc.invalidateQueries({ queryKey: queryKeys.addresses(mailboxId) });
	};

	if (isLoading || !data) return <div className="flex justify-center py-8"><Loader size="sm" /></div>;
	const full = data.accounts.length >= data.max;

	return (<>
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-2">
				<TrayArrowDownIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{t.title}</span>
			</div>
			<p className="text-sm text-kumo-subtle">{t.intro}</p>
			{data.off && <p className="mt-3 flex items-start gap-1.5 text-sm text-kumo-default"><WarningIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-kumo-warning" />{t.off}</p>}

			{data.accounts.length > 0 && (
				<ul className="mt-4 divide-y divide-kumo-line rounded-lg border border-kumo-line">
					{data.accounts.map((a) => <AccountRow key={a.id} mailboxId={mailboxId} account={a} off={data.off} onChange={changed} />)}
				</ul>
			)}
			{data.accounts.length === 0 && !adding && <p className="mt-4 text-sm text-kumo-subtle">{t.none}</p>}

			{!data.off && !adding && (
				<div className="mt-4">
					{full
						? <p className="text-xs text-kumo-subtle">{fill(t.limit, { max: data.max })}</p>
						: <Button variant="primary" size="sm" icon={<PlusIcon size={14} />} onClick={() => setAdding(true)}>{t.add}</Button>}
				</div>
			)}
			{adding && (
				<AddAccount mailboxId={mailboxId} onCancel={() => setAdding(false)} onAdded={(next, address) => {
					changed(next);
					setAdding(false);
					toast.add({ title: fill(t.added, { address }) });
				}} />
			)}
			<p className="mt-4 flex items-start gap-1.5 text-xs text-kumo-subtle"><ClockIcon size={14} className="mt-px shrink-0" />{t.notInstant}</p>
		</div>
		<AdminSwitch onChange={() => qc.invalidateQueries({ queryKey: key })} />
	</>);
}

function AccountRow({ mailboxId, account: a, off, onChange }: { mailboxId: string; account: OtherAccountView; off: boolean; onChange: (v: OtherAccountsView) => void }) {
	const toast = useKumoToastManager();
	const [editing, setEditing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const check = useMutation({
		mutationFn: () => api.checkOtherAccount(mailboxId, a.id),
		onSuccess: (v) => { onChange(v); setError(null); toast.add({ title: fill(t.checked, { address: a.address }) }); },
		onError: (e) => setError((e as Error)?.message || t.failed),
	});
	const remove = useMutation({
		mutationFn: () => api.removeOtherAccount(mailboxId, a.id),
		onSuccess: (v) => { onChange(v); toast.add({ title: fill(t.removed, { address: a.address }) }); },
		onError: (e) => setError((e as Error)?.message || t.failed),
	});
	const provider = presetById(a.provider)?.name ?? a.incoming.host;
	const s = a.status;

	return (
		<li className="px-3 py-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<EnvelopeSimpleIcon size={16} className="shrink-0 text-kumo-subtle" />
						<span className="truncate text-sm font-medium text-kumo-default">{a.address}</span>
						<Badge variant="secondary">{provider}</Badge>
						{a.label && <Badge variant="outline">{a.label}</Badge>}
					</div>
					<p className="mt-1 text-xs text-kumo-subtle">
						{a.outgoing ? `${fill(t.bringsIn, { protocol: a.protocol === "pop3" ? "POP3" : "IMAP" })} ${t.andSends}` : t.receiveOnly}
						{a.name ? ` · ${a.name}` : ""}
					</p>
				</div>
				<div className="flex flex-wrap gap-1.5">
					<Button variant="secondary" size="xs" icon={<ArrowClockwiseIcon size={12} />} loading={check.isPending} disabled={off} onClick={() => check.mutate()}>{t.checkNow}</Button>
					<Button variant="ghost" size="xs" icon={<PencilSimpleIcon size={12} />} onClick={() => setEditing((v) => !v)}>{t.edit}</Button>
					<Button variant="ghost" size="xs" icon={<TrashIcon size={12} />} loading={remove.isPending}
						onClick={() => { if (window.confirm(fill(t.removeConfirm, { address: a.address }))) remove.mutate(); }}>{t.remove}</Button>
				</div>
			</div>
			<Status status={s} />
			{error && <Text variant="error" size="sm">{error}</Text>}
			{editing && <EditAccount mailboxId={mailboxId} account={a} onDone={(v) => { if (v) onChange(v); setEditing(false); }} />}
		</li>
	);
}

function Status({ status: s }: { status: OtherAccountView["status"] }) {
	const line = (icon: React.ReactNode, text: string) => <p className="mt-2 flex items-start gap-1.5 text-xs text-kumo-default">{icon}<span>{text}</span></p>;
	return (<>
		{s.error && s.checkedAt
			? line(<WarningIcon size={14} weight="fill" className="mt-px shrink-0 text-kumo-warning" />, fill(t.statusFailed, { when: when(s.checkedAt), error: s.error }))
			: s.catchingUp
			? line(<ArrowClockwiseIcon size={14} className="mt-px shrink-0 text-kumo-subtle" />, fill(t.statusCatchingUp, { count: s.fetched }))
			: s.checkedAt
			? line(<CheckCircleIcon size={14} weight="fill" className="mt-px shrink-0 text-kumo-success" />, fill(t.statusOk, { when: when(s.checkedAt), count: s.fetched }))
			: line(<ClockIcon size={14} className="mt-px shrink-0 text-kumo-subtle" />, t.statusWaiting)}
		{s.failures >= SLOW_AFTER_FAILURES && <p className="mt-1 text-xs text-kumo-subtle">{fill(t.statusSlow, { failures: s.failures })}</p>}
		{s.tooBig > 0 && <p className="mt-1 text-xs text-kumo-subtle">{fill(t.tooBig, { count: s.tooBig })}</p>}
	</>);
}

function EditAccount({ mailboxId, account: a, onDone }: { mailboxId: string; account: OtherAccountView; onDone: (v?: OtherAccountsView) => void }) {
	const toast = useKumoToastManager();
	const [name, setName] = useState(a.name ?? "");
	const [label, setLabel] = useState(a.label);
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const save = useMutation({
		mutationFn: () => api.changeOtherAccount(mailboxId, a.id, { name, label, ...(password ? { password } : {}) }),
		onSuccess: (v) => { toast.add({ title: password ? t.passwordSaved : t.saved }); onDone(v); },
		onError: (e) => setError((e as Error)?.message || t.failed),
	});
	const submit = (e: FormEvent) => { e.preventDefault(); setError(null); save.mutate(); };
	return (
		<form onSubmit={submit} className="mt-3 space-y-3 rounded-lg border border-kumo-line p-3">
			{a.outgoing && <Input label={t.name} placeholder={t.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />}
			<div>
				<Input label={t.label} value={label} onChange={(e) => setLabel(e.target.value)} />
				<p className="mt-1 text-xs text-kumo-subtle">{t.labelHint}</p>
			</div>
			<Input label={t.changePassword} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
			{error && <Text variant="error" size="sm">{error}</Text>}
			<div className="flex gap-2">
				<Button type="submit" variant="primary" size="sm" icon={<CheckCircleIcon size={14} />} loading={save.isPending}>{t.save}</Button>
				<Button type="button" variant="ghost" size="sm" icon={<XIcon size={14} />} onClick={() => onDone()}>{t.cancel}</Button>
			</div>
		</form>
	);
}

function ServerFields({ title, value, onChange }: { title: string; value: { host: string; port: string; security: Security }; onChange: (v: { host: string; port: string; security: Security }) => void }) {
	return (
		<fieldset className="space-y-2">
			<legend className="text-sm font-medium text-kumo-default mb-1">{title}</legend>
			<div className="grid gap-2 sm:grid-cols-[1fr_6rem_9rem]">
				<Input label={t.server} placeholder="imap.example.com" value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value })} />
				<Input label={t.port} inputMode="numeric" value={value.port}
					onChange={(e) => { const port = e.target.value.replace(/\D/g, ""); onChange({ ...value, port, security: port ? securityForPort(Number(port)) : value.security }); }} />
				<label className="block">
					<span className="block text-sm font-medium text-kumo-default mb-1">{t.security}</span>
					<select value={value.security} onChange={(e) => onChange({ ...value, security: e.target.value as Security })} className={selectClass}>
						<option value="tls">{t.tls}</option>
						<option value="starttls">{t.starttls}</option>
					</select>
				</label>
			</div>
		</fieldset>
	);
}

function AddAccount({ mailboxId, onCancel, onAdded }: { mailboxId: string; onCancel: () => void; onAdded: (v: OtherAccountsView, address: string) => void }) {
	const [provider, setProvider] = useState<string | null>(null);
	const [address, setAddress] = useState("");
	const [password, setPassword] = useState("");
	const [name, setName] = useState("");
	const [protocol, setProtocol] = useState<Protocol>("imap");
	const [catchUp, setCatchUp] = useState(false);
	const [sendAs, setSendAs] = useState(true);
	const [label, setLabel] = useState("");
	const [labelTouched, setLabelTouched] = useState(false);
	const [username, setUsername] = useState("");
	const [incoming, setIncoming] = useState({ host: "", port: "993", security: "tls" as Security });
	const [outgoing, setOutgoing] = useState({ host: "", port: "465", security: "tls" as Security });
	const [error, setError] = useState<string | null>(null);

	const preset = provider && provider !== "other" ? presetById(provider) : undefined;
	const canPop = provider === "other" || !!preset?.pop3;

	// The label follows the provider (or the address, for Other) until it's typed over.
	useEffect(() => {
		if (labelTouched) return;
		setLabel(preset?.name ?? (address.includes("@") ? address.trim().toLowerCase() : ""));
	}, [preset, address, labelTouched]);
	useEffect(() => { if (!canPop) setProtocol("imap"); }, [canPop]);
	useEffect(() => { if (protocol === "pop3") setCatchUp(false); }, [protocol]);
	useEffect(() => {
		if (provider !== "other") return;
		setIncoming((v) => ({ ...v, port: protocol === "pop3" ? "995" : "993", security: "tls" }));
	}, [protocol, provider]);

	const add = useMutation({
		mutationFn: (input: NewAccountInput) => api.addOtherAccount(mailboxId, input),
		onSuccess: (v) => onAdded(v, address.trim().toLowerCase()),
		onError: (e) => setError((e as Error)?.message || t.failed),
	});

	const submit = (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		const blocked = notPossible(address);
		if (blocked) { setError(blocked); return; }
		const server = (v: typeof incoming) => ({ host: v.host.trim(), port: Number(v.port), security: v.security });
		add.mutate({
			address: address.trim(), password, name: name.trim() || undefined, provider: provider ?? "other", protocol,
			label, catchUp, username: provider === "other" ? username.trim() || undefined : undefined,
			incoming: provider === "other" ? server(incoming) : undefined,
			outgoing: sendAs ? (provider === "other" ? server(outgoing) : undefined) : null,
		});
	};

	if (!provider) {
		return (
			<div className="mt-4 space-y-3">
				<div className="text-sm font-medium text-kumo-default">{t.pickProvider}</div>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
					{PRESETS.map((p) => (
						<Button key={p.id} variant="secondary" size="sm" icon={<EnvelopeSimpleIcon size={14} />} onClick={() => setProvider(p.id)}>{p.name}</Button>
					))}
					<Button variant="secondary" size="sm" icon={<PlugsConnectedIcon size={14} />} onClick={() => setProvider("other")}>{t.other}</Button>
				</div>
				<Button variant="ghost" size="sm" icon={<XIcon size={14} />} onClick={onCancel}>{t.cancel}</Button>
			</div>
		);
	}

	return (
		<form onSubmit={submit} className="mt-4 space-y-4 rounded-lg border border-kumo-line p-4">
			<div className="flex items-center gap-2 text-sm font-medium text-kumo-default">
				<EnvelopeSimpleIcon size={16} className="text-kumo-subtle" />
				{preset?.name ?? t.other}
			</div>
			<Input label={t.address} type="email" autoComplete="off" placeholder={t.addressPlaceholder} value={address}
				onChange={(e) => {
					setAddress(e.target.value);
					// Typing a Gmail address after choosing Other switches to Gmail's settings.
					const found = presetFor(e.target.value);
					if (provider === "other" && found) setProvider(found.id);
				}} />
			<div>
				<Input label={preset?.appPasswordUrl ? t.appPassword : t.password} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
				{preset && <p className="mt-1 text-xs text-kumo-subtle">{preset.note}</p>}
				{preset?.appPasswordUrl && (
					<a href={preset.appPasswordUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-kumo-link underline">
						<KeyIcon size={12} />{t.makeAppPassword}
					</a>
				)}
			</div>

			{canPop && (
				<label className="block">
					<span className="block text-sm font-medium text-kumo-default mb-1">{t.how}</span>
					<select value={protocol} onChange={(e) => setProtocol(e.target.value as Protocol)} className={selectClass}>
						<option value="imap">{t.imap}</option>
						<option value="pop3">{t.pop3}</option>
					</select>
					{protocol === "pop3" && <p className="mt-1 text-xs text-kumo-subtle">{t.pop3Hint}</p>}
				</label>
			)}

			{provider === "other" && (<>
				<Input label={t.username} placeholder={t.usernamePlaceholder} value={username} onChange={(e) => setUsername(e.target.value)} />
				<ServerFields title={t.incomingServer} value={incoming} onChange={setIncoming} />
				{sendAs && <ServerFields title={t.outgoingServer} value={outgoing} onChange={setOutgoing} />}
			</>)}

			{protocol === "imap" && (
				<div>
					<Switch label={t.catchUp} checked={catchUp} onCheckedChange={setCatchUp} />
					{catchUp && <p className="mt-1.5 text-xs text-kumo-subtle">{t.catchUpHint}</p>}
				</div>
			)}
			<div>
				<Switch label={t.sendAs} checked={sendAs} onCheckedChange={setSendAs} />
				{sendAs && <p className="mt-1.5 text-xs text-kumo-subtle">{t.sendAsHint}</p>}
			</div>
			{sendAs && <Input label={t.name} placeholder={t.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />}
			<div>
				<Input label={t.label} value={label} onChange={(e) => { setLabel(e.target.value); setLabelTouched(true); }} />
				<p className="mt-1 text-xs text-kumo-subtle">{t.labelHint}</p>
			</div>

			{error && <p role="alert" className="flex items-start gap-1.5 text-sm text-kumo-danger"><WarningIcon size={16} weight="fill" className="mt-0.5 shrink-0" />{error}</p>}
			{add.isPending && <p className="text-xs text-kumo-subtle">{t.connecting}</p>}
			<div className="flex flex-wrap gap-2">
				<Button type="submit" variant="primary" size="sm" icon={<PlugsConnectedIcon size={14} />} loading={add.isPending} disabled={!address.trim() || !password}>{t.connect}</Button>
				<Button type="button" variant="ghost" size="sm" icon={<XIcon size={14} />} onClick={onCancel}>{t.cancel}</Button>
			</div>
		</form>
	);
}

function AdminSwitch({ onChange }: { onChange: () => void }) {
	const qc = useQueryClient();
	const { data } = useQuery({ queryKey: ["other-accounts-switch"], queryFn: () => api.getOtherAccountsSwitch() });
	const set = useMutation({
		mutationFn: (off: boolean) => api.setOtherAccountsSwitch(off),
		onSuccess: (v) => { qc.setQueryData(["other-accounts-switch"], v); onChange(); },
	});
	if (!data?.admin) return null;
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-2">
				<ShieldCheckIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{t.adminTitle}</span>
			</div>
			<Switch label={t.adminSwitch} checked={!data.off} disabled={set.isPending} onCheckedChange={(on) => set.mutate(!on)} />
			{data.off && <p className="mt-1.5 text-xs text-kumo-subtle">{t.adminOffHint}</p>}
		</div>
	);
}
