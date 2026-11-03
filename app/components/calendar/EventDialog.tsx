// Mail App addition (not part of upstream Agentic Inbox).
// The event window: title, times, repeat, calendar, colour, place, video call link, guests, notes,
// reminders and Private. Guests of our own events are emailed invites when it's saved. Events in a
// calendar someone shared with you have no guests or reminders (those belong to the calendar's own people).

import { Button, Dialog, Input, Switch } from "@cloudflare/kumo";
import { BellIcon, CheckIcon, EnvelopeSimpleIcon, EyeIcon, LockSimpleIcon, PlusIcon, UsersIcon, VideoCameraIcon, XIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
	describeReminder, describeRepeat, parseWall, formatWall, weekOfMonth, WEEKDAYS, REMINDER_CHOICES, ALL_DAY_REMINDER_CHOICES, MAX_REMINDERS,
	cleanGuests, cleanMeetingUrl, MAX_GUESTS,
	type Calendar, type CalendarColor, type EventInput, type Guest, type Organizer, type Repeat, type Weekday,
} from "shared/calendar";
import { joinWords, newJitsiLink } from "shared/invites";
import { LABEL_COLORS, LABEL_COLOR_KEYS } from "shared/labels";
import copy from "~/copy/calendar.en-GB.json";

const DAY = 86_400_000;
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ""));
const inputBase = "rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-base text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring";
export const selectClass = `w-full ${inputBase}`;
const fieldLabel = "block text-base font-medium text-kumo-default mb-1.5";
const SHORT_DAYS: Record<Weekday, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
const LONG_DAYS: Record<Weekday, string> = { MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };

export function browserTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London";
	} catch {
		return "Europe/London";
	}
}

type Preset = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "monthlyWeekday" | "yearly" | "custom";

function presetOf(repeat: Repeat | null, start: string): Preset {
	if (!repeat) return "none";
	if (repeat.interval !== 1) return "custom";
	const weekday = WEEKDAYS[(new Date(parseWall(start)).getUTCDay() + 6) % 7];
	if (repeat.freq === "daily") return "daily";
	if (repeat.freq === "weekly") {
		const days = repeat.days ?? [];
		if (days.length === 5 && ["MO", "TU", "WE", "TH", "FR"].every((d) => days.includes(d as Weekday))) return "weekdays";
		if (days.length === 0 || (days.length === 1 && days[0] === weekday)) return "weekly";
		return "custom";
	}
	if (repeat.freq === "monthly") return repeat.monthlyBy === "weekday" ? "monthlyWeekday" : "monthly";
	return "yearly";
}

function repeatFor(preset: Preset, current: Repeat | null): Repeat | null {
	const ends = { until: current?.until ?? null, count: current?.count ?? null };
	switch (preset) {
		case "none": return null;
		case "daily": return { freq: "daily", interval: 1, ...ends };
		case "weekdays": return { freq: "weekly", interval: 1, days: ["MO", "TU", "WE", "TH", "FR"], ...ends };
		case "weekly": return { freq: "weekly", interval: 1, ...ends };
		case "monthly": return { freq: "monthly", interval: 1, monthlyBy: "date", ...ends };
		case "monthlyWeekday": return { freq: "monthly", interval: 1, monthlyBy: "weekday", ...ends };
		case "yearly": return { freq: "yearly", interval: 1, ...ends };
		case "custom": return current ?? { freq: "weekly", interval: 1 };
	}
}

/** What the window is showing: a new event (no id) or one that's already there. */
export interface EventDraft {
	id?: string;
	/** The repeat being changed, for repeating events. */
	occurrence?: string | null;
	input: EventInput;
	canEdit: boolean;
	createdByName?: string | null;
	isRepeating?: boolean;
	/** Who invited us, for an event we were invited to. */
	organizer?: Organizer | null;
	/** Why it can't be changed: someone's private event, a calendar shared as busy times or to look at only, or one with guests. */
	readOnlyReason?: "private" | "busy" | "shared" | "guests" | "outside";
	/** The calendar's name, for an event from another website's calendar. */
	calendarName?: string;
	/** For an event in a calendar someone shared with you: the mailbox it's in, and whose it is. */
	owner?: string;
	ownerName?: string;
}

/** A calendar to put an event in. Ones shared with you say whose they are. */
export type CalendarChoice = Calendar & { owner?: string; ownerName?: string };

