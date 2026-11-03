// Mail App addition (not part of upstream Agentic Inbox).
// Admin > Routing (admins only): every address that gets email here and the mailbox it goes to, all on
// one page. Each mailbox's own address, its extra addresses (aliases) and each domain's catch-all. An
// admin adds and removes extra addresses and picks the catch-all here, as from a mailbox's ⋮ menu on
// Mailboxes. Wording in app/copy/admin.en-GB.json.

import { Button, Dialog, Input, Loader, Text, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowsSplitIcon, AsteriskIcon, AtIcon, EnvelopeSimpleIcon, PlusIcon } from "@phosphor-icons/react";
import { type FormEvent, useMemo, useState } from "react";
import { Details, Empty, Headings, Menu, Row, Section } from "~/components/AdminTable";
import AdminShell, { Initial, PageHeading, Pill, mailboxTitle } from "~/components/AdminShell";
import { FindBox, ShowMoreButton, useShowMore } from "~/components/ShowMore";
import copy from "~/copy/admin.en-GB.json";
import peopleCopy from "~/copy/people.en-GB.json";
import { fill } from "~/lib/attachments";
import { useAddressBook, useChangeAddresses } from "~/queries/addresses";
import { useMailboxes } from "~/queries/mailboxes";
import { useMe } from "~/queries/people";
import type { Mailbox } from "~/types";
import { pageTitle } from "~/lib/brand";

const t = copy.routing;
const COLUMNS = "md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.5fr)_10rem_3rem]";
const SELECT = "h-10 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-base text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring";

export function meta({ matches }: { matches: readonly unknown[] }) {
	return [{ title: pageTitle(matches, copy.nav.routing) }];
}

type Route = { address: string; mailbox: string; kind: "main" | "alias" | "catchAll"; domain?: string };

