// Mail App addition (not part of upstream Agentic Inbox).
// Admin > Backups (admins only): how every mailbox's backups stand on one page, with "Back up
// everything now" and, per mailbox, Back up now, Download latest, and links to restore or change its
// backup settings (in that mailbox's Settings › Backup). Downloading or restoring someone else's
// mailbox needs it opened first, which is logged. Wording in app/copy/admin.en-GB.json.

import { Button, Loader, Text, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, CheckCircleIcon, DatabaseIcon, LockSimpleIcon, WarningIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { formatSize } from "shared/attachments";
import { Details, Empty, Headings, Menu, Row } from "~/components/AdminTable";
import AdminShell, { Initial, PageHeading, Pill, mailboxTitle } from "~/components/AdminShell";
import { FindBox, ShowMoreButton, useShowMore } from "~/components/ShowMore";
import copy from "~/copy/admin.en-GB.json";
import peopleCopy from "~/copy/people.en-GB.json";
import { fill } from "~/lib/attachments";
import { queryKeys } from "~/queries/keys";
import { useMailboxes } from "~/queries/mailboxes";
import { useMe } from "~/queries/people";
import api, { type MailboxBackups } from "~/services/api";
import { pageTitle } from "~/lib/brand";

const t = copy.backups;
const COLUMNS = "md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_8rem_6rem_3rem]";
const DAY = 24 * 60 * 60 * 1000;
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function meta({ matches }: { matches: readonly unknown[] }) {
	return [{ title: pageTitle(matches, copy.nav.backups) }];
}

export default function BackupsRoute() {
	const { data: me } = useMe();
	const isAdmin = me?.role === "admin";
	const { data: mailboxes = [] } = useMailboxes();
	const { data, isLoading } = useQuery({
		queryKey: queryKeys.allBackups,
		queryFn: () => api.getAllBackups(),
		enabled: isAdmin,
		// While any backup is running, look again every few seconds.
		refetchInterval: (q) => (q.state.data?.mailboxes.some((m) => m.running) ? 4000 : false),
	});
	const qc = useQueryClient();
	const toast = useKumoToastManager();
	const navigate = useNavigate();
	const [busy, setBusy] = useState(false);
	const byId = useMemo(() => new Map(mailboxes.map((m) => [m.email.toLowerCase(), m])), [mailboxes]);
	const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.allBackups });

	const run = async (fn: () => Promise<unknown>, done: string) => {
		setBusy(true);
		try {
			await fn();
			toast.add({ title: done });
			await refresh();
		} catch (e) {
			toast.add({ title: e instanceof Error ? e.message : "Something went wrong", variant: "error" });
		} finally {
			setBusy(false);
		}
	};

	const rows = data?.mailboxes ?? [];
	const list = useShowMore(rows, { limit: 10, text: (r) => `${r.mailbox} ${byId.get(r.mailbox)?.name ?? ""}` });
	const stale = rows.filter((r) => !r.latest || Date.now() - new Date(r.latest.finished_at ?? r.latest.started_at).getTime() > DAY).length;

	return (
		<AdminShell isAdmin={isAdmin}>
			<PageHeading
				title={copy.nav.backups}
				intro={t.intro}
				action={isAdmin && rows.length > 0 && (
					<Button variant="primary" icon={<ArrowClockwiseIcon size={16} />} loading={busy} onClick={() => run(() => api.backUpAll(), fill(t.startedAll, { count: rows.length }))}>
						{t.backUpAll}
					</Button>
				)}
			/>
			{!me || (isAdmin && isLoading) ? (
				<div className="flex justify-center py-20"><Loader size="lg" /></div>
			) : !isAdmin ? (
				<Text>{peopleCopy.adminOnly}</Text>
			) : (<>
				{rows.length > 0 && (
					<div className={`mb-5 flex items-center gap-2.5 rounded-xl px-4 py-3 text-base ${stale ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-900"}`}>
						{stale ? <WarningIcon size={20} weight="fill" /> : <CheckCircleIcon size={20} weight="fill" />}
						<span><strong className="font-semibold">{t.statusLabel}:</strong> {stale === 0 ? t.summary.all : stale === 1 ? t.summary.one : fill(t.summary.some, { count: stale })}</span>
					</div>
				)}
				<div className="rounded-2xl border border-kumo-line bg-kumo-base shadow-sm">
					{rows.length === 0 ? (
						<Empty icon={<DatabaseIcon size={32} />} text={t.never} />
					) : (<>
						{list.canFind && (
							<div className="border-b border-kumo-line px-4 py-3 sm:px-5">
								<FindBox list={list} label={t.find} className="w-full max-w-sm" />
							</div>
						)}
						<Headings columns={COLUMNS} labels={[t.columns.mailbox, t.columns.latest, t.columns.size, t.columns.nightly]} />
						{list.shown.map((r, i) => {
							const mailbox = byId.get(r.mailbox);
							const title = mailbox ? mailboxTitle(mailbox) : r.mailbox;
							const settingsUrl = `/mailbox/${encodeURIComponent(r.mailbox)}/settings?tab=backup`;
							return (
								<Row key={r.mailbox} columns={COLUMNS} first={i === 0}>
									<div className="flex min-w-0 items-center gap-3.5">
										<Initial name={title} size={40} />
										<div className="min-w-0">
											<div className="truncate text-base font-semibold text-kumo-default">{title}</div>
											<div className="truncate text-sm text-kumo-subtle">{r.mailbox}</div>
										</div>
									</div>
									<div className="justify-self-end md:order-last">
										<Menu
											label={fill(t.menu, { mailbox: r.mailbox })}
											items={[
												{ label: t.backUp, onClick: () => run(() => api.backUpMailbox(r.mailbox), fill(t.started, { mailbox: r.mailbox })) },
												...(r.canOpen && r.latest ? [{ label: t.download, onClick: () => { window.location.href = api.backupDownloadUrl(r.mailbox, r.latest!.id); } }] : []),
												...(r.canOpen ? [
													{ label: t.restore, onClick: () => navigate(settingsUrl) },
													{ label: t.settings, onClick: () => navigate(settingsUrl) },
												] : [{ label: t.lockedShort, onClick: () => navigate("/") }]),
											]}
										/>
									</div>
									<Details>
										<div className="pl-[3.4rem] md:pl-0"><Latest row={r} /></div>
										<div className="text-base text-kumo-default">
											{r.latest ? <>{formatSize(r.latest.size)}<span className="block text-sm text-kumo-subtle">{r.latest.emails === 1 ? t.emailsOne : fill(t.emails, { count: r.latest.emails.toLocaleString("en-GB") })}</span></> : <span className="text-kumo-subtle">–</span>}
										</div>
										<div className="flex items-center gap-1.5">
											{r.settings?.nightly ? <Pill tone="green" dot>{t.on}</Pill> : <Pill tone="grey">{t.off}</Pill>}
											{!r.canOpen && <span title={t.locked} className="text-kumo-subtle"><LockSimpleIcon size={15} /></span>}
										</div>
									</Details>
								</Row>
							);
						})}
						<ShowMoreButton list={list} className="mx-5 my-3" />
					</>)}
				</div>
				{rows.some((r) => !r.canOpen) && <p className="mt-3 text-sm text-kumo-subtle">{t.locked}</p>}
			</>)}
		</AdminShell>
	);
}

function Latest({ row }: { row: MailboxBackups }) {
	if (row.running) {
		return <Pill tone="blue" dot>{fill(t.running, { done: row.running.emails.toLocaleString("en-GB"), total: row.running.total.toLocaleString("en-GB") })}</Pill>;
	}
	if (!row.latest) {
		return row.failed ? <Pill tone="red" dot title={row.failed.error ?? undefined}>{t.failed}</Pill> : <span className="text-base text-kumo-subtle">{t.never}</span>;
	}
	const done = row.latest.finished_at ?? row.latest.started_at;
	const old = Date.now() - new Date(done).getTime() > DAY;
	return (
		<div className="min-w-0">
			<div className={`text-base ${old ? "text-amber-800" : "text-kumo-default"}`}>{when(done)}</div>
			<div className="text-sm text-kumo-subtle">
				{row.failed ? <span className="text-kumo-danger">{t.failed}</span> : fill(t.copies, { count: row.count })}
			</div>
		</div>
	);
}