export default function EventDialog({ draft, calendars, onClose, onSave, onDelete, busy, sharedMailbox }: {
	draft: EventDraft | null;
	calendars: CalendarChoice[];
	onClose: () => void;
	onSave: (input: EventInput, repeatChanged: boolean, notify: boolean) => void;
	onDelete: (notify: boolean) => void;
	busy: boolean;
	sharedMailbox: boolean;
}) {
	const [ev, setEv] = useState<EventInput | null>(draft?.input ?? null);
	const [error, setError] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [notify, setNotify] = useState(true);
	useEffect(() => {
		setEv(draft?.input ?? null);
		setError("");
		setConfirmDelete(false);
		setNotify(true);
	}, [draft]);
	const preset = useMemo(() => (ev ? presetOf(ev.repeat, ev.start) : "none"), [ev]);
	const [showCustom, setShowCustom] = useState(false);
	useEffect(() => setShowCustom(preset === "custom"), [draft]); // eslint-disable-line react-hooks/exhaustive-deps

	if (!draft || !ev) return null;
	const readOnly = !draft.canEdit;
	const set = (changes: Partial<EventInput>) => {
		setEv({ ...ev, ...changes });
		setError("");
	};

	const startDate = ev.start.slice(0, 10);
	const startTime = ev.allDay ? "09:00" : ev.start.slice(11, 16);
	// All-day events end the day after; the window shows the last day.
	const endDate = ev.allDay ? formatWall(parseWall(ev.end) - DAY, true) : ev.end.slice(0, 10);
	const endTime = ev.allDay ? "10:00" : ev.end.slice(11, 16);

	const setStart = (date: string, time: string) => {
		if (!date || Number.isNaN(parseWall(date))) return;
		const length = parseWall(ev.end) - parseWall(ev.start);
		if (ev.allDay) {
			const s = parseWall(date);
			set({ start: date, end: formatWall(s + Math.max(DAY, length), true) });
		} else {
			const s = parseWall(`${date}T${time || "09:00"}`);
			set({ start: formatWall(s), end: formatWall(s + Math.max(0, length)) });
		}
	};
	const setEnd = (date: string, time: string) => {
		if (!date || Number.isNaN(parseWall(date))) return;
		if (ev.allDay) set({ end: formatWall(parseWall(date) + DAY, true) });
		else set({ end: formatWall(parseWall(`${date}T${time || endTime}`)) });
	};
	const setAllDay = (allDay: boolean) => {
		// Reminders that don't fit the other kind of event are dropped.
		const fits = (choices: readonly number[]) => ev.reminders.filter((m) => choices.includes(m));
		if (allDay) set({ allDay, start: startDate, end: formatWall(Math.max(parseWall(endDate), parseWall(startDate)) + DAY, true), reminders: fits(ALL_DAY_REMINDER_CHOICES) });
		else set({ allDay, start: `${startDate}T09:00`, end: `${startDate}T10:00`, reminders: fits(REMINDER_CHOICES) });
	};

	const weekday = WEEKDAYS[(new Date(parseWall(ev.start)).getUTCDay() + 6) % 7];
	const startMs = parseWall(ev.start);
	const nth = weekOfMonth(startMs);
	const nthWord = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" }[nth as 1];
	const dateWords = new Date(startMs).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
	const presetChoices: [Preset, string][] = [
		["none", copy.repeatNone],
		["daily", "Every day"],
		["weekdays", "Every weekday (Monday to Friday)"],
		["weekly", `Every week on ${LONG_DAYS[weekday]}`],
		["monthly", describeRepeat({ freq: "monthly", interval: 1 }, ev.start)],
		["monthlyWeekday", `Every month on the ${nthWord} ${LONG_DAYS[weekday]}`],
		["yearly", `Every year on ${dateWords}`],
		["custom", copy.repeatCustom],
	];

	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (readOnly) return;
		if (parseWall(ev.end) < parseWall(ev.start) || (ev.allDay && parseWall(ev.end) <= parseWall(ev.start))) {
			setError("The event has to end after it starts.");
			return;
		}
		if (ev.meetingUrl.trim() && !cleanMeetingUrl(ev.meetingUrl)) {
			setError(copy.badMeeting);
			return;
		}
		const repeatChanged = JSON.stringify(ev.repeat) !== JSON.stringify(draft.input.repeat);
		onSave({ ...ev, title: ev.title.trim(), meetingUrl: cleanMeetingUrl(ev.meetingUrl) }, repeatChanged, mayNotify && notify);
	};
	const invited = !!draft.organizer;
	// Only the person who organised an event emails its guests.
	const mayNotify = !invited && !(calendars.find((c) => c.id === ev.calendarId) ?? calendars[0])?.owner && (ev.guests.length > 0 || draft.input.guests.length > 0);
	const meeting = cleanMeetingUrl(ev.meetingUrl);

	const repeat = ev.repeat;
	const setRepeat = (changes: Partial<Repeat>) => set({ repeat: { ...(repeat ?? { freq: "weekly", interval: 1 }), ...changes } });
	const endsMode = repeat?.until ? "on" : repeat?.count ? "after" : "never";
	const cal = calendars.find((c) => c.id === ev.calendarId) ?? calendars[0];
	// A calendar someone shared with you: no guests or reminders.
	const inShared = !!cal?.owner;

	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="lg" className="max-h-[90vh] w-full max-w-xl overflow-y-auto p-5 sm:p-6">
				<Dialog.Title className="mb-4 flex items-center gap-2 text-lg font-semibold">
					{readOnly
						? draft.readOnlyReason === "shared" || draft.readOnlyReason === "guests" || draft.readOnlyReason === "outside" ? <><EyeIcon size={18} /> {copy.eventDetails}</> : <><LockSimpleIcon size={18} /> {copy.busy}</>
						: draft.id ? copy.editEvent : copy.newEvent}
					{!readOnly && draft.id && meeting && (
						<a href={meeting} target="_blank" rel="noopener noreferrer"
							className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-kumo-brand px-3 py-1.5 text-sm font-medium text-white no-underline hover:opacity-90">
							<VideoCameraIcon size={16} weight="fill" /> {joinWords(meeting)}
						</a>
					)}
				</Dialog.Title>
				{invited && !readOnly && (
					<p className="mb-4 rounded-lg bg-kumo-tint px-3 py-2 text-sm text-kumo-default">
						<strong>{fill(copy.invitedBy, { name: draft.organizer!.name || draft.organizer!.email })}</strong>. {copy.invitedNote}
					</p>
				)}
				{readOnly ? (
					<div className="space-y-4">
						{draft.readOnlyReason === "shared" || draft.readOnlyReason === "guests" || draft.readOnlyReason === "outside" ? (
							<>
								<p className="text-xl font-semibold text-kumo-default">{ev.title}</p>
								<p className="text-base text-kumo-strong">{whenWords(ev)}</p>
								{ev.location && <p className="text-base text-kumo-default">{ev.location}</p>}
								{meeting && (
									<a href={meeting} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-kumo-brand px-3 py-1.5 text-sm font-medium text-white no-underline hover:opacity-90">
										<VideoCameraIcon size={16} weight="fill" /> {joinWords(meeting)}
									</a>
								)}
								{ev.notes && <p className="whitespace-pre-wrap text-base text-kumo-default">{ev.notes}</p>}
								<p className="rounded-lg bg-kumo-tint px-3 py-2 text-sm text-kumo-default">
									{draft.readOnlyReason === "outside"
										? fill(copy.outsideReadOnly, { name: draft.calendarName ?? "" })
										: fill(draft.readOnlyReason === "guests" ? copy.sharedGuests : copy.sharedReadOnly, { owner: draft.ownerName ?? copy.someoneElse })}
								</p>
							</>
						) : (
							<>
								<p className="text-base text-kumo-default">
									{draft.readOnlyReason === "busy"
										? fill(copy.sharedBusy, { owner: draft.ownerName ?? copy.someoneElse })
										: fill(copy.someoneElsesPrivate, { name: draft.createdByName || copy.someoneElse })}
								</p>
								<p className="text-base text-kumo-strong">{whenWords(ev)}</p>
							</>
						)}
						<div className="flex justify-end"><Button variant="secondary" onClick={onClose}>{copy.close}</Button></div>
					</div>
				) : (
					<form onSubmit={submit} className="space-y-4">
						<Input label={copy.titleField} placeholder={copy.titlePlaceholder} value={ev.title} onChange={(e) => set({ title: e.target.value })} autoFocus={!draft.id} maxLength={200} />

						<label className="flex items-center gap-3 text-base text-kumo-default">
							<Switch checked={ev.allDay} onCheckedChange={setAllDay} aria-label={copy.allDay} />
							{copy.allDay}
						</label>

						<div className="grid grid-cols-1 gap-3">
							<div>
								<span className={fieldLabel}>{copy.starts}</span>
								<div className="flex gap-2">
									<input type="date" aria-label={`${copy.starts}: date`} className={selectClass} value={startDate} onChange={(e) => setStart(e.target.value, startTime)} required />
									{!ev.allDay && <input type="time" aria-label={`${copy.starts}: time`} className={`${inputBase} w-36 shrink-0`} value={startTime} step={300} onChange={(e) => setStart(startDate, e.target.value)} required />}
								</div>
							</div>
							<div>
								<span className={fieldLabel}>{copy.ends}</span>
								<div className="flex gap-2">
									<input type="date" aria-label={`${copy.ends}: date`} className={selectClass} value={endDate} min={startDate} onChange={(e) => setEnd(e.target.value, endTime)} required />
									{!ev.allDay && <input type="time" aria-label={`${copy.ends}: time`} className={`${inputBase} w-36 shrink-0`} value={endTime} step={300} onChange={(e) => setEnd(endDate, e.target.value)} required />}
								</div>
							</div>
						</div>

						<div>
							<label className={fieldLabel} htmlFor="app-repeat">{copy.repeat}</label>
							<select
								id="app-repeat"
								className={selectClass}
								value={showCustom ? "custom" : preset}
								onChange={(e) => {
									const p = e.target.value as Preset;
									setShowCustom(p === "custom");
									set({ repeat: repeatFor(p, ev.repeat) });
								}}
							>
								{presetChoices.map(([key, words]) => <option key={key} value={key}>{words}</option>)}
							</select>
						</div>

						{repeat && (
							<div className="space-y-3 rounded-lg border border-kumo-line bg-kumo-tint/40 p-3">
								{showCustom && (
									<>
										<div className="flex flex-wrap items-center gap-2 text-base">
											<span>{copy.every}</span>
											<input type="number" min={1} max={99} aria-label={copy.every} className={`${inputBase} w-20`} value={repeat.interval}
												onChange={(e) => setRepeat({ interval: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })} />
											<select aria-label="Unit" className={`${inputBase} w-auto`} value={repeat.freq}
												onChange={(e) => setRepeat({ freq: e.target.value as Repeat["freq"], days: undefined, monthlyBy: e.target.value === "monthly" ? "date" : undefined })}>
												{(["daily", "weekly", "monthly", "yearly"] as const).map((f) => <option key={f} value={f}>{copy.units[f][repeat.interval === 1 ? 0 : 1]}</option>)}
											</select>
										</div>
										{repeat.freq === "weekly" && (
											<fieldset>
												<legend className="mb-1.5 text-base">{copy.onDays}</legend>
												<div className="flex flex-wrap gap-1.5">
													{WEEKDAYS.map((d) => {
														const days = repeat.days?.length ? repeat.days : [weekday];
														const on = days.includes(d);
														return (
															<button key={d} type="button" aria-pressed={on} aria-label={LONG_DAYS[d]}
																onClick={() => {
																	const next = on ? days.filter((x) => x !== d) : [...days, d];
																	if (next.length) setRepeat({ days: WEEKDAYS.filter((x) => next.includes(x)) });
																}}
																className={`h-10 min-w-12 cursor-pointer rounded-full border px-2 text-sm font-medium ${on ? "border-kumo-brand bg-kumo-brand text-white" : "border-kumo-line bg-kumo-base text-kumo-default"}`}>
																{SHORT_DAYS[d]}
															</button>
														);
													})}
												</div>
											</fieldset>
										)}
										{repeat.freq === "monthly" && (
											<select aria-label="Which day" className={selectClass} value={repeat.monthlyBy ?? "date"} onChange={(e) => setRepeat({ monthlyBy: e.target.value as "date" | "weekday" })}>
												<option value="date">{describeRepeat({ freq: "monthly", interval: 1 }, ev.start).replace("Every month on", "On")}</option>
												<option value="weekday">{`On the ${nthWord} ${LONG_DAYS[weekday]}`}</option>
											</select>
										)}
									</>
								)}
								<div className="flex flex-wrap items-center gap-2 text-base">
									<span>{copy.endsField}</span>
									<select aria-label={copy.endsField} className={`${inputBase} w-auto`} value={endsMode}
										onChange={(e) => {
											const v = e.target.value;
											if (v === "never") setRepeat({ until: null, count: null });
											else if (v === "on") setRepeat({ count: null, until: formatWall(parseWall(startDate) + 90 * DAY, true) });
											else setRepeat({ until: null, count: 10 });
										}}>
										<option value="never">{copy.endsNever}</option>
										<option value="on">{copy.endsOn}</option>
										<option value="after">{copy.endsAfter}</option>
									</select>
									{endsMode === "on" && (
										<input type="date" aria-label={copy.endsOn} className={`${inputBase} w-auto`} min={startDate} value={repeat.until ?? ""} onChange={(e) => e.target.value && setRepeat({ until: e.target.value, count: null })} />
									)}
									{endsMode === "after" && (
										<>
											<input type="number" min={1} max={999} aria-label={copy.times} className={`${inputBase} w-24`} value={repeat.count ?? 10} onChange={(e) => setRepeat({ until: null, count: Math.max(1, Math.min(999, Number(e.target.value) || 1)) })} />
											<span>{copy.times}</span>
										</>
									)}
								</div>
								<p className="text-sm text-kumo-strong">{describeRepeat(repeat, ev.start)}</p>
							</div>
						)}

						{calendars.length > 1 && (
							<div>
								<label className={fieldLabel} htmlFor="app-cal">{copy.calendar}</label>
								<select id="app-cal" className={selectClass} value={ev.calendarId} onChange={(e) => set({ calendarId: e.target.value })}>
									{calendars.map((c) => <option key={c.id} value={c.id}>{c.owner ? `${c.name} (${c.ownerName})` : c.name}</option>)}
								</select>
							</div>
						)}
						{inShared && <p className="rounded-lg bg-kumo-tint px-3 py-2 text-sm text-kumo-default">{fill(copy.sharedCalNote, { owner: cal.ownerName ?? copy.someoneElse })}</p>}

						<ColourChoice value={ev.color} calendarColour={cal?.color ?? "blue"} onChange={(color) => set({ color })} />

						<Input label={copy.location} placeholder={copy.locationPlaceholder} value={ev.location} onChange={(e) => set({ location: e.target.value })} maxLength={300} />

						<MeetingLink value={ev.meetingUrl} onChange={(meetingUrl) => set({ meetingUrl })} />

						{!inShared && <Guests value={ev.guests} organizer={draft.organizer ?? null} readOnly={invited} onChange={(guests) => set({ guests })} onProblem={setError} />}
						{mayNotify && !inShared && (
							<label className="flex items-start gap-3 text-base text-kumo-default">
								<Switch checked={notify} onCheckedChange={setNotify} aria-label={copy.emailGuests} className="mt-0.5" />
								<span>
									<span className="flex items-center gap-1.5 font-medium"><EnvelopeSimpleIcon size={16} /> {copy.emailGuests}</span>
									<span className="block text-sm text-kumo-strong">{copy.emailGuestsHint}</span>
								</span>
							</label>
						)}

						<label className="block">
							<span className={fieldLabel}>{copy.notes}</span>
							<textarea value={ev.notes} rows={4} maxLength={10_000} placeholder={copy.notesPlaceholder} onChange={(e) => set({ notes: e.target.value })}
								className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-base text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring" />
						</label>

						{!inShared && <Reminders value={ev.reminders} allDay={ev.allDay} onChange={(reminders) => set({ reminders })} />}

						<label className="flex items-start gap-3 text-base text-kumo-default">
							<Switch checked={ev.private} onCheckedChange={(v) => set({ private: v })} aria-label={copy.private} className="mt-0.5" />
							<span>
								<span className="flex items-center gap-1.5 font-medium"><LockSimpleIcon size={16} /> {copy.private}</span>
								<span className="block text-sm text-kumo-strong">{copy.privateHint}</span>
							</span>
						</label>

						{draft.createdByName && (sharedMailbox || inShared) && <p className="text-sm text-kumo-strong">{fill(copy.createdBy, { name: draft.createdByName })}</p>}
						{error && <p className="text-base text-kumo-danger" role="alert">{error}</p>}

						<div className="flex flex-wrap items-center gap-2 pt-1">
							{draft.id && !confirmDelete && (
								<Button type="button" variant="ghost" className="text-kumo-danger" onClick={() => (draft.isRepeating ? onDelete(mayNotify && notify) : setConfirmDelete(true))} disabled={busy}>{copy.delete}</Button>
							)}
							{confirmDelete && (
								<span className="flex flex-wrap items-center gap-2">
									<span className="text-base">{fill(copy.deleteConfirm, { name: ev.title || "this event" })}</span>
									<Button type="button" variant="destructive" size="sm" onClick={() => onDelete(mayNotify && notify)} disabled={busy}>{copy.delete}</Button>
									<Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>{copy.cancel}</Button>
								</span>
							)}
							<div className="ml-auto flex gap-2">
								<Button type="button" variant="secondary" onClick={onClose}>{copy.cancel}</Button>
								<Button type="submit" variant="primary" loading={busy}>{copy.save}</Button>
							</div>
						</div>
					</form>
				)}
			</Dialog>
		</Dialog.Root>
	);
}

