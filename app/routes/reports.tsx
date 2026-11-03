// Mail App addition (not part of upstream Agentic Inbox).
// Admin > Reports (admins only): email in and out, spam, storage and who opened what, over the last 7, 30
// or 90 days, with a CSV download, and Find an email (what happened to mail to or from an address, and
// open it: straight away in the admin's own mailboxes, otherwise with the logged "Open and log it"). The sums come from shared/reports.ts; each mailbox's tally is kept in
// workers/durableObject/stats.ts. Wording in app/copy/admin.en-GB.json.
import { Button, Dialog, Loader, Text, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowLeftIcon, ChartBarIcon, DownloadSimpleIcon, EnvelopeOpenIcon, InfoIcon, LockSimpleIcon, MagnifyingGlassIcon, WarningIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import {
	MIN_FIND, REPORT_DAYS, cleanFind, isProblem, type FindAnswer, type FoundEmail, SPAM_WHYS, dayList, formatBytes, hasEstimates, mailboxDays, reportCsv, spamReasons, storageCost, storageTotals,
	sumDays, topSpamSenders, total, type DayTotals, type ReportsAnswer,
} from "shared/reports";
import AdminShell, { PageHeading, Pill, type Tone } from "~/components/AdminShell";
import copy from "~/copy/admin.en-GB.json";
import peopleCopy from "~/copy/people.en-GB.json";
import spamCopy from "~/copy/spam-reasons.en-GB.json";
import { fill } from "~/lib/attachments";
import { pageTitle } from "~/lib/brand";
import { queryKeys } from "~/queries/keys";
import { useMe } from "~/queries/people";
import api from "~/services/api";

const t = copy.reports;
const f = t.find;
type Tab = keyof typeof t.tabs;
const TABS = Object.keys(t.tabs) as Tab[];

export function meta({ matches }: { matches: readonly unknown[] }) {
	return [{ title: pageTitle(matches, copy.nav.reports) }];
}

const num = (n: number) => n.toLocaleString("en-GB");
const shortDate = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const longDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function download(answer: ReportsAnswer) {
	const url = URL.createObjectURL(new Blob([reportCsv(answer)], { type: "text/csv;charset=utf-8" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = fill(t.downloadName, { from: answer.from, to: answer.to });
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ReportsRoute() {
	const { data: me } = useMe();
	const isAdmin = me?.role === "admin";
	const [days, setDays] = useState<number>(30);
	const [tab, setTab] = useState<Tab>("email");
	const [typed, setTyped] = useState("");
	const [search, setSearch] = useState("");
	const [tooShort, setTooShort] = useState(false);
	const { data, isLoading, isError } = useQuery({
		queryKey: ["reports", days],
		queryFn: () => api.getReports(days),
		enabled: isAdmin && !search,
		staleTime: 60_000,
	});
	const found = useQuery({
		queryKey: ["reports-find", search, days],
		queryFn: () => api.findInReports(search, days),
		enabled: isAdmin && !!search,
		staleTime: 30_000,
	});
	const find = (e: FormEvent) => {
		e.preventDefault();
		const q = cleanFind(typed);
		setTooShort(q.length > 0 && q.length < MIN_FIND);
		if (q.length >= MIN_FIND) setSearch(q);
		if (!q) setSearch("");
	};
	const clear = () => { setTyped(""); setSearch(""); setTooShort(false); };

	return (
		<AdminShell isAdmin={isAdmin}>
			<PageHeading
				title={copy.nav.reports}
				intro={t.intro}
				action={isAdmin && data && !search ? <Button variant="secondary" icon={<DownloadSimpleIcon size={16} />} onClick={() => download(data)}>{t.download}</Button> : undefined}
			/>
			{!me ? (
				<div className="flex justify-center py-20"><Loader size="lg" /></div>
			) : !isAdmin ? (
				<Text>{peopleCopy.adminOnly}</Text>
			) : (
				<>
					<form role="search" onSubmit={find} className="mb-4 flex gap-2">
						<div className="relative min-w-0 flex-1">
							<MagnifyingGlassIcon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-subtle" />
							<input
								type="search"
								value={typed}
								onChange={(e) => { setTyped(e.target.value); if (!e.target.value) clear(); }}
								placeholder={f.placeholder}
								aria-label={f.label}
								className="w-full rounded-lg border border-kumo-line bg-kumo-base py-2 pl-9 pr-3 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring"
							/>
						</div>
						<Button type="submit" variant="primary" icon={<MagnifyingGlassIcon size={16} />}>{f.button}</Button>
					</form>
					{tooShort && <p className="-mt-2 mb-4 text-sm text-kumo-warning">{f.tooShort}</p>}
					<div className="mb-5 flex flex-wrap items-center gap-2">
						{search ? (
							<Button variant="secondary" icon={<ArrowLeftIcon size={16} />} onClick={clear}>{f.clear}</Button>
						) : <div role="tablist" aria-label={copy.nav.reports} className="flex flex-wrap gap-1.5">
							{TABS.map((k) => (
								<button
									key={k}
									type="button"
									role="tab"
									aria-selected={tab === k}
									onClick={() => setTab(k)}
									className={`rounded-full px-4 py-1.5 text-sm ${tab === k ? "bg-[rgba(var(--brand-rgb),0.1)] font-semibold text-[var(--brand-ink)]" : "border border-kumo-line bg-kumo-base text-kumo-default hover:bg-kumo-tint"}`}
								>
									{t.tabs[k]}
								</button>
							))}
						</div>}
						<label className="ml-auto flex items-center gap-2 text-sm text-kumo-subtle">
							{t.period}
							<select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default">
								{REPORT_DAYS.map((d) => <option key={d} value={d}>{fill(t.lastDays, { days: d })}</option>)}
							</select>
						</label>
					</div>
					{search ? (
						found.isLoading ? (
							<div className="flex justify-center py-20"><Loader size="lg" /></div>
						) : found.isError || !found.data ? (
							<Text>{f.failed}</Text>
						) : (
							<FindResults answer={found.data} />
						)
					) : isLoading ? (
						<div className="flex justify-center py-20"><Loader size="lg" /></div>
					) : isError || !data ? (
						<Text>{t.failed}</Text>
					) : (
						<ReportBody answer={data} tab={tab} />
					)}
				</>
			)}
		</AdminShell>
	);
}

function ReportBody({ answer, tab }: { answer: ReportsAnswer; tab: Tab }) {
	const days = useMemo(() => dayList(answer.days, Date.parse(`${answer.to}T12:00:00Z`)), [answer]);
	const perMailbox = useMemo(() => answer.mailboxes.map((m) => ({ m, map: mailboxDays(m, days) })), [answer, days]);
	const series = useMemo(() => sumDays(perMailbox.map((p) => p.map), days), [perMailbox, days]);
	const estimatedSince = hasEstimates(answer.mailboxes, answer.from)
		? answer.mailboxes.map((m) => m.countingSince).sort().reverse()[0]
		: null;

	return (
		<div className="space-y-5">
			{answer.unreadable.length > 0 && (
				<Note icon={<WarningIcon size={16} weight="fill" className="text-kumo-warning" />}>{fill(t.unreadable, { mailboxes: answer.unreadable.join(", ") })}</Note>
			)}
			{tab === "email" && <EmailTab answer={answer} series={series} perMailbox={perMailbox} estimatedSince={estimatedSince} />}
			{tab === "spam" && <SpamTab answer={answer} days={days} series={series} estimatedSince={estimatedSince} />}
			{tab === "storage" && <StorageTab answer={answer} />}
			{tab === "activity" && <ActivityTab answer={answer} />}
		</div>
	);
}

// ── Find an email ─────────────────────────────────────────────────

const STATUS_TONE: Record<FoundEmail["status"], Tone> = { delivered: "green", sent: "green", scheduled: "blue", bin: "grey", spam: "amber", failed: "red" };

function FindResults({ answer }: { answer: FindAnswer }) {
	const [problemsOnly, setProblemsOnly] = useState(false);
	const navigate = useNavigate();
	const qc = useQueryClient();
	const toastManager = useKumoToastManager();
	// Mail App: someone else's mailbox opens through the same logged step as on Mailboxes.
	const [toOpen, setToOpen] = useState<FoundEmail | null>(null);
	const [opening, setOpening] = useState(false);
	const go = (e: FoundEmail) => {
		const box = answer.mailboxes[e.mailbox];
		if (box && e.id && e.folderId) navigate(`/mailbox/${encodeURIComponent(box.id)}/emails/${encodeURIComponent(e.folderId)}`, { state: { openEmail: e.id } });
	};
	const open = (e: FoundEmail) => (answer.mailboxes[e.mailbox]?.canOpen ? go(e) : setToOpen(e));
	const openLogged = async () => {
		if (!toOpen) return;
		setOpening(true);
		try {
			await api.setAdminAccess(toOpen.mailbox, true);
			await qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
			await qc.invalidateQueries({ queryKey: queryKeys.me });
			go(toOpen);
		} catch (err) {
			toastManager.add({ title: err instanceof Error ? err.message : "Something went wrong", variant: "error" });
		} finally {
			setOpening(false);
		}
	};
	const people = toOpen ? answer.mailboxes[toOpen.mailbox]?.people ?? [] : [];
	const problems = answer.found.filter(isProblem).length;
	const shown = problemsOnly ? answer.found.filter(isProblem) : answer.found;
	return (
		<div className="space-y-5">
			{answer.unreadable.length > 0 && (
				<Note icon={<WarningIcon size={16} weight="fill" className="text-kumo-warning" />}>{fill(t.unreadable, { mailboxes: answer.unreadable.join(", ") })}</Note>
			)}
			<Card title={fill(f.title, { q: answer.q })} intro={fill(f.intro, { days: answer.days })}>
				{answer.found.length === 0 ? (
					<div className="space-y-2">
						<Text>{fill(f.none, { days: answer.days })}</Text>
						<p className="text-sm text-kumo-subtle">{f.noneHelp}</p>
					</div>
				) : (
					<>
						<div className="mb-3 flex flex-wrap items-center gap-2">
							<span className="text-sm text-kumo-default">
								{answer.found.length === 1 ? f.countOne : fill(f.count, { count: num(answer.found.length) })}
								{problems > 0 && <span className="text-kumo-subtle"> · {problems === 1 ? f.problemCountOne : fill(f.problemCount, { count: num(problems) })}</span>}
							</span>
							<div role="group" aria-label={f.problemsOnly} className="ml-auto flex gap-1.5">
								{[false, true].map((only) => (
									<button
										key={String(only)}
										type="button"
										aria-pressed={problemsOnly === only}
										onClick={() => setProblemsOnly(only)}
										className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm ${problemsOnly === only ? "bg-[rgba(var(--brand-rgb),0.1)] font-semibold text-[var(--brand-ink)]" : "border border-kumo-line bg-kumo-base text-kumo-default hover:bg-kumo-tint"}`}
									>
										{only ? <WarningIcon size={14} /> : <MagnifyingGlassIcon size={14} />}
										{only ? f.problemsOnly : f.all}
									</button>
								))}
							</div>
						</div>
						{shown.length === 0 ? <Text>{f.noProblems}</Text> : (
							<ul className="divide-y divide-kumo-line border-t border-kumo-line">
								{shown.map((e, i) => <FoundRow key={`${e.at}-${e.mailbox}-${i}`} e={e} locked={answer.mailboxes[e.mailbox]?.canOpen === false} onOpen={() => open(e)} />)}
							</ul>
						)}
						{answer.more && <p className="mt-3 text-xs text-kumo-subtle">{fill(f.more, { count: num(answer.found.length) })}</p>}
					</>
				)}
			</Card>
			<Dialog.Root open={!!toOpen} onOpenChange={(o) => { if (!o) setToOpen(null); }}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="mb-2 break-all text-base font-semibold">{fill(peopleCopy.open.title, { mailbox: toOpen?.mailbox ?? "" })}</Dialog.Title>
					<Dialog.Description className="mb-5 text-sm text-kumo-subtle">
						{people.length ? fill(peopleCopy.open.body, { people: people.join(", ") }) : peopleCopy.open.bodyUnused}
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close render={(props) => <Button {...props} variant="secondary" size="sm">{peopleCopy.form.cancel}</Button>} />
						<Button variant="primary" size="sm" icon={<LockSimpleIcon size={16} />} loading={opening} onClick={openLogged}>{peopleCopy.open.confirm}</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}

/** Why one email went to Spam, in the same words its user sees on it. */
function spamLines(e: FoundEmail): string[] {
	const domain = e.from.split("@")[1] ?? e.from;
	const words = spamCopy as Record<string, string>;
	return (e.why ?? []).filter((r) => r.check in words && !["title", "notSpam"].includes(r.check))
		.map((r) => words[r.check]!.replaceAll("{domain}", domain).replaceAll("{detail}", r.detail ?? domain));
}

function FoundRow({ e, locked, onOpen }: { e: FoundEmail; locked: boolean; onOpen: () => void }) {
	const label = e.status === "delivered" && e.folder ? fill(f.deliveredTo, { folder: e.folder }) : f.status[e.status];
	const why = e.status === "spam" ? spamLines(e) : [];
	return (
		<li className="py-3 text-sm">
			<div className="flex flex-wrap items-center gap-2">
				<Pill tone={STATUS_TONE[e.status]} dot>{label}</Pill>
				<span className="ml-auto tabular-nums text-kumo-subtle">{when(e.at)}</span>
				{e.id && (
					<Button variant="secondary" size="sm" icon={locked ? <LockSimpleIcon size={14} /> : <EnvelopeOpenIcon size={14} />} onClick={onOpen} title={locked ? f.openLockedHelp : undefined}>
						{locked ? f.openLocked : f.open}
					</Button>
				)}
			</div>
			{e.status !== "failed" && <div className="mt-1.5 font-medium text-kumo-default [overflow-wrap:anywhere]">{e.subject || f.noSubject}</div>}
			<div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-kumo-subtle [overflow-wrap:anywhere]">
				<span><span className="font-medium text-kumo-default">{f.from}</span> {e.from}</span>
				<span><span className="font-medium text-kumo-default">{f.to}</span> {e.to}</span>
				<span><span className="font-medium text-kumo-default">{f.in}</span> {e.mailbox}</span>
			</div>
			{e.status === "failed" && e.error && <p className="mt-1.5 text-red-700 dark:text-red-300">{e.error}</p>}
			{e.status === "spam" && (why.length ? (
				<ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-kumo-default">{why.map((l) => <li key={l}>{l}</li>)}</ul>
			) : <p className="mt-1.5 text-kumo-subtle">{f.spamWhyUnknown}</p>)}
			{e.status === "bin" && <p className="mt-1.5 text-kumo-subtle">{f.binHelp}</p>}
		</li>
	);
}

// ── Email ─────────────────────────────────────────────────────────

function EmailTab({ answer, series, perMailbox, estimatedSince }: {
	answer: ReportsAnswer;
	series: { day: string; totals: DayTotals }[];
	perMailbox: { m: ReportsAnswer["mailboxes"][number]; map: Map<string, DayTotals> }[];
	estimatedSince: string | null;
}) {
	const sums = total(series);
	const rows = perMailbox
		.map(({ m, map }) => ({ m, totals: total([...map.values()].map((totals) => ({ totals }))) }))
		.sort((a, b) => b.totals.received + b.totals.sent - (a.totals.received + a.totals.sent));
	return (
		<>
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<Stat label={t.received} value={sums.received} />
				<Stat label={t.sent} value={sums.sent} />
				<Stat label={t.failedSends} value={sums.failed} tone={sums.failed ? "warn" : undefined} />
				<Stat label={t.spam} value={sums.spam} note={sums.received ? fill(t.spamShare, { percent: Math.round((sums.spam / sums.received) * 100) }) : undefined} />
			</div>
			<Card title={t.perDay}>
				<BarChart series={series} keys={["received", "sent"]} />
			</Card>
			{estimatedSince && <Note icon={<InfoIcon size={16} className="text-kumo-subtle" />}>{fill(t.estimated, { date: longDate(`${estimatedSince}T12:00:00Z`) })}</Note>}
			<Card>
				{rows.length === 0 ? <Text>{t.noMail}</Text> : (
					<Table
						head={[t.mailbox, t.received, t.sent, t.failedSends, t.spam]}
						rows={rows.map(({ m, totals }) => [
							<span key="m" className="flex flex-wrap items-center gap-2">{m.mailbox}{m.shared && <Pill>{t.shared}</Pill>}</span>,
							num(totals.received), num(totals.sent), num(totals.failed), num(totals.spam),
						])}
						foot={[t.total, num(sums.received), num(sums.sent), num(sums.failed), num(sums.spam)]}
					/>
				)}
			</Card>
			<FailuresCard answer={answer} />
		</>
	);
}

function FailuresCard({ answer }: { answer: ReportsAnswer }) {
	const failures = answer.mailboxes
		.flatMap((m) => m.failures.map((f) => ({ ...f, from: m.mailbox })))
		.sort((a, b) => b.at.localeCompare(a.at))
		.slice(0, 20);
	if (!failures.length) return null;
	return (
		<Card title={t.failuresTitle} intro={t.failuresIntro}>
			<Table head={[t.failureWhen, t.from, t.failureTo, t.failureWhy]} rows={failures.map((f) => [when(f.at), f.from, f.to, f.error])} numeric={false} />
		</Card>
	);
}

// ── Spam ──────────────────────────────────────────────────────────

function SpamTab({ answer, days, series, estimatedSince }: { answer: ReportsAnswer; days: string[]; series: { day: string; totals: DayTotals }[]; estimatedSince: string | null }) {
	const sums = total(series);
	const { why, notSpam } = spamReasons(answer.mailboxes, days);
	const counted = SPAM_WHYS.reduce((s, w) => s + why[w], 0);
	const senders = topSpamSenders(answer.mailboxes);
	return (
		<>
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<Stat label={t.spam} value={sums.spam} note={sums.received ? fill(t.spamShare, { percent: Math.round((sums.spam / sums.received) * 100) }) : undefined} />
				<Stat label={t.received} value={sums.received} />
			</div>
			<Card title={t.perDay}>
				<BarChart series={series} keys={["spam"]} />
			</Card>
			<div className="grid gap-5 lg:grid-cols-2">
				<Card title={t.spamWhyTitle}>
					{counted === 0 ? <Text>{t.spamWhyNone}</Text> : (
						<ul className="space-y-3">
							{SPAM_WHYS.map((w) => (
								<li key={w}>
									<div className="mb-1 flex justify-between gap-3 text-sm text-kumo-default"><span>{t.spamWhy[w]}</span><span className="tabular-nums font-semibold">{num(why[w])}</span></div>
									<div className="h-2 rounded-full bg-kumo-tint"><div className="h-2 rounded-full bg-[var(--brand)]" style={{ width: `${counted ? (why[w] / counted) * 100 : 0}%` }} /></div>
								</li>
							))}
						</ul>
					)}
					{estimatedSince && <p className="mt-4 text-xs text-kumo-subtle">{t.spamWhyNote}</p>}
					{notSpam > 0 && <p className="mt-4 text-sm text-kumo-default">{notSpam === 1 ? t.notSpamOne : fill(t.notSpam, { count: num(notSpam) })}</p>}
				</Card>
				<Card title={t.topSenders}>
					{senders.length === 0 ? <Text>{t.spamWhyNone}</Text> : (
						<Table head={[t.from, t.emails]} rows={senders.map((s) => [s.sender, num(s.count)])} />
					)}
				</Card>
			</div>
		</>
	);
}

// ── Storage ───────────────────────────────────────────────────────

function StorageTab({ answer }: { answer: ReportsAnswer }) {
	const totals = storageTotals(answer.mailboxes);
	const all = totals.database + totals.attachments + totals.files + totals.backups;
	const cost = storageCost(totals);
	const rows = [...answer.mailboxes].sort((a, b) => sizeOf(b) - sizeOf(a));
	return (
		<>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div className="rounded-xl border border-kumo-line bg-kumo-base p-4">
					<div className="text-sm text-kumo-subtle">{t.storageTotal}</div>
					<div className="text-3xl font-bold tabular-nums text-kumo-default">{formatBytes(all)}</div>
				</div>
				<div className="rounded-xl border border-kumo-line bg-kumo-base p-4">
					<div className="text-sm text-kumo-subtle">{t.storageCost}</div>
					<div className="text-3xl font-bold text-kumo-default">{cost.dollars ? fill(t.storageDollars, { dollars: cost.dollars }) : t.storageFree}</div>
					<div className="mt-1 text-xs text-kumo-subtle">{cost.dollars ? t.storageDollarsNote : t.storageFreeNote}</div>
				</div>
			</div>
			<Card>
				<Table
					head={[t.mailbox, t.storageEmail, t.storageAttachments, t.storageFiles, t.storageBackups, t.storageAll]}
					rows={rows.map((m) => [m.mailbox, formatBytes(m.storage.database), formatBytes(m.storage.attachments), formatBytes(m.storage.files), formatBytes(m.storage.backups), formatBytes(sizeOf(m))])}
					foot={[t.total, formatBytes(totals.database), formatBytes(totals.attachments), formatBytes(totals.files), formatBytes(totals.backups), formatBytes(all)]}
				/>
				<p className="mt-4 text-xs text-kumo-subtle">{t.storageNote}</p>
			</Card>
		</>
	);
}

const sizeOf = (m: ReportsAnswer["mailboxes"][number]) => m.storage.database + m.storage.attachments + m.storage.files + m.storage.backups;

// ── Activity ──────────────────────────────────────────────────────

function ActivityTab({ answer }: { answer: ReportsAnswer }) {
	const people = [...answer.people].sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "") || a.email.localeCompare(b.email));
	const nameOf = (email: string) => answer.people.find((p) => p.email === email)?.name || email;
	return (
		<>
			<Card title={t.people}>
				<Table
					numeric={false}
					head={[t.people, t.lastSeen]}
					rows={people.map((p) => [
						<span key="p" className="flex flex-wrap items-center gap-2">
							<span className="font-medium">{p.name || p.email}</span>
							<span className="text-kumo-subtle">{p.name ? p.email : ""}</span>
							{p.role === "admin" && <Pill tone="violet">{t.role.admin}</Pill>}
							{p.status !== "active" && <Pill tone={p.status === "suspended" ? "red" : "amber"}>{t.status[p.status as keyof typeof t.status] ?? p.status}</Pill>}
						</span>,
						p.lastSeenAt ? when(p.lastSeenAt) : t.never,
					])}
				/>
			</Card>
			<Card title={t.logTitle} intro={t.logIntro}>
				{answer.log.length === 0 ? <Text>{t.logNone}</Text> : (
					<ul className="divide-y divide-kumo-line">
						{answer.log.map((l, i) => (
							<li key={`${l.at}-${i}`} className="flex flex-wrap justify-between gap-2 py-2.5 text-sm">
								<span className="text-kumo-default">{fill(t.logAction[l.action], { by: nameOf(l.by), who: l.who ? nameOf(l.who) : "", mailbox: l.mailbox })}</span>
								<span className="tabular-nums text-kumo-subtle">{when(l.at)}</span>
							</li>
						))}
					</ul>
				)}
			</Card>
		</>
	);
}

// ── Pieces ────────────────────────────────────────────────────────

function Card({ title, intro, children }: { title?: string; intro?: string; children: ReactNode }) {
	return (
		<section className="rounded-2xl border border-kumo-line bg-kumo-base p-5 shadow-sm sm:p-6">
			{title && (
				<div className="mb-4 flex items-center gap-2">
					<ChartBarIcon size={18} weight="duotone" className="text-kumo-subtle" />
					<h2 className="text-base font-semibold text-kumo-default">{title}</h2>
				</div>
			)}
			{intro && <p className="-mt-2 mb-4 text-sm text-kumo-subtle">{intro}</p>}
			{children}
		</section>
	);
}

function Stat({ label, value, note, tone }: { label: string; value: number; note?: string; tone?: "warn" }) {
	return (
		<div className="rounded-xl border border-kumo-line bg-kumo-base p-4">
			<div className="text-sm text-kumo-subtle">{label}</div>
			<div className={`text-3xl font-bold tabular-nums ${tone === "warn" ? "text-kumo-warning" : "text-kumo-default"}`}>{num(value)}</div>
			{note && <div className="mt-0.5 text-xs text-kumo-subtle">{note}</div>}
		</div>
	);
}

function Note({ icon, children }: { icon: ReactNode; children: ReactNode }) {
	return (
		<p className="flex items-start gap-2 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default">
			<span className="mt-0.5 shrink-0">{icon}</span>
			<span>{children}</span>
		</p>
	);
}

function Table({ head, rows, foot, numeric = true }: { head: string[]; rows: ReactNode[][]; foot?: ReactNode[]; numeric?: boolean }) {
	const align = (i: number) => (numeric && i > 0 ? "text-right tabular-nums" : "text-left");
	return (
		<div className="-mx-1 overflow-x-auto">
			<table className={`w-full border-collapse text-sm ${head.length > 3 ? "min-w-[32rem]" : ""}`}>
				<thead>
					<tr>{head.map((h, i) => <th key={h} className={`border-b border-kumo-line px-2 py-2 text-xs font-semibold text-kumo-subtle ${align(i)}`}>{h}</th>)}</tr>
				</thead>
				<tbody>
					{rows.map((r, j) => (
						<tr key={j}>{r.map((c, i) => <td key={i} className={`border-b border-kumo-line px-2 py-2.5 text-kumo-default ${align(i)} ${i === 0 ? "break-all" : ""}`}>{c}</td>)}</tr>
					))}
				</tbody>
				{foot && (
					<tfoot>
						<tr>{foot.map((c, i) => <td key={i} className={`px-2 py-2.5 font-semibold text-kumo-default ${align(i)}`}>{c}</td>)}</tr>
					</tfoot>
				)}
			</table>
		</div>
	);
}

/** Bars for each day, side by side for each figure. Drawn to one scale, with its top value marked. */
function BarChart({ series, keys }: { series: { day: string; totals: DayTotals }[]; keys: (keyof DayTotals)[] }) {
	const max = Math.max(1, ...series.flatMap((s) => keys.map((k) => s.totals[k])));
	const top = niceTop(max);
	const W = 640, H = 170, left = 40, bottom = 150, height = 130;
	const slot = (W - left - 4) / series.length;
	const bar = Math.max(1, (slot * 0.84) / keys.length);
	const fills = ["var(--brand)", "#94a3b8"];
	const label = (i: number) => series[i] && <text key={i} x={left + i * slot + slot / 2} y={166} textAnchor={i === 0 ? "start" : i === series.length - 1 ? "end" : "middle"} className="fill-kumo-subtle text-[10px]">{shortDate(series[i]!.day)}</text>;
	return (
		<div>
			<div className="mb-2 flex gap-4 text-xs text-kumo-subtle">
				{keys.map((k, i) => (
					<span key={k} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: fills[i] }} />{k === "received" ? t.received : k === "sent" ? t.sent : k === "spam" ? t.spam : t.failedSends}</span>
				))}
			</div>
			<svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={t.perDay}>
				{(top % 2 ? [0, 1] : [0, 0.5, 1]).map((f) => (
					<g key={f}>
						<line x1={left} x2={W} y1={bottom - f * height} y2={bottom - f * height} className="stroke-kumo-line" strokeWidth={1} />
						<text x={left - 6} y={bottom - f * height + 3} textAnchor="end" className="fill-kumo-subtle text-[10px]">{num(Math.round(top * f))}</text>
					</g>
				))}
				{series.map((s, i) => keys.map((k, j) => {
					const h = (s.totals[k] / top) * height;
					return <rect key={`${s.day}-${k}`} x={left + i * slot + slot * 0.08 + j * bar} y={bottom - h} width={Math.max(1, bar - 1)} height={h} rx={1.5} fill={fills[j]}><title>{`${shortDate(s.day)}: ${num(s.totals[k])}`}</title></rect>;
				}))}
				{label(0)}
				{series.length > 2 && label(Math.floor((series.length - 1) / 2))}
				{label(series.length - 1)}
			</svg>
		</div>
	);
}

/** A round number at or just above `n`, for the top of the chart. */
function niceTop(n: number): number {
	const step = 10 ** Math.floor(Math.log10(n));
	for (const m of [1, 2, 4, 5, 6, 8, 10]) if (m * step >= n) return m * step;
	return 10 * step;
}
