// Mail App addition (not part of upstream Agentic Inbox).
// Smaller pieces of the calendar page: the list of calendars, the calendar window, the
// "This event / This and following / All events" question for repeating events, the small month,
// the mailbox picker, the share window and the subscribe link.

import { Button, Dialog, Input } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, CalendarPlusIcon, CaretLeftIcon, CaretRightIcon, CheckIcon, CopyIcon, DownloadSimpleIcon, LinkSimpleIcon, PencilSimpleIcon, PlusIcon, PowerIcon, UploadSimpleIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { useNavigate } from "react-router";
import { useMailboxes } from "~/queries/mailboxes";
import { type FormEvent, useEffect, useState } from "react";
import { MAX_CALENDAR_NAME, type Calendar, type CalendarColor, type EditScope } from "shared/calendar";
import { EVERYONE, type ShareLevel } from "shared/calendar-shares";
import type { FeedLevel } from "shared/calendar-feeds";
import { BANK_HOLIDAYS, refreshedWords } from "shared/outside-calendars";
import { problemOf, useCalendarFeed, useImportCalendar, useRefreshCalendar, useSaveCalendarFeed } from "~/queries/calendar";
import type { SharedCalendar } from "~/services/api";
import { LABEL_COLORS, LABEL_COLOR_KEYS, nextLabelColor } from "shared/labels";
import { ShowMoreButton, useShowMore } from "~/components/ShowMore";
import copy from "~/copy/calendar.en-GB.json";
import listCopy from "~/copy/lists.en-GB.json";

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? "");

function CalendarToggle({ cal, shown, onToggle }: { cal: Calendar; shown: boolean; onToggle: () => void }) {
	const c = LABEL_COLORS[cal.color] ?? LABEL_COLORS.blue;
	return (
		<button type="button" onClick={onToggle} aria-pressed={shown} aria-label={fill(copy.showHide, { name: cal.name })}
			className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-2"
			style={{ borderColor: c.dot, backgroundColor: shown ? c.dot : "transparent", color: c.ink }}>
			{shown && <CheckIcon size={14} weight="bold" />}
		</button>
	);
}