function whenWords(ev: EventInput): string {
	const s = parseWall(ev.start);
	const day = new Date(s).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
	if (ev.allDay) return `${day}, all day`;
	return `${day}, ${ev.start.slice(11, 16)} to ${ev.end.slice(11, 16)}`;
}

function ColourChoice({ value, calendarColour, onChange }: { value: CalendarColor | null; calendarColour: CalendarColor; onChange: (c: CalendarColor | null) => void }) {
	const swatch = (key: CalendarColor | null) => {
		const c = LABEL_COLORS[key ?? calendarColour];
		const selected = key === value;
		const name = key ? c.name : copy.calendarColour;
		return (
			<button key={key ?? "calendar"} type="button" onClick={() => onChange(key)} aria-label={name} aria-pressed={selected} title={name}
				className={`relative flex size-9 cursor-pointer items-center justify-center rounded-full border-0 transition-transform hover:scale-110 ${selected ? "ring-2 ring-offset-2 ring-kumo-ring ring-offset-kumo-base" : ""} ${key ? "" : "outline-2 outline-dashed outline-offset-2 outline-kumo-line"}`}
				style={{ backgroundColor: c.dot, color: c.ink }}>
				{selected && <CheckIcon size={16} weight="bold" />}
			</button>
		);
	};
	return (
		<fieldset>
			<legend className="mb-2 text-base font-medium text-kumo-default">{copy.colour}</legend>
			<div className="flex flex-wrap items-center gap-2.5">
				{swatch(null)}
				<span className="mx-1 h-6 w-px bg-kumo-line" aria-hidden />
				{LABEL_COLOR_KEYS.map((k) => swatch(k))}
			</div>
			<p className="mt-1.5 text-sm text-kumo-strong">{value ? LABEL_COLORS[value].name : copy.calendarColour}</p>
		</fieldset>
	);
}