export default function RoutingRoute() {
	const { data: me } = useMe();
	const isAdmin = me?.role === "admin";
	const { data: mailboxes = [], isLoading: loadingMailboxes } = useMailboxes();
	const { data: book, isLoading: loadingBook } = useAddressBook(isAdmin);
	const change = useChangeAddresses();
	const toast = useKumoToastManager();
	const [adding, setAdding] = useState(false);
	const [removing, setRemoving] = useState<Route | null>(null);

	const byId = useMemo(() => new Map(mailboxes.map((m) => [m.email.toLowerCase(), m])), [mailboxes]);
	const routes = useMemo<Route[]>(() => {
		if (!book) return [];
		const rows: Route[] = [
			...mailboxes.map((m) => ({ address: m.email.toLowerCase(), mailbox: m.email.toLowerCase(), kind: "main" as const })),
			...book.aliases.map((a) => ({ address: a.address, mailbox: a.mailbox, kind: "alias" as const })),
			...Object.entries(book.catchAll).map(([domain, mailbox]) => ({ address: fill(t.anything, { domain }), mailbox, kind: "catchAll" as const, domain })),
		];
		// By domain, then the address, with a domain's catch-all last.
		const domainOf = (r: Route) => r.domain ?? r.address.split("@")[1] ?? "";
		return rows.sort((a, b) => domainOf(a).localeCompare(domainOf(b)) || (a.kind === "catchAll" ? 1 : 0) - (b.kind === "catchAll" ? 1 : 0) || a.address.localeCompare(b.address));
	}, [book, mailboxes]);
	const list = useShowMore(routes, { limit: 25, text: (r) => `${r.address} ${r.mailbox}` });
	const domainList = useShowMore(book?.domains ?? [], { text: (d) => d });

	const failed = (e: unknown) => toast.add({ title: e instanceof Error && e.message ? e.message : t.failed, variant: "error" });
	const setCatchAll = (domain: string, mailbox: string) => {
		const current = book?.catchAll[domain];
		if ((current ?? "") === mailbox) return;
		const done = { onSuccess: () => toast.add({ title: fill(t.catchAllSaved, { domain }) }), onError: failed };
		if (mailbox) change.mutate({ mailboxId: mailbox, change: { kind: "catchAll", domain, on: true } }, done);
		else if (current) change.mutate({ mailboxId: current, change: { kind: "catchAll", domain, on: false } }, done);
	};

	const loading = !me || (isAdmin && (loadingMailboxes || loadingBook || !book));
	return (
		<AdminShell isAdmin={isAdmin}>
			<PageHeading
				title={copy.nav.routing}
				intro={t.intro}
				action={isAdmin && <Button variant="primary" icon={<PlusIcon size={16} />} onClick={() => setAdding(true)}>{t.new}</Button>}
			/>
			{loading ? (
				<div className="flex justify-center py-20"><Loader size="lg" /></div>
			) : !isAdmin ? (
				<Text>{peopleCopy.adminOnly}</Text>
			) : (<>
				<div className="mb-8 rounded-2xl border border-kumo-line bg-kumo-base shadow-sm">
					<div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
						<FindBox list={list} label={t.find} className="w-full max-w-sm" />
						<span className="text-sm text-kumo-subtle">{routes.length === 1 ? t.countOne : fill(t.count, { count: routes.length })}</span>
					</div>
					{routes.length === 0 ? (
						<Empty icon={<ArrowsSplitIcon size={32} />} text={t.intro} />
					) : (<>
						<div className="border-t border-kumo-line" />
						<Headings columns={COLUMNS} labels={[t.columns.address, t.columns.goesTo, t.columns.kind]} />
						{list.shown.map((r, i) => (
							<Row key={`${r.kind}:${r.address}`} columns={COLUMNS} first={i === 0}>
								<div className="flex min-w-0 items-center gap-3">
									<span className={`inline-flex size-9 shrink-0 items-center justify-center rounded-full ${r.kind === "catchAll" ? "bg-amber-100 text-amber-800" : r.kind === "alias" ? "bg-violet-100 text-violet-800" : "bg-sky-100 text-sky-800"}`}>
										{r.kind === "catchAll" ? <AsteriskIcon size={17} weight="bold" /> : r.kind === "alias" ? <AtIcon size={17} weight="bold" /> : <EnvelopeSimpleIcon size={17} weight="bold" />}
									</span>
									<span className="truncate text-base font-semibold text-kumo-default">{r.address}</span>
								</div>
								<div className="justify-self-end md:order-last">
									{r.kind === "alias" && (
										<Menu label={fill(t.menu, { address: r.address })} items={[{ label: t.remove, danger: true, onClick: () => setRemoving(r) }]} />
									)}
								</div>
								<Details>
									<MailboxCell mailbox={byId.get(r.mailbox)} email={r.mailbox} />
									<div>
										<Pill tone={r.kind === "catchAll" ? "amber" : r.kind === "alias" ? "violet" : "blue"} title={t.kindHelp[r.kind]}>{t.kind[r.kind]}</Pill>
									</div>
								</Details>
							</Row>
						))}
						<ShowMoreButton list={list} className="mx-5 my-3" />
					</>)}
				</div>

				<Section title={t.catchAllTitle} intro={t.catchAllIntro} action={null}>
					{domainList.canFind && (
						<div className="border-b border-kumo-line px-4 py-3 sm:px-5">
							<FindBox list={domainList} label={t.findDomain} className="w-full max-w-sm" />
						</div>
					)}
					{domainList.shown.map((domain, i) => (
						<div key={domain} className={`grid gap-2 px-4 py-4 sm:px-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:items-center md:gap-4 ${i ? "border-t border-kumo-line" : ""}`}>
							<label htmlFor={`catch-${domain}`} className="text-base font-semibold text-kumo-default">{fill(t.anything, { domain })}</label>
							<select id={`catch-${domain}`} className={SELECT} value={book!.catchAll[domain] ?? ""} disabled={change.isPending} onChange={(e) => setCatchAll(domain, e.target.value)}>
								<option value="">{t.catchAllOff}</option>
								{mailboxes.filter((m) => m.email.toLowerCase().endsWith(`@${domain}`)).map((m) => (
									<option key={m.id} value={m.email.toLowerCase()}>{mailboxTitle(m)} ({m.email})</option>
								))}
							</select>
						</div>
					))}
					<ShowMoreButton list={domainList} className="mx-5 my-3" />
				</Section>
			</>)}

			{adding && book && (
				<NewAddressDialog
					mailboxes={mailboxes}
					domains={book.domains}
					onClose={() => setAdding(false)}
					onAdd={(mailboxId, address) => new Promise<void>((resolve, reject) => change.mutate({ mailboxId, change: { kind: "add", address } }, {
						onSuccess: () => { toast.add({ title: fill(t.form.added, { address }) }); setAdding(false); resolve(); },
						onError: reject,
					}))}
				/>
			)}

			{removing && (
				<Dialog.Root open onOpenChange={(open) => { if (!open) setRemoving(null); }}>
					<Dialog size="sm" className="p-6">
						<Dialog.Title className="mb-2 text-lg font-semibold">{fill(t.removeTitle, { address: removing.address })}</Dialog.Title>
						<Dialog.Description className="mb-5 break-words text-base text-kumo-subtle">{fill(t.removeBody, { address: removing.address })}</Dialog.Description>
						<div className="flex justify-end gap-2">
							<Dialog.Close render={(props) => <Button {...props} variant="secondary">{t.form.cancel}</Button>} />
							<Button variant="destructive" loading={change.isPending} onClick={() => change.mutate({ mailboxId: removing.mailbox, change: { kind: "remove", address: removing.address } }, {
								onSuccess: () => { toast.add({ title: fill(t.removed, { address: removing.address }) }); setRemoving(null); },
								onError: failed,
							})}>{t.remove}</Button>
						</div>
					</Dialog>
				</Dialog.Root>
			)}
		</AdminShell>
	);
}