export function CalendarList({ calendars, hidden, onToggle, onEdit, onNew, onNewFromLink, onImport, onShare, shareCounts = {}, shared = [], exportUrl }: {
	calendars: Calendar[];
	hidden: Set<string>;
	onToggle: (id: string) => void;
	onEdit: (cal: Calendar) => void;
	onNew: () => void;
	onNewFromLink: () => void;
	onImport: () => void;
	onShare: (cal: Calendar) => void;
	shareCounts?: Record<string, number>;
	/** Calendars other people have shared with you. */
	shared?: SharedCalendar[];
	exportUrl: string;
}) {
	const list = useShowMore(calendars, { limit: 8 });
	return (
		<div className="space-y-1">
			<div className="flex items-center justify-between px-1">
				<h2 className="text-sm font-semibold uppercase tracking-wide text-kumo-strong">{copy.calendars}</h2>
				<Button variant="ghost" shape="square" size="sm" icon={<PlusIcon size={16} />} aria-label={copy.newCalendar} onClick={onNew} />
			</div>
			{list.shown.map((cal) => {
				const count = shareCounts[cal.id] ?? 0;
				const sharedWords = count === 1 ? copy.sharedWithOne : fill(copy.sharedWithN, { n: String(count) });
				return (
					<div key={cal.id} className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-kumo-tint">
						<CalendarToggle cal={cal} shown={!hidden.has(cal.id)} onToggle={() => onToggle(cal.id)} />
						{cal.sourceUrl ? (
							<span className="min-w-0 flex-1">
								<span className="block truncate text-base text-kumo-default">{cal.name}</span>
								<span className={`flex items-center gap-1 truncate text-xs ${cal.refreshError ? "text-kumo-danger" : "text-kumo-strong"}`}>
									<LinkSimpleIcon size={12} /> {cal.refreshError ? fill(copy.outsideProblem, { problem: "" }).replace(/:\s*$/, "") : copy.outsideFrom}
								</span>
							</span>
						) : (
							<span className="min-w-0 flex-1 truncate text-base text-kumo-default">{cal.name}</span>
						)}
						{!cal.sourceUrl && <Button variant="ghost" shape="square" size="xs" icon={<UsersThreeIcon size={14} weight={count ? "fill" : "regular"} />}
							aria-label={`${copy.shareCalendar}: ${cal.name}${count ? `. ${sharedWords}` : ""}`} title={count ? sharedWords : copy.shareCalendar}
							onClick={() => onShare(cal)} className={count ? "text-kumo-brand" : "opacity-60 group-hover:opacity-100"} />}
						<Button variant="ghost" shape="square" size="xs" icon={<PencilSimpleIcon size={14} />} aria-label={`${copy.editCalendar}: ${cal.name}`} onClick={() => onEdit(cal)} className="opacity-60 group-hover:opacity-100" />
					</div>
				);
			})}
			<ShowMoreButton list={list} showAll={listCopy.showAllCalendars} className="px-1 py-1" />
			{shared.length > 0 && (
				<>
					<h2 className="px-1 pt-3 text-sm font-semibold uppercase tracking-wide text-kumo-strong">{copy.sharedWithMe}</h2>
					{shared.map((cal) => (
						<div key={`${cal.owner}|${cal.id}`} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-kumo-tint">
							<CalendarToggle cal={cal} shown={!hidden.has(cal.id)} onToggle={() => onToggle(cal.id)} />
							<span className="min-w-0 flex-1">
								<span className="block truncate text-base text-kumo-default">{cal.name}</span>
								<span className="block truncate text-xs text-kumo-strong">{fill(copy.sharedFrom, { owner: cal.ownerName })} · {copy.levels[cal.level]}</span>
							</span>
						</div>
					))}
				</>
			)}
			<button type="button" onClick={onNewFromLink} className="mt-2 flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm text-kumo-strong hover:bg-kumo-tint">
				<LinkSimpleIcon size={16} /> {copy.outsideAdd}
			</button>
			<button type="button" onClick={onImport} className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm text-kumo-strong hover:bg-kumo-tint">
				<UploadSimpleIcon size={16} /> {copy.import}
			</button>
			<a href={exportUrl} download className="flex items-center gap-2 rounded-md px-1 py-1.5 text-sm text-kumo-strong no-underline hover:bg-kumo-tint" title={copy.downloadHint}>
				<DownloadSimpleIcon size={16} /> {copy.download}
			</a>
		</div>
	);
}

