// Mail App addition (not part of upstream Agentic Inbox).
// The Domains page (admins only): every domain this install gets email for, in a table like Users and
// Routing, with a check of each one's mail records. "Add domains" lists a domain that's already set up in
// Cloudflare (Email Routing on, with a catch-all to this Worker). Wording in app/copy/domains.en-GB.json.
import { Button, Dialog, Input, Loader, Text, useKumoToastManager } from "@cloudflare/kumo";
import { CheckCircleIcon, GlobeIcon, PlusIcon, QuestionIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Details, Empty, Headings, Menu, Row } from "~/components/AdminTable";
import AdminShell, { PageHeading, Pill } from "~/components/AdminShell";
import { FindBox, ShowMoreButton, useShowMore } from "~/components/ShowMore";
import adminCopy from "~/copy/admin.en-GB.json";
import copy from "~/copy/domains.en-GB.json";
import peopleCopy from "~/copy/people.en-GB.json";
import { fill } from "~/lib/attachments";
import { useAddDomains, useDomains, useRefreshDomains, useRemoveDomain } from "~/queries/domains";
import { useMe } from "~/queries/people";
import { pageTitle } from "~/lib/brand";

const RECORD_NAMES: Record<string, string> = { mx: "MX", spf: "SPF", dkim: "DKIM", dmarc: "DMARC" };
const COLUMNS = "md:grid-cols-[minmax(0,1.6fr)_9rem_minmax(0,1.2fr)_9rem_3rem]";

export function meta({ matches }: { matches: readonly unknown[] }) {
	return [{ title: pageTitle(matches, adminCopy.nav.domains) }];
}