function MailboxCell({ mailbox, email }: { mailbox?: Mailbox; email: string }) {
	const title = mailbox ? mailboxTitle(mailbox) : email;
	return (
		<div className="flex min-w-0 items-center gap-2.5 pl-12 md:pl-0">
			<Initial name={title} size={28} />
			<div className="min-w-0">
				<div className="truncate text-base text-kumo-default">{title}</div>
				<div className="truncate text-sm text-kumo-subtle">{email}</div>
			</div>
		</div>
	);
}

function NewAddressDialog({ mailboxes, domains, onClose, onAdd }: {
	mailboxes: Mailbox[];
	domains: string[];
	onClose: () => void;
	onAdd: (mailboxId: string, address: string) => Promise<void>;
}) {
	const f = t.form;
	const [local, setLocal] = useState("");
	const [domain, setDomain] = useState(domains[0] ?? "");
	const [mailbox, setMailbox] = useState(mailboxes[0]?.email.toLowerCase() ?? "");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const raw = local.trim();
		if (!raw || !mailbox) return;
		setSaving(true);
		setError(null);
		try {
			await onAdd(mailbox, raw.includes("@") ? raw : `${raw}@${domain}`);
		} catch (err) {
			setError(err instanceof Error && err.message ? err.message : t.failed);
		} finally {
			setSaving(false);
		}
	};
	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="mb-2 text-lg font-semibold">{f.title}</Dialog.Title>
				<p className="mb-4 text-base text-kumo-subtle">{f.help}</p>
				<form onSubmit={submit} className="space-y-4">
					{error && <Text variant="error">{error}</Text>}
					<div className="flex items-end gap-2">
						<div className="min-w-0 flex-1">
							<Input label={f.address} placeholder="sales" value={local} onChange={(e) => setLocal(e.target.value)} required />
						</div>
						<span className="pb-2.5 text-base text-kumo-subtle">@</span>
						<select aria-label={f.domain} className={`${SELECT} w-auto max-w-[12rem]`} value={domain} onChange={(e) => setDomain(e.target.value)} disabled={local.includes("@")}>
							{domains.map((d) => <option key={d} value={d}>{d}</option>)}
						</select>
					</div>
					<div>
						<label htmlFor="new-address-mailbox" className="mb-1.5 block text-sm font-semibold text-kumo-default">{f.mailbox}</label>
						<select id="new-address-mailbox" className={SELECT} value={mailbox} onChange={(e) => setMailbox(e.target.value)}>
							{mailboxes.map((m) => <option key={m.id} value={m.email.toLowerCase()}>{mailboxTitle(m)} ({m.email})</option>)}
						</select>
					</div>
					<div className="flex justify-end gap-2 pt-1">
						<Button type="button" variant="secondary" onClick={onClose}>{f.cancel}</Button>
						<Button type="submit" variant="primary" loading={saving}>{f.add}</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
