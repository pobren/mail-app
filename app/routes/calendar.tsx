// Mail App addition (not part of upstream Agentic Inbox).
// The Calendar page: month, week, day and list views. Drag across the calendar to add an event, drag
// an event to move it, or drag its edge to make it longer. The grid is FullCalendar's free (MIT) version.
// Calendars other people share with you show alongside your own, under "Shared with me".

import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import enGbLocale from "@fullcalendar/core/locales/en-gb";
import type { DateSelectArg, DatesSetArg, EventChangeArg, EventClickArg, EventContentArg, EventInput as FcEvent } from "@fullcalendar/core";
import { Button, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import { CaretDoubleLeftIcon, CaretLeftIcon, CaretRightIcon, LockSimpleIcon, ArrowsClockwiseIcon, BellIcon, PlusIcon, SidebarSimpleIcon, StackIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { formatWall, parseWall, utcToZoned, type Calendar, type CalendarColor, type EditScope, type EventInput, type Occurrence } from "shared/calendar";
import { LABEL_COLORS } from "shared/labels";
import EventDialog, { browserTimeZone, type CalendarChoice, type EventDraft } from "~/components/calendar/EventDialog";
import { CalendarDialog, CalendarList, ImportDialog, MailboxPicker, MiniMonth, ScopeDialog, ShareDialog } from "~/components/calendar/CalendarParts";
import copy from "~/copy/calendar.en-GB.json";
import { useIsWide } from "~/hooks/useIsWide";
import { WIDE_QUERY } from "~/hooks/useUIStore";
import {
	problemOf, useCalendarEvents, useCalendars, useCalendarShares, useDeleteCalendar, useDeleteEvent, useDeleteSharedEvent, useSaveCalendar, useSaveEvent,
	useSaveShares, useSaveSharedEvent, useShareCounts, useSharedCalendars, useSharedEvents,
} from "~/queries/calendar";
import { useMailbox } from "~/queries/mailboxes";

type View = "dayGridMonth" | "timeGridWeek" | "timeGridDay" | "listWeek";
const VIEWS: [View, string][] = [["dayGridMonth", copy.month], ["timeGridWeek", copy.week], ["timeGridDay", copy.day], ["listWeek", copy.list]];
const DAY = 86_400_000;
const SLOT = 30 * 60_000; // FullCalendar's default half-hour rows
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ""));
const pad = (n: number) => String(n).padStart(2, "0");

/** A date FullCalendar gives us (local time) as a wall-clock time in the event's zone. */
function wallOf(date: Date, allDay: boolean, timeZone: string): string {
	if (allDay) return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	return formatWall(utcToZoned(date.getTime(), timeZone));
}

interface PendingScope {
	kind: "save" | "delete" | "move";
	allowOne: boolean;
	/** False for a series with guests: one date or all of them, as in Outlook. */
	allowFollowing?: boolean;
	run: (scope: EditScope) => void;
	cancel?: () => void;
}