export default function DomainsRoute() {
	const { data: me } = useMe();
	const isAdmin = me?.role === "admin";
	const { data, isLoading } = useDomains(isAdmin);
	const remove = useRemoveDomain();
	const add = useAddDomains();
	const refresh = useRefreshDomains();
	const toast = useKumoToastManager();
	const [removing, setRemoving] = useState<string | null>(null);
	const domains = data?.domains ?? [];
	const list = useShowMore(domains, { text: (d) => d.name });

	const [adding, setAdding] = useState(false);
	const [names, setNames] = useState("");
	const openAdd = () => { setNames(""); setAdding(true); };
	const saveAdd = () => {
		const list = names.split(/[\s,]+/).map((n) => n.trim()).filter(Boolean);
		if (!list.length) return;
		add.mutate(list, {
			onSettled: () => refresh(),
			onSuccess: (res) => {
				if (res.added.length) toast.add({ title: fill(copy.added, { domains: res.added.join(", ") }) });
				if (res.skipped.length) toast.add({ title: fill(copy.notReady, { domains: res.skipped.join(", ") }), variant: "error" });
				if (!res.skipped.length) setAdding(false);
			},
			onError: (err) => toast.add({ title: err instanceof Error && err.message ? err.message : copy.failed, variant: "error" }),
		});
	};

	const loading = !me || (isAdmin && (isLoading || !data));
	return (
		<AdminShell isAdmin={isAdmin}>
			<PageHeading
				title={adminCopy.nav.domains}
				intro={adminCopy.domains.intro}
				action={isAdmin && data && <Button variant="primary" icon={<PlusIcon size={16} />} onClick={openAdd}>{copy.add}</Button>}
			/>
			{loading ? (
				<div className="flex justify-center py-20"><Loader size="lg" /></div>
			) : !isAdmin ? (
				<Text>{peopleCopy.adminOnly}</Text>
			) : (<>
				<div className="rounded-2xl border border-kumo-line bg-kumo-base shadow-sm">
					<div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
						<FindBox list={list} label={copy.find} className="w-full max-w-sm" />
						<span className="text-sm text-kumo-subtle">{domains.length === 1 ? copy.countOne : fill(copy.count, { count: String(domains.length) })}</span>
					</div>
					{domains.length === 0 ? (
						<Empty icon={<GlobeIcon size={32} />} text={copy.intro} />
					) : (<>
						<div className="border-t border-kumo-line" />
						<Headings columns={COLUMNS} labels={[copy.columns.domain, copy.columns.mailboxes, copy.columns.records, copy.columns.kind]} />
						{list.shown.map((d, i) => {
							const bad = d.checks.filter((c) => c.status === "fix").map((c) => RECORD_NAMES[c.id] ?? c.id);
							const unknown = !bad.length && d.checks.some((c) => c.status === "unknown");
							return (
								<Row key={d.name} columns={COLUMNS} first={i === 0}>
									<div className="flex min-w-0 items-center gap-3">
										<span className={`inline-flex size-9 shrink-0 items-center justify-center rounded-full ${d.main ? "bg-sky-100 text-sky-800" : "bg-violet-100 text-violet-800"}`}>
											<GlobeIcon size={17} weight="bold" />
										</span>
										<span className="truncate text-base font-semibold text-kumo-default">{d.name}</span>
									</div>
									<div className="justify-self-end md:order-last">
										{d.removable && (
											<Menu label={fill(copy.menu, { domain: d.name })} items={[{ label: copy.remove, danger: true, onClick: () => setRemoving(d.name) }]} />
										)}
									</div>
									<Details>
										<span className="pl-12 text-base text-kumo-default md:pl-0">
											{d.mailboxes === 0 ? copy.noMailboxes : d.mailboxes === 1 ? copy.oneMailbox : fill(copy.mailboxes, { count: String(d.mailboxes) })}
										</span>
										<div>
											{bad.length > 0 ? (
												<Pill tone="amber" icon={<WarningCircleIcon size={14} weight="bold" />}>{fill(copy.recordsFix, { records: bad.join(", ") })}</Pill>
											) : unknown ? (
												<Pill tone="grey" icon={<QuestionIcon size={14} weight="bold" />}>{copy.recordsUnknown}</Pill>
											) : (
												<Pill tone="green" icon={<CheckCircleIcon size={14} weight="bold" />}>{copy.recordsOk}</Pill>
											)}
										</div>
										<div>
											<Pill tone={d.main ? "blue" : "violet"} title={d.main ? copy.kindHelp.main : copy.kindHelp.added}>{d.main ? copy.kind.main : copy.kind.added}</Pill>
										</div>
									</Details>
								</Row>
							);
						})}
						<ShowMoreButton list={list} className="mx-5 my-3" />
					</>)}
				</div>
				<p className="mt-3 text-sm text-kumo-subtle">{copy.setUpNote}</p>
			</>)}

			{adding && (
				<Dialog.Root open onOpenChange={(open) => { if (!open) setAdding(false); }}>
					<Dialog size="sm" className="p-6">
						<Dialog.Title className="mb-2 text-lg font-semibold">{copy.addTitle}</Dialog.Title>
						<Dialog.Description className="mb-4 text-base text-kumo-subtle">{copy.addHelp}</Dialog.Description>
						<form onSubmit={(e) => { e.preventDefault(); saveAdd(); }}>
							<Input aria-label={copy.addLabel} placeholder="example.com" value={names} onChange={(e) => setNames(e.target.value)} autoFocus />
							<div className="mt-5 flex justify-end gap-2">
								<Dialog.Close render={(props) => <Button {...props} type="button" variant="secondary">{copy.cancel}</Button>} />
								<Button type="submit" variant="primary" icon={<PlusIcon size={16} />} loading={add.isPending}>{copy.add}</Button>
							</div>
						</form>
					</Dialog>
				</Dialog.Root>
			)}

			{removing && (
				<Dialog.Root open onOpenChange={(open) => { if (!open) setRemoving(null); }}>
					<Dialog size="sm" className="p-6">
						<Dialog.Title className="mb-2 text-lg font-semibold">{fill(copy.removeTitle, { domain: removing })}</Dialog.Title>
						<Dialog.Description className="mb-5 break-words text-base text-kumo-subtle">{fill(copy.removeConfirm, { domain: removing })}</Dialog.Description>
						<div className="flex justify-end gap-2">
							<Dialog.Close render={(props) => <Button {...props} variant="secondary">{copy.cancel}</Button>} />
							<Button variant="destructive" loading={remove.isPending} onClick={() => remove.mutate(removing, {
								onSuccess: () => { toast.add({ title: fill(copy.removed, { domain: removing }) }); setRemoving(null); },
								onError: (err) => toast.add({ title: err instanceof Error && err.message ? err.message : copy.failed, variant: "error" }),
							})}>{copy.remove}</Button>
						</div>
					</Dialog>
				</Dialog.Root>
			)}
		</AdminShell>
	);
}