function Reminders({ value, allDay, onChange }: { value: number[]; allDay: boolean; onChange: (v: number[]) => void }) {
	const choices: readonly number[] = allDay ? ALL_DAY_REMINDER_CHOICES : REMINDER_CHOICES;
	const unused = choices.filter((m) => !value.includes(m));
	return (
		<fieldset>
			<legend className="mb-2 flex items-center gap-1.5 text-base font-medium text-kumo-default"><BellIcon size={16} /> {copy.reminders}</legend>
			<div className="space-y-2">
				{value.map((m, i) => (
					<div key={m} className="flex items-center gap-2">
						<select aria-label={copy.reminders} className={`${inputBase} w-auto`} value={m}
							onChange={(e) => onChange([...new Set(value.map((x, j) => (j === i ? Number(e.target.value) : x)))].sort((a, b) => a - b))}>
							{[m, ...unused].sort((a, b) => a - b).map((c) => <option key={c} value={c}>{describeReminder(c, allDay)}</option>)}
						</select>
						<Button type="button" variant="ghost" shape="square" size="sm" icon={<XIcon size={16} />} aria-label={copy.removeReminder} onClick={() => onChange(value.filter((x) => x !== m))} />
					</div>
				))}
				{value.length < MAX_REMINDERS && unused.length > 0 && (
					<Button type="button" variant="ghost" size="sm" icon={<PlusIcon size={14} />} onClick={() => onChange([...value, unused.find((m) => m >= (allDay ? 1440 : 10)) ?? unused[0]].sort((a, b) => a - b))}>
						{copy.addReminder}
					</Button>
				)}
			</div>
			<p className="mt-1.5 text-sm text-kumo-strong">{copy.remindersHint}</p>
		</fieldset>
	);
}