export function CalendarDialog({ mailboxId, calendar, calendars, open, fromLink = false, onClose, onSave, onDelete, busy, error }: {
	mailboxId: string | undefined;
	calendar: Calendar | null;
	calendars: Calendar[];
	open: boolean;
	/** Adding a calendar from another website's link (a new calendar only). */
	fromLink?: boolean;
	onClose: () => void;
	onSave: (name: string, color: CalendarColor, sourceUrl?: string) => void;
	onDelete: () => void;
	busy: boolean;
	error: string;
}) {
	const [name, setName] = useState("");
	const [color, setColor] = useState<CalendarColor>("blue");
	const [confirm, setConfirm] = useState(false);
	const [link, setLink] = useState("");
	const refresh = useRefreshCalendar(mailboxId);
	useEffect(() => {
		if (!open) return;
		setName(calendar?.name ?? "");
		setColor(calendar?.color ?? nextLabelColor(calendars));
		setConfirm(false);
		setLink("");
	}, [open, calendar]); // eslint-disable-line react-hooks/exhaustive-deps
	const outside = !!calendar?.sourceUrl;
	const asLink = fromLink && !calendar;
	const ownCount = calendars.filter((c) => !c.sourceUrl).length;
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (name.trim() && (!asLink || link.trim())) onSave(name.trim(), color, asLink ? link.trim() : undefined);
	};
	return (
		<Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
			<Dialog size="base" className="max-h-[90vh] overflow-y-auto p-6">
				<Dialog.Title className="mb-4 flex items-center gap-2 text-lg font-semibold">
					{asLink || outside ? <><LinkSimpleIcon size={20} /> {asLink ? copy.outsideTitle : copy.outsideEdit}</> : calendar ? copy.editCalendar : copy.newCalendar}
				</Dialog.Title>
				<form onSubmit={submit} className="space-y-5">
					{asLink && (
						<div className="space-y-3">
							<p className="text-base text-kumo-strong">{copy.outsideIntro}</p>
							<Input label={copy.outsideUrl} placeholder={copy.outsideUrlPlaceholder} value={link} type="url" inputMode="url" maxLength={2000} onChange={(e) => setLink(e.target.value)} autoFocus required />
							<div>
								<span className="mb-1.5 block text-sm font-medium text-kumo-default">{copy.outsideQuick}</span>
								<div className="flex flex-wrap gap-2">
									{BANK_HOLIDAYS.map((b) => (
										<button key={b.url} type="button" onClick={() => { setLink(b.url); setName(b.name); }} aria-pressed={link === b.url}
											className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${link === b.url ? "border-kumo-brand bg-kumo-tint text-kumo-default" : "border-kumo-line text-kumo-default hover:bg-kumo-tint"}`}>
											<CalendarPlusIcon size={14} /> {b.name.replace(/^Bank holidays \((.*)\)$/, "$1")}
										</button>
									))}
								</div>
							</div>
						</div>
					)}
					<Input label={copy.calendarName} placeholder={copy.calendarNamePlaceholder} value={name} maxLength={MAX_CALENDAR_NAME} onChange={(e) => setName(e.target.value)} autoFocus={!asLink} required />
					{outside && calendar && (
						<div className="space-y-2 rounded-lg border border-kumo-line p-3">
							<span className="block text-sm font-medium text-kumo-default">{copy.outsideUrl}</span>
							<input readOnly value={calendar.sourceUrl ?? ""} aria-label={copy.outsideUrl} onFocus={(e) => e.target.select()}
								className="w-full rounded-lg border border-kumo-line bg-kumo-recessed px-2 py-1.5 font-mono text-xs text-kumo-default" />
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-sm text-kumo-strong">{refreshedWords(calendar.refreshedAt)}</span>
								<Button type="button" variant="ghost" size="sm" icon={<ArrowsClockwiseIcon size={14} />} loading={refresh.isPending} onClick={() => refresh.mutate(calendar.id)}>{copy.outsideRefresh}</Button>
							</div>
							{calendar.refreshError && <p className="text-sm text-kumo-danger" role="alert">{fill(copy.outsideProblem, { problem: calendar.refreshError })}</p>}
						</div>
					)}
					<fieldset>
						<legend className="mb-2 text-base font-medium text-kumo-default">{copy.colour}</legend>
						<div className="grid grid-cols-6 gap-2.5">
							{LABEL_COLOR_KEYS.map((key) => {
								const c = LABEL_COLORS[key];
								return (
									<button key={key} type="button" onClick={() => setColor(key)} aria-label={c.name} aria-pressed={key === color} title={c.name}
										className={`flex size-9 cursor-pointer items-center justify-center rounded-full border-0 transition-transform hover:scale-110 ${key === color ? "ring-2 ring-offset-2 ring-kumo-ring ring-offset-kumo-base" : ""}`}
										style={{ backgroundColor: c.dot, color: c.ink }}>
										{key === color && <CheckIcon size={16} weight="bold" />}
									</button>
								);
							})}
						</div>
					</fieldset>
					{calendar && !outside && <FeedSection mailboxId={mailboxId} calendar={calendar} />}
					{confirm && (
						<div className="space-y-2 rounded-lg border border-kumo-danger/40 p-3">
							<p className="text-base">{fill(outside ? copy.outsideRemoveConfirm : copy.deleteCalendarConfirm, { name: calendar?.name ?? "" })}</p>
							<div className="flex gap-2">
								<Button type="button" variant="destructive" size="sm" onClick={onDelete} loading={busy}>{outside ? copy.outsideRemove : copy.deleteCalendar}</Button>
								<Button type="button" variant="ghost" size="sm" onClick={() => setConfirm(false)}>{copy.cancel}</Button>
							</div>
						</div>
					)}
					{error && <p className="text-base text-kumo-danger" role="alert">{error}</p>}
					{busy && asLink && <p className="text-sm text-kumo-strong">{copy.outsideAdding}</p>}
					<div className="flex flex-wrap items-center gap-2">
						{calendar && (outside || ownCount > 1) && !confirm && (
							<Button type="button" variant="ghost" className="text-kumo-danger" onClick={() => setConfirm(true)}>{outside ? copy.outsideRemove : copy.deleteCalendar}</Button>
						)}
						<div className="ml-auto flex gap-2">
							<Button type="button" variant="secondary" onClick={onClose}>{copy.cancel}</Button>
							<Button type="submit" variant="primary" disabled={!name.trim() || (asLink && !link.trim())} loading={busy}>{copy.save}</Button>
						</div>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

/** Asks which repeats a change or deletion is for. `allowOne` is false when the repeat itself changed. */
export function ScopeDialog({ kind, allowOne = true, allowFollowing = true, onChoose, onCancel }: {
	kind: "save" | "delete" | "move" | null;
	allowOne?: boolean;
	allowFollowing?: boolean;
	onChoose: (scope: EditScope) => void;
	onCancel: () => void;
}) {
	const first: EditScope = allowOne ? "one" : allowFollowing ? "following" : "all";
	const [scope, setScope] = useState<EditScope>(first);
	useEffect(() => setScope(first), [kind, first]);
	if (!kind) return null;
	const title = kind === "delete" ? copy.scopeTitleDelete : kind === "move" ? copy.scopeTitleMove : copy.scopeTitleSave;
	const options: [EditScope, string][] = [
		...(allowOne ? ([["one", copy.scopeOne]] as [EditScope, string][]) : []),
		...(allowFollowing ? ([["following", copy.scopeFollowing]] as [EditScope, string][]) : []),
		["all", copy.scopeAll],
	];
	return (
		<Dialog.Root open onOpenChange={(o) => { if (!o) onCancel(); }}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="mb-4 text-lg font-semibold">{title}</Dialog.Title>
				<fieldset className="space-y-2">
					{options.map(([value, words]) => (
						<label key={value} className="flex cursor-pointer items-center gap-3 rounded-lg border border-kumo-line px-3 py-2.5 text-base has-[:checked]:border-kumo-brand">
							<input type="radio" name="app-scope" value={value} checked={scope === value} onChange={() => setScope(value)} className="size-4" />
							{words}
						</label>
					))}
				</fieldset>
				<div className="mt-5 flex justify-end gap-2">
					<Button variant="secondary" onClick={onCancel}>{copy.cancel}</Button>
					<Button variant={kind === "delete" ? "destructive" : "primary"} onClick={() => onChoose(scope)}>{kind === "delete" ? copy.delete : copy.save}</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

const MONTH_DAYS = ["M", "T", "W", "T", "F", "S", "S"];
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** A small month to jump to any day, as in Gmail's calendar. In Week and Day view, the days on show are shaded. */
export function MiniMonth({ date, shownFrom, shownTo, onPick }: { date: Date; shownFrom: Date | null; shownTo: Date | null; onPick: (d: Date) => void }) {
	const [month, setMonth] = useState(() => new Date(date.getFullYear(), date.getMonth(), 1));
	useEffect(() => setMonth(new Date(date.getFullYear(), date.getMonth(), 1)), [date.getFullYear(), date.getMonth()]); // eslint-disable-line react-hooks/exhaustive-deps
	const first = new Date(month);
	first.setDate(1 - ((month.getDay() + 6) % 7)); // back to Monday
	const days = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
	const today = new Date();
	// The Month view covers the whole grid, so only a week or a day is worth shading.
	const shading = !!shownFrom && !!shownTo && shownTo.getTime() - shownFrom.getTime() <= 8 * 86_400_000;
	const step = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
	return (
		<div className="select-none">
			<div className="mb-1 flex items-center justify-between px-1">
				<span className="text-base font-semibold text-kumo-default">{month.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</span>
				<span className="flex">
					<Button variant="ghost" shape="square" size="xs" icon={<CaretLeftIcon size={14} />} aria-label={copy.previous} onClick={() => step(-1)} />
					<Button variant="ghost" shape="square" size="xs" icon={<CaretRightIcon size={14} />} aria-label={copy.next} onClick={() => step(1)} />
				</span>
			</div>
			<div className="grid grid-cols-7 text-center text-xs font-medium text-kumo-strong">
				{MONTH_DAYS.map((d, i) => <span key={i} className="py-1">{d}</span>)}
			</div>
			<div className="grid grid-cols-7 text-center text-sm">
				{days.map((d) => {
					const inMonth = d.getMonth() === month.getMonth();
					const isToday = sameDay(d, today);
					const shown = shading && d >= shownFrom! && d < shownTo!;
					return (
						<button key={d.toISOString()} type="button" onClick={() => onPick(d)}
							aria-label={d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
							className={`mx-auto my-px flex size-8 cursor-pointer items-center justify-center rounded-full tabular-nums ${isToday ? "bg-kumo-brand font-semibold text-white" : shown ? "bg-kumo-fill text-kumo-default" : inMonth ? "text-kumo-default hover:bg-kumo-tint" : "text-kumo-subtle hover:bg-kumo-tint"}`}>
							{d.getDate()}
						</button>
					);
				})}
			</div>
		</div>
	);
}

/** For people who can open more than one mailbox: whose calendar this is (each mailbox has its own). */
export function MailboxPicker({ mailboxId }: { mailboxId: string }) {
	const { data: all = [] } = useMailboxes();
	const navigate = useNavigate();
	const openable = all.filter((m) => m.canOpen !== false);
	if (openable.length < 2) return null;
	return (
		<label className="block">
			<span className="mb-1 block px-1 text-sm font-semibold uppercase tracking-wide text-kumo-strong">{copy.mailbox}</span>
			<select value={mailboxId} onChange={(e) => navigate(`/mailbox/${encodeURIComponent(e.target.value)}/calendar`)}
				className="w-full rounded-lg border border-kumo-line bg-kumo-recessed px-2 py-1.5 text-base text-kumo-default">
				{openable.map((m) => <option key={m.id} value={m.id}>{m.name && m.name !== m.email ? `${m.name} (${m.email})` : m.email}</option>)}
			</select>
		</label>
	);
}

type Choice = ShareLevel | "none";

/**
 * Who a calendar is shared with: everyone on the team, and each person, at Not shared, Busy times
 * only, See all events or Can edit.
 */
export function ShareDialog({ calendar, people, shares, loading, busy, error, onClose, onSave }: {
	calendar: Calendar | null;
	people: { email: string; name: string }[];
	/** As loaded (kept as the same list until it changes, so choices aren't reset while you pick). */
	shares: { with: string; level: ShareLevel }[] | undefined;
	loading: boolean;
	busy: boolean;
	error: string;
	onClose: () => void;
	onSave: (shares: { with: string; level: ShareLevel }[]) => void;
}) {
	const [chosen, setChosen] = useState<Record<string, Choice>>({});
	useEffect(() => {
		setChosen(Object.fromEntries((shares ?? []).map((s) => [s.with, s.level])));
	}, [calendar, shares]);
	if (!calendar) return null;
	const choice = (who: string): Choice => chosen[who] ?? "none";
	const pick = (who: string, level: Choice) => setChosen({ ...chosen, [who]: level });
	const submit = (e: FormEvent) => {
		e.preventDefault();
		onSave(Object.entries(chosen).filter(([, l]) => l !== "none").map(([w, l]) => ({ with: w, level: l as ShareLevel })));
	};
	const levelSelect = (who: string, label: string) => (
		<select aria-label={label} value={choice(who)} onChange={(e) => pick(who, e.target.value as Choice)}
			className="w-44 shrink-0 rounded-lg border border-kumo-line bg-kumo-recessed px-2 py-1.5 text-base text-kumo-default">
			{(["none", "busy", "view", "edit"] as Choice[]).map((l) => <option key={l} value={l}>{copy.levels[l]}</option>)}
		</select>
	);
	return (
		<Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
			<Dialog size="base" className="max-h-[90vh] overflow-y-auto p-6">
				<Dialog.Title className="mb-2 flex items-center gap-2 text-lg font-semibold"><UsersThreeIcon size={20} /> {fill(copy.shareTitle, { name: calendar.name })}</Dialog.Title>
				<p className="mb-4 text-base text-kumo-strong">{copy.shareIntro}</p>
				<form onSubmit={submit} className="space-y-4">
					{loading ? (
						<p className="text-base text-kumo-strong">{copy.shareLoading}</p>
					) : (
						<>
							<div className="rounded-lg border border-kumo-line p-3">
								<div className="flex flex-wrap items-center justify-between gap-2">
									<span className="font-medium text-kumo-default">{copy.shareEveryone}</span>
									{levelSelect(EVERYONE, copy.shareEveryone)}
								</div>
								<p className="mt-1 text-sm text-kumo-strong">{copy.shareEveryoneHint}</p>
							</div>
							{people.length === 0 ? (
								<p className="text-base text-kumo-strong">{copy.shareNobody}</p>
							) : (
								<ul className="divide-y divide-kumo-line rounded-lg border border-kumo-line">
									{people.map((p) => (
										<li key={p.email} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
											<span className="min-w-0">
												<span className="block truncate text-base text-kumo-default">{p.name || p.email}</span>
												{p.name && <span className="block truncate text-sm text-kumo-strong">{p.email}</span>}
											</span>
											{levelSelect(p.email, p.name || p.email)}
										</li>
									))}
								</ul>
							)}
						</>
					)}
					{error && <p className="text-base text-kumo-danger" role="alert">{error}</p>}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="secondary" onClick={onClose}>{copy.cancel}</Button>
						<Button type="submit" variant="primary" icon={<CheckIcon size={16} />} disabled={loading} loading={busy}>{copy.save}</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

/** A calendar's private subscribe link, for Apple Calendar, Outlook and Google Calendar (read only). */
function FeedSection({ mailboxId, calendar }: { mailboxId: string | undefined; calendar: Calendar }) {
	const { data: feed, isLoading } = useCalendarFeed(mailboxId, calendar.id);
	const save = useSaveCalendarFeed(mailboxId, calendar.id);
	const [copied, setCopied] = useState(false);
	const [problem, setProblem] = useState("");
	const run = (args: { level?: FeedLevel; renew?: boolean; off?: boolean }) => {
		setProblem("");
		save.mutate(args, { onError: (err) => setProblem(problemOf(err, copy.feedFailed)) });
	};
	const copyLink = async () => {
		if (!feed) return;
		try {
			await navigator.clipboard.writeText(feed.url);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch { /* the link is on show to copy by hand */ }
	};
	const appLink = "inline-flex items-center gap-1.5 rounded-lg border border-kumo-line px-3 py-1.5 text-sm font-medium text-kumo-default no-underline hover:bg-kumo-tint";
	return (
		<fieldset className="space-y-3 rounded-lg border border-kumo-line p-3">
			<legend className="flex items-center gap-1.5 px-1 text-base font-medium text-kumo-default"><LinkSimpleIcon size={16} /> {copy.feedTitle}</legend>
			<p className="text-sm text-kumo-strong">{copy.feedIntro}</p>
			{isLoading ? null : !feed ? (
				<Button type="button" variant="secondary" icon={<LinkSimpleIcon size={16} />} loading={save.isPending} onClick={() => run({ level: "all" })}>{copy.feedMake}</Button>
			) : (
				<>
					<label className="block">
						<span className="mb-1 block text-sm font-medium text-kumo-default">{copy.feedShows}</span>
						<select value={feed.level} onChange={(e) => run({ level: e.target.value as FeedLevel })}
							className="w-full rounded-lg border border-kumo-line bg-kumo-recessed px-2 py-1.5 text-base text-kumo-default">
							{(["all", "busy"] as FeedLevel[]).map((l) => <option key={l} value={l}>{copy.feedLevels[l]}</option>)}
						</select>
					</label>
					<div className="flex gap-2">
						<input readOnly value={feed.url} aria-label={copy.feedTitle} onFocus={(e) => e.target.select()}
							className="min-w-0 flex-1 rounded-lg border border-kumo-line bg-kumo-recessed px-2 py-1.5 font-mono text-xs text-kumo-default" />
						<Button type="button" variant="secondary" size="sm" icon={copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />} onClick={copyLink}>{copied ? copy.feedCopied : copy.feedCopy}</Button>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm text-kumo-strong">{copy.feedOpenIn}</span>
						<a className={appLink} href={feed.links.apple}><PlusIcon size={14} /> {copy.feedApple}</a>
						<a className={appLink} href={feed.links.google} target="_blank" rel="noopener noreferrer"><PlusIcon size={14} /> {copy.feedGoogle}</a>
						<a className={appLink} href={feed.links.outlook} target="_blank" rel="noopener noreferrer"><PlusIcon size={14} /> {copy.feedOutlook}</a>
					</div>
					<p className="text-sm text-kumo-strong">{copy.feedWarning}</p>
					<div className="flex flex-wrap gap-2">
						<Button type="button" variant="ghost" size="sm" icon={<ArrowsClockwiseIcon size={14} />} disabled={save.isPending} onClick={() => run({ level: feed.level, renew: true })}>{copy.feedRenew}</Button>
						<Button type="button" variant="ghost" size="sm" className="text-kumo-danger" icon={<PowerIcon size={14} />} disabled={save.isPending} onClick={() => run({ off: true })}>{copy.feedOff}</Button>
					</div>
				</>
			)}
			{problem && <p className="text-sm text-kumo-danger" role="alert">{problem}</p>}
		</fieldset>
	);
}

/** Imports an .ics file from another calendar app into one of your own calendars. */
export function ImportDialog({ mailboxId, open, calendars, onClose, onDone }: {
	mailboxId: string | undefined;
	open: boolean;
	calendars: Calendar[];
	onClose: () => void;
	onDone: (words: string) => void;
}) {
	const own = calendars.filter((c) => !c.sourceUrl);
	const [file, setFile] = useState<File | null>(null);
	const [into, setInto] = useState("");
	const [problem, setProblem] = useState("");
	const run = useImportCalendar(mailboxId);
	useEffect(() => {
		if (!open) return;
		setFile(null);
		setProblem("");
		setInto(own[0]?.id ?? "");
	}, [open]); // eslint-disable-line react-hooks/exhaustive-deps
	if (!open) return null;
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!file || !into) return;
		setProblem("");
		run.mutate({ id: into, file }, {
			onSuccess: (r) => onDone(fill(r.skipped ? copy.importDoneSkipped : copy.importDone, { added: String(r.added), skipped: String(r.skipped) })),
			onError: (err) => setProblem(problemOf(err, copy.failed)),
		});
	};
	return (
		<Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
			<Dialog size="base" className="max-h-[90vh] overflow-y-auto p-6">
				<Dialog.Title className="mb-2 flex items-center gap-2 text-lg font-semibold"><UploadSimpleIcon size={20} /> {copy.importTitle}</Dialog.Title>
				<p className="mb-4 text-base text-kumo-strong">{copy.importIntro}</p>
				<form onSubmit={submit} className="space-y-4">
					<label className="block">
						<span className="mb-1.5 block text-base font-medium text-kumo-default">{copy.importFile}</span>
						<input type="file" accept=".ics,text/calendar" required onChange={(e) => setFile(e.target.files?.[0] ?? null)}
							className="block w-full text-base text-kumo-default file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-kumo-line file:bg-kumo-recessed file:px-3 file:py-1.5 file:text-sm file:font-medium" />
					</label>
					{own.length > 1 && (
						<label className="block">
							<span className="mb-1.5 block text-base font-medium text-kumo-default">{copy.importInto}</span>
							<select value={into} onChange={(e) => setInto(e.target.value)} className="w-full rounded-lg border border-kumo-line bg-kumo-recessed px-2 py-1.5 text-base text-kumo-default">
								{own.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
							</select>
						</label>
					)}
					<p className="text-sm text-kumo-strong">{copy.importHowTo}</p>
					{problem && <p className="text-base text-kumo-danger" role="alert">{problem}</p>}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="secondary" onClick={onClose}>{copy.cancel}</Button>
						<Button type="submit" variant="primary" icon={<UploadSimpleIcon size={16} />} disabled={!file} loading={run.isPending}>{copy.importGo}</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