export default function CalendarRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [params] = useSearchParams();
	const wide = useIsWide();
	const toast = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const shared = !!(mailbox as { shared?: boolean } | undefined)?.shared;
	const { data: calendars = [] } = useCalendars(mailboxId);
	const [range, setRange] = useState<{ from: string; to: string } | null>(null);
	const { data: ownOccurrences = [], isError, isFetching } = useCalendarEvents(mailboxId, range);
	const saveEvent = useSaveEvent(mailboxId);
	const deleteEvent = useDeleteEvent(mailboxId);
	// Calendars shared with you, and what's in them.
	const { data: sharedCalendars = [] } = useSharedCalendars();
	const { data: sharedOccurrences = [] } = useSharedEvents(range, sharedCalendars.length > 0);
	const occurrences = useMemo(() => (sharedCalendars.length ? [...ownOccurrences, ...sharedOccurrences] : ownOccurrences), [ownOccurrences, sharedOccurrences, sharedCalendars.length]);
	const saveShared = useSaveSharedEvent();
	const deleteShared = useDeleteSharedEvent();
	const { data: shareCounts } = useShareCounts(mailboxId);
	const [shareCal, setShareCal] = useState<Calendar | null>(null);
	const shareInfo = useCalendarShares(mailboxId, shareCal?.id ?? null);
	const saveShares = useSaveShares(mailboxId);
	const [shareError, setShareError] = useState("");
	const [importing, setImporting] = useState(false);
	const saveCalendar = useSaveCalendar(mailboxId);
	const deleteCalendar = useDeleteCalendar(mailboxId);
	const calRef = useRef<FullCalendar>(null);
	const [ready, setReady] = useState(false);
	const [title, setTitle] = useState("");
	const [shown, setShown] = useState<{ date: Date; from: Date | null; to: Date | null }>(() => ({ date: new Date(), from: null, to: null }));
	const [view, setView] = useState<View>("timeGridWeek");
	const [draft, setDraft] = useState<EventDraft | null>(null);
	const [scope, setScope] = useState<PendingScope | null>(null);
	const [calDialog, setCalDialog] = useState<{ open: boolean; calendar: Calendar | null; fromLink?: boolean }>({ open: false, calendar: null });
	const [calError, setCalError] = useState("");
	const [showCalendars, setShowCalendars] = useState(false);
	// The side panel folds away like Mail's folders. It starts folded in a narrow window, until you choose.
	const panelKey = "mailapp.calendar.panel";
	const [panelOpen, setPanelOpen] = useState(true);
	useEffect(() => {
		try {
			const saved = localStorage.getItem(panelKey);
			if (saved !== null) { setPanelOpen(saved === "1"); return; }
		} catch { /* not remembered */ }
		if (!window.matchMedia("(min-width: 1100px)").matches) setPanelOpen(false);
	}, []);
	const togglePanel = (open: boolean) => {
		setPanelOpen(open);
		try { localStorage.setItem(panelKey, open ? "1" : "0"); } catch { /* not remembered */ }
	};

	// Calendars switched off on this device.
	const hiddenKey = `mailapp.calendar.hidden.${mailboxId}`;
	const [hidden, setHidden] = useState<Set<string>>(new Set());
	useEffect(() => {
		try { setHidden(new Set(JSON.parse(localStorage.getItem(hiddenKey) || "[]"))); } catch { /* not remembered */ }
		// Phones start on the list, which is easier to read on a small screen.
		if (!window.matchMedia(WIDE_QUERY).matches) setView("listWeek");
		setReady(true);
	}, [hiddenKey]);
	const toggleHidden = (id: string) => {
		const next = new Set(hidden);
		if (next.has(id)) next.delete(id); else next.add(id);
		setHidden(next);
		try { localStorage.setItem(hiddenKey, JSON.stringify([...next])); } catch { /* not remembered */ }
	};

	const calById = useMemo(() => new Map<string, Calendar>([...calendars, ...sharedCalendars].map((c) => [c.id, c])), [calendars, sharedCalendars]);
	const sharedById = useMemo(() => new Map(sharedCalendars.map((c) => [c.id, c])), [sharedCalendars]);
	// Where a new event can go: your own calendars (not ones from other websites), then ones shared with you to edit.
	const ownCalendars = calendars.filter((c) => !c.sourceUrl);
	const editableShared: CalendarChoice[] = sharedCalendars.filter((c) => c.level === "edit");
	const choicesFor = (d: EventDraft | null): CalendarChoice[] => {
		if (d?.id) return d.owner ? editableShared.filter((c) => c.owner === d.owner) : ownCalendars;
		return [...ownCalendars, ...editableShared];
	};
	const colourOf = (o: { color: CalendarColor | null; calendarId: string }) => LABEL_COLORS[o.color ?? calById.get(o.calendarId)?.color ?? "blue"] ?? LABEL_COLORS.blue;

	const events: FcEvent[] = useMemo(() => occurrences.filter((o) => !hidden.has(o.calendarId)).map((o) => {
		const c = colourOf(o);
		return {
			id: o.id,
			title: o.title,
			start: o.startAt,
			end: o.endAt,
			allDay: o.allDay,
			editable: o.canEdit,
			backgroundColor: c.tint,
			borderColor: c.dot,
			textColor: c.ink,
			extendedProps: { occ: o },
		};
	}), [occurrences, hidden, calById]); // eslint-disable-line react-hooks/exhaustive-deps

	const api = () => calRef.current?.getApi();
	// The calendar measures itself, so tell it when the side panel opens or folds.
	useEffect(() => { const t = setTimeout(() => api()?.updateSize(), 0); return () => clearTimeout(t); }, [panelOpen]); // eslint-disable-line react-hooks/exhaustive-deps
	const changeView = (v: View) => {
		setView(v);
		api()?.changeView(v);
	};
	const firstCalendarId = calendars.find((c) => !hidden.has(c.id) && !c.sourceUrl)?.id ?? calendars.find((c) => !c.sourceUrl)?.id ?? "";

	const newDraft = (start: string, end: string, allDay: boolean): EventDraft => ({
		input: {
			calendarId: firstCalendarId, title: "", allDay, start, end, timeZone: browserTimeZone(),
			location: "", notes: "", color: null, private: false, repeat: null, reminders: allDay ? [] : [10], guests: [], meetingUrl: "",
		},
		canEdit: true,
	});

	const openNew = () => {
		const now = new Date();
		const start = new Date(now);
		start.setMinutes(0, 0, 0);
		start.setHours(start.getHours() + 1);
		const shown = api()?.getDate();
		if (shown && (shown.toDateString() !== now.toDateString())) start.setFullYear(shown.getFullYear(), shown.getMonth(), shown.getDate());
		const tz = browserTimeZone();
		setDraft(newDraft(wallOf(start, false, tz), wallOf(new Date(start.getTime() + 3_600_000), false, tz), false));
	};

	// One click picks a slot or an event and highlights it; a second click on it (or a double click) opens
	// the event window, as in Outlook. Dragging across several slots opens the window straight away.
	const lastSlot = useRef<{ key: string; info: DateSelectArg } | null>(null);
	const [picked, setPicked] = useState<string | null>(null);

	const onSelect = (info: DateSelectArg) => {
		const key = `${info.view.type}|${info.startStr}|${info.endStr}`;
		const span = info.end.getTime() - info.start.getTime();
		const oneSlot = info.allDay || info.view.type === "dayGridMonth" ? span === DAY : span <= SLOT;
		setPicked(null);
		if (oneSlot && lastSlot.current?.key !== key) {
			lastSlot.current = { key, info }; // keep it highlighted until the next click
			return;
		}
		openSlot(info);
	};

	const openSlot = (info: DateSelectArg) => {
		lastSlot.current = null;
		const tz = browserTimeZone();
		// A click on a day in the month view makes a one-hour event at 9am rather than an all-day one.
		const monthClick = info.view.type === "dayGridMonth" && info.end.getTime() - info.start.getTime() === DAY;
		if (monthClick) {
			const s = new Date(info.start);
			s.setHours(9);
			setDraft(newDraft(wallOf(s, false, tz), wallOf(new Date(s.getTime() + 3_600_000), false, tz), false));
		} else {
			setDraft(newDraft(wallOf(info.start, info.allDay, tz), wallOf(info.end, info.allDay, tz), info.allDay));
		}
		info.view.calendar.unselect();
	};

	const onEventClick = (info: EventClickArg) => {
		info.jsEvent.preventDefault();
		const o = info.event.extendedProps.occ as Occurrence;
		info.view.calendar.unselect();
		lastSlot.current = null;
		// The list has nothing to highlight against, and a finger can't double click, so those open on the first tap.
		const firstTapOpens = info.view.type === "listWeek" || window.matchMedia("(pointer: coarse)").matches;
		if (!firstTapOpens && picked !== o.id) { setPicked(o.id); return; }
		setPicked(null);
		const sharedCal = o.owner ? sharedById.get(o.calendarId) : undefined;
		const fromLink = calById.get(o.calendarId)?.sourceUrl ? calById.get(o.calendarId) : undefined;
		const readOnlyReason: EventDraft["readOnlyReason"] = o.canEdit ? undefined
			: sharedCal?.level === "busy" ? "busy"
			: o.busy ? "private"
			: fromLink ? "outside"
			: sharedCal?.level === "edit" ? "guests"
			: sharedCal ? "shared" : "private";
		setDraft({
			id: o.eventId,
			occurrence: o.occurrence,
			isRepeating: !!o.repeat,
			canEdit: o.canEdit,
			readOnlyReason,
			owner: o.owner,
			ownerName: sharedCal?.ownerName,
			calendarName: calById.get(o.calendarId)?.name,
			createdByName: o.createdByName,
			organizer: o.organizer ?? null,
			input: {
				calendarId: o.calendarId, title: o.title, allDay: o.allDay, start: o.start, end: o.end, timeZone: o.timeZone,
				location: o.location, notes: o.notes, color: o.color, private: o.private, repeat: o.repeat, reminders: o.reminders,
				guests: o.guests ?? [], meetingUrl: o.meetingUrl ?? "",
			},
		});
	};

	/** The mailbox a calendar shared with you belongs to, or undefined for your own. */
	const ownerOfCalendar = (calendarId: string) => sharedById.get(calendarId)?.owner;

	const persist = (id: string | undefined, event: EventInput, scopeChoice: EditScope, occurrence: string | null, revert?: () => void, notify = false) => {
		const onError = (err: unknown) => {
			revert?.();
			toast.add({ title: problemOf(err, copy.failed), variant: "error" });
		};
		const owner = ownerOfCalendar(event.calendarId);
		if (owner) {
			saveShared.mutate({ owner, id, event, scope: scopeChoice, occurrence }, {
				onSuccess: () => { setDraft(null); toast.add({ title: copy.saved }); },
				onError,
			});
			return;
		}
		saveEvent.mutate({ id, event, scope: scopeChoice, occurrence, notify }, {
			onSuccess: (saved) => {
				setDraft(null);
				if (saved?.inviteProblem) toast.add({ title: fill(copy.notEmailed, { problem: saved.inviteProblem }), variant: "error" });
				else toast.add({ title: notify ? copy.guestsEmailed : copy.saved });
			},
			onError,
		});
	};

	// A repeating event with guests changes one date or all of them (as in Outlook), so everyone's calendar stays the same.
	const withGuests = (o: { guests?: EventInput["guests"] }) => (o.guests?.length ?? 0) > 0;

	const onDialogSave = (input: EventInput, repeatChanged: boolean, notify: boolean) => {
		if (!draft) return;
		const guests = withGuests(input) || withGuests(draft.input);
		if (draft.id && draft.isRepeating && draft.occurrence && !(guests && repeatChanged)) {
			setScope({ kind: "save", allowOne: !repeatChanged, allowFollowing: !guests, run: (s) => persist(draft.id, input, s, draft.occurrence ?? null, undefined, notify) });
		} else {
			persist(draft.id, input, "all", draft.occurrence ?? null, undefined, notify);
		}
	};

	const onDialogDelete = (notify: boolean) => {
		if (!draft?.id) return;
		if (draft.owner) {
			const owner = draft.owner;
			const runShared = (s: EditScope) => deleteShared.mutate({ owner, id: draft.id!, scope: s, occurrence: draft.occurrence ?? null }, {
				onSuccess: () => { setDraft(null); toast.add({ title: copy.deleted }); },
				onError: (err) => toast.add({ title: problemOf(err, copy.failed), variant: "error" }),
			});
			if (draft.isRepeating && draft.occurrence) setScope({ kind: "delete", allowOne: true, allowFollowing: true, run: runShared });
			else runShared("all");
			return;
		}
		const run = (s: EditScope) => deleteEvent.mutate({ id: draft.id!, scope: s, occurrence: draft.occurrence ?? null, notify }, {
			onSuccess: (done) => {
				setDraft(null);
				if (done?.inviteProblem) toast.add({ title: fill(copy.notEmailed, { problem: done.inviteProblem }), variant: "error" });
				else toast.add({ title: notify ? copy.guestsCancelled : copy.deleted });
			},
			onError: (err) => toast.add({ title: problemOf(err, copy.failed), variant: "error" }),
		});
		if (draft.isRepeating && draft.occurrence) setScope({ kind: "delete", allowOne: true, allowFollowing: !withGuests(draft.input), run });
		else run("all");
	};

	// Dragging an event to a new time, or dragging its edge.
	const onEventChange = (info: EventChangeArg) => {
		const o = info.event.extendedProps.occ as Occurrence;
		const allDay = info.event.allDay;
		const start = info.event.start!;
		const end = info.event.end ?? new Date(start.getTime() + (allDay ? DAY : 3_600_000));
		let reminders = o.reminders;
		if (allDay !== o.allDay) reminders = [];
		const input: EventInput = {
			calendarId: o.calendarId, title: o.title, allDay, start: wallOf(start, allDay, o.timeZone), end: wallOf(end, allDay, o.timeZone), timeZone: o.timeZone,
			location: o.location, notes: o.notes, color: o.color, private: o.private, repeat: o.repeat, reminders,
			guests: o.guests ?? [], meetingUrl: o.meetingUrl ?? "",
		};
		if (!allDay && parseWall(input.end) <= parseWall(input.start)) input.end = formatWall(parseWall(input.start) + 3_600_000);
		// Guests of our own events hear about the new time.
		const notify = withGuests(o) && !o.organizer && !o.owner;
		if (o.repeat && o.occurrence) {
			setScope({ kind: "move", allowOne: true, allowFollowing: !withGuests(o), run: (s) => persist(o.eventId, input, s, o.occurrence, info.revert, notify), cancel: info.revert });
		} else {
			persist(o.eventId, input, "all", o.occurrence, info.revert, notify);
		}
	};

	const onDatesSet = (info: DatesSetArg) => {
		setTitle(info.view.title);
		setShown({ date: info.view.calendar.getDate(), from: info.view.activeStart, to: info.view.activeEnd });
		setView(info.view.type as View);
		const from = info.start.toISOString();
		const to = info.end.toISOString();
		setRange((r) => (r && r.from === from && r.to === to ? r : { from, to }));
	};

	const renderEvent = (arg: EventContentArg) => {
		const o = arg.event.extendedProps.occ as Occurrence | undefined;
		// The outline drawn while you drag out a new event.
		if (!o) return <span className="px-1 text-[13px] font-semibold">{arg.timeText}</span>;
		const isList = arg.view.type.startsWith("list");
		const icons = (
			<>
				{o.repeat && <ArrowsClockwiseIcon size={12} aria-label="Repeats" className="shrink-0" />}
				{o.private && <LockSimpleIcon size={12} aria-label={copy.private} className="shrink-0" />}
				{o.reminders.length > 0 && !isList && arg.view.type !== "dayGridMonth" && <BellIcon size={12} aria-label={copy.reminders} className="shrink-0 opacity-70" />}
			</>
		);
		if (isList) {
			return (
				<span className="flex min-w-0 items-center gap-1.5 text-base">
					<span className="truncate font-medium">{arg.event.title}</span>
					{icons}
					{o.location && <span className="truncate text-kumo-strong">· {o.location}</span>}
				</span>
			);
		}
		if (arg.view.type === "dayGridMonth" && !arg.event.allDay) {
			const c = colourOf(o);
			return (
				<span className="flex min-w-0 items-center gap-1 overflow-hidden px-0.5 text-[13px]">
					<span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: c.dot }} />
					<span className="shrink-0 tabular-nums text-kumo-strong">{arg.timeText}</span>
					<span className="truncate font-medium text-kumo-default">{arg.event.title}</span>
				</span>
			);
		}
		const minutes = arg.event.end && arg.event.start ? (arg.event.end.getTime() - arg.event.start.getTime()) / 60_000 : 60;
		if (!arg.event.allDay && minutes < 45) {
			// Short events: one line with just the title (where it sits shows the time).
			return (
				<span className="flex h-full min-w-0 items-center gap-1 overflow-hidden px-1 text-[13px] leading-tight" title={`${arg.event.title}, ${arg.timeText}`}>
					<span className="min-w-0 truncate font-semibold">{arg.event.title}</span>
					{minutes >= 30 && <span className="hidden shrink-0 tabular-nums opacity-90 xl:inline">{arg.timeText.split(" - ")[0]}</span>}
				</span>
			);
		}
		return (
			<span className="flex h-full min-w-0 flex-col overflow-hidden px-1 py-0.5 text-[13px] leading-tight">
				<span className="flex min-w-0 items-start gap-1 font-semibold">
					<span className={arg.event.allDay ? "truncate" : "line-clamp-2"}>{arg.event.title}</span>
					{icons}
				</span>
				{!arg.event.allDay && <span className="tabular-nums opacity-90">{arg.timeText}</span>}
				{o.location && !arg.event.allDay && <span className="truncate opacity-90">{o.location}</span>}
			</span>
		);
	};

	const initialDate = params.get("date") && !Number.isNaN(parseWall(params.get("date")!)) ? params.get("date")! : undefined;
	const exportUrl = `/api/v1/mailboxes/${encodeURIComponent(mailboxId ?? "")}/calendar/export.ics`;
	const visibleEmpty = range && !isFetching && events.length === 0;

	const list = (
		<CalendarList
			calendars={calendars}
			hidden={hidden}
			onToggle={toggleHidden}
			onEdit={(cal) => { setCalError(""); setCalDialog({ open: true, calendar: cal }); }}
			onNew={() => { setCalError(""); setCalDialog({ open: true, calendar: null }); }}
			onImport={() => setImporting(true)}
			onNewFromLink={() => { setCalError(""); setCalDialog({ open: true, calendar: null, fromLink: true }); }}
			onShare={(cal) => { setShareError(""); setShareCal(cal); }}
			shareCounts={shareCounts}
			shared={sharedCalendars}
			exportUrl={exportUrl}
		/>
	);

	return (
		<div className="app-calendar flex h-full min-h-0">
			<aside className={`hidden w-64 shrink-0 space-y-5 overflow-y-auto border-r border-kumo-line bg-kumo-recessed p-3 ${panelOpen ? "md:block" : ""}`}>
				<div className="flex items-center gap-1">
					<Button variant="primary" className="flex-1" icon={<PlusIcon size={16} />} onClick={openNew}>{copy.newEvent}</Button>
					<Tooltip content={copy.hidePanel} side="right" asChild>
						<Button variant="ghost" shape="square" icon={<CaretDoubleLeftIcon size={16} />} aria-label={copy.hidePanel} onClick={() => togglePanel(false)} />
					</Tooltip>
				</div>
				<MiniMonth date={shown.date} shownFrom={shown.from} shownTo={shown.to} onPick={(d) => api()?.gotoDate(d)} />
				{mailboxId && <MailboxPicker mailboxId={mailboxId} />}
				{list}
			</aside>
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex flex-wrap items-center gap-2 border-b border-kumo-line px-3 py-2 md:px-4">
					{!panelOpen && (
						<Tooltip content={copy.showPanel} side="bottom" asChild>
							<Button variant="ghost" shape="square" size="sm" className="hidden md:flex" icon={<SidebarSimpleIcon size={18} />} aria-label={copy.showPanel} onClick={() => togglePanel(true)} />
						</Tooltip>
					)}
					<Button variant="secondary" size="sm" onClick={() => api()?.today()}>{copy.today}</Button>
					<div className="flex">
						<Button variant="ghost" shape="square" size="sm" icon={<CaretLeftIcon size={16} />} aria-label={copy.previous} onClick={() => api()?.prev()} />
						<Button variant="ghost" shape="square" size="sm" icon={<CaretRightIcon size={16} />} aria-label={copy.next} onClick={() => api()?.next()} />
					</div>
					<h1 className="order-first min-w-0 basis-full truncate text-lg font-semibold text-kumo-default md:order-none md:flex-1 md:basis-auto">{title}</h1>
					<div className="flex rounded-lg border border-kumo-line p-0.5" role="group" aria-label="View">
						{VIEWS.map(([v, words]) => (
							<button key={v} type="button" onClick={() => changeView(v)} aria-pressed={view === v}
								className={`cursor-pointer rounded-md px-2.5 py-1 text-sm font-medium ${view === v ? "bg-kumo-fill text-kumo-default" : "text-kumo-strong hover:bg-kumo-tint"}`}>
								{words}
							</button>
						))}
					</div>
					<div className={`flex gap-2 ${panelOpen ? "md:hidden" : ""}`}>
						<Button variant="ghost" shape="square" size="sm" className="md:hidden" icon={<StackIcon size={18} />} aria-label={copy.calendars} onClick={() => setShowCalendars((s) => !s)} />
						<Button variant="primary" size="sm" icon={<PlusIcon size={16} />} onClick={openNew}>{copy.newEvent}</Button>
					</div>
				</div>
				{showCalendars && (
					<div className="space-y-4 border-b border-kumo-line p-3 md:hidden">
						{mailboxId && <MailboxPicker mailboxId={mailboxId} />}
						{list}
					</div>
				)}
				{isError && <p className="px-4 py-2 text-base text-kumo-danger" role="alert">{copy.loadFailed}</p>}
				{/* A quick double click can come too fast for the calendar's second "select", so it's caught here too. */}
				<div className="relative min-h-0 flex-1 p-2 md:p-3"
					onDoubleClick={(e) => { if (lastSlot.current && !(e.target as HTMLElement).closest(".fc-event:not(.fc-event-mirror)")) openSlot(lastSlot.current.info); }}>
					{ready && (
						<FullCalendar
							ref={calRef}
							plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
							locale={enGbLocale}
							initialView={view}
							initialDate={initialDate}
							headerToolbar={false}
							height="100%"
							firstDay={1}
							nowIndicator
							editable
							selectable
							selectMirror
							dayMaxEvents
							longPressDelay={350}
							scrollTime="08:00:00"
							slotLabelFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
							eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
							allDayText={copy.allDay}
							listDayFormat={{ weekday: "long" }}
							listDaySideFormat={{ day: "numeric", month: "short" }}
							noEventsText={wide ? copy.empty : copy.emptyPhone}
							events={events}
							datesSet={onDatesSet}
							select={onSelect}
							eventClick={onEventClick}
							eventClassNames={(arg) => (arg.event.id === picked ? ["app-picked"] : [])}
							eventChange={onEventChange}
							eventContent={renderEvent}
						/>
					)}
					{visibleEmpty && view !== "listWeek" && (
						<p className="pointer-events-none absolute inset-x-0 bottom-6 mx-auto w-fit rounded-full bg-kumo-base/90 px-4 py-2 text-sm text-kumo-strong shadow-sm">
							{wide ? copy.empty : copy.emptyPhone}
						</p>
					)}
				</div>
			</div>

			<EventDialog
				draft={draft}
				calendars={choicesFor(draft)}
				sharedMailbox={shared}
				busy={saveEvent.isPending || deleteEvent.isPending || saveShared.isPending || deleteShared.isPending}
				onClose={() => setDraft(null)}
				onSave={onDialogSave}
				onDelete={onDialogDelete}
			/>
			<ScopeDialog
				kind={scope?.kind ?? null}
				allowOne={scope?.allowOne}
				allowFollowing={scope?.allowFollowing}
				onCancel={() => { scope?.cancel?.(); setScope(null); }}
				onChoose={(s) => { const run = scope?.run; setScope(null); run?.(s); }}
			/>
			<ImportDialog
				mailboxId={mailboxId}
				open={importing}
				calendars={calendars}
				onClose={() => setImporting(false)}
				onDone={(words) => { setImporting(false); toast.add({ title: words }); }}
			/>
			<ShareDialog
				calendar={shareCal}
				people={shareInfo.data?.people ?? []}
				shares={shareInfo.data?.shares}
				loading={shareInfo.isLoading}
				busy={saveShares.isPending}
				error={shareError}
				onClose={() => setShareCal(null)}
				onSave={(shares) => shareCal && saveShares.mutate({ id: shareCal.id, shares }, {
					onSuccess: () => { setShareCal(null); toast.add({ title: copy.shareSaved }); },
					onError: (err) => setShareError(problemOf(err, copy.failed)),
				})}
			/>
			<CalendarDialog
				mailboxId={mailboxId}
				open={calDialog.open}
				fromLink={calDialog.fromLink}
				calendar={calDialog.calendar}
				calendars={calendars}
				busy={saveCalendar.isPending || deleteCalendar.isPending}
				error={calError}
				onClose={() => setCalDialog({ open: false, calendar: null })}
				onSave={(name, color, sourceUrl) => saveCalendar.mutate({ id: calDialog.calendar?.id, name, color, sourceUrl, tz: browserTimeZone() }, {
					onSuccess: () => setCalDialog({ open: false, calendar: null }),
					onError: (err) => setCalError(problemOf(err, copy.failed)),
				})}
				onDelete={() => calDialog.calendar && deleteCalendar.mutate(calDialog.calendar.id, {
					onSuccess: () => setCalDialog({ open: false, calendar: null }),
					onError: (err) => setCalError(problemOf(err, copy.failed)),
				})}
			/>
		</div>
	);
}