/** A Teams, Zoom or Meet link pasted in, or a free Jitsi Meet room made with one click. */
function MeetingLink({ value, onChange }: { value: string; onChange: (v: string) => void }) {
	const link = cleanMeetingUrl(value);
	return (
		<div>
			<label className={fieldLabel} htmlFor="app-meeting"><span className="inline-flex items-center gap-1.5"><VideoCameraIcon size={16} /> {copy.meeting}</span></label>
			<div className="flex gap-2">
				<input id="app-meeting" type="url" inputMode="url" className={selectClass} placeholder={copy.meetingPlaceholder} value={value} maxLength={1000}
					onChange={(e) => onChange(e.target.value)} />
				{value && <Button type="button" variant="ghost" shape="square" icon={<XIcon size={16} />} aria-label={copy.removeMeeting} onClick={() => onChange("")} />}
			</div>
			{!value ? (
				<div className="mt-2">
					<Button type="button" variant="secondary" size="sm" icon={<PlusIcon size={14} />} onClick={() => onChange(newJitsiLink())}>{copy.addJitsi}</Button>
					<p className="mt-1.5 text-sm text-kumo-strong">{copy.addJitsiHint}</p>
				</div>
			) : link ? (
				<a href={link} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-flex items-center gap-1.5 text-sm font-medium text-kumo-brand">
					<VideoCameraIcon size={14} /> {joinWords(link)}
				</a>
			) : null}
		</div>
	);
}

const STATUS_DOT: Record<Guest["status"], string> = { accepted: "bg-green-600", tentative: "bg-amber-500", declined: "bg-red-600", "needs-action": "bg-kumo-line" };

/** The guest list: type an address and press Enter (or paste several). Each guest shows how they've answered. */
function Guests({ value, organizer, readOnly, onChange, onProblem }: {
	value: Guest[];
	organizer: Organizer | null;
	readOnly: boolean;
	onChange: (g: Guest[]) => void;
	onProblem: (text: string) => void;
}) {
	const [text, setText] = useState("");
	if (readOnly && value.length === 0 && !organizer) return null;
	const add = () => {
		const parts = text.split(/[\s,;]+/).map((t) => t.replace(/^.*<|>$/g, "").trim()).filter(Boolean);
		if (!parts.length) return;
		const bad = parts.find((p) => cleanGuests([p]).length === 0);
		if (bad) { onProblem(fill(copy.badGuest, { email: bad })); return; }
		onChange(cleanGuests([...value, ...parts]).slice(0, MAX_GUESTS));
		setText("");
	};
	return (
		<fieldset>
			<legend className="mb-2 flex items-center gap-1.5 text-base font-medium text-kumo-default"><UsersIcon size={16} /> {copy.guests}</legend>
			{(value.length > 0 || organizer) && (
				<ul className="mb-2 space-y-1">
					{organizer && (
						<li className="flex items-center gap-2 text-base">
							<span className="size-2.5 shrink-0 rounded-full bg-green-600" aria-hidden />
							<span className="min-w-0 truncate">{organizer.name || organizer.email}</span>
							<span className="shrink-0 text-sm text-kumo-strong">{copy.organiser}</span>
						</li>
					)}
					{value.map((g) => (
						<li key={g.email} className="flex items-center gap-2 text-base">
							<span className={`size-2.5 shrink-0 rounded-full ${STATUS_DOT[g.status]}`} aria-hidden />
							<span className="min-w-0 truncate" title={g.email}>{g.name || g.email}</span>
							<span className="shrink-0 text-sm text-kumo-strong">{copy.status[g.status]}</span>
							{!readOnly && (
								<Button type="button" variant="ghost" shape="square" size="sm" className="ml-auto" icon={<XIcon size={14} />}
									aria-label={fill(copy.removeGuest, { name: g.name || g.email })} onClick={() => onChange(value.filter((x) => x.email !== g.email))} />
							)}
						</li>
					))}
				</ul>
			)}
			{!readOnly && (
				<>
					<div className="flex gap-2">
						<input type="email" multiple aria-label={copy.guests} className={selectClass} placeholder={copy.guestsPlaceholder} value={text}
							onChange={(e) => setText(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
							onBlur={() => text.trim() && add()} />
						<Button type="button" variant="secondary" onClick={add} disabled={!text.trim()}>{copy.addGuest}</Button>
					</div>
					<p className="mt-1.5 text-sm text-kumo-strong">{copy.guestsHint}</p>
				</>
			)}
		</fieldset>
	);
}
