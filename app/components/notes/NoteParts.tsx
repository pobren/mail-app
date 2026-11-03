// Mail App addition (not part of upstream Agentic Inbox).
// The parts of the Notes page: a note's card in the grid, the editor it opens in (text or a checklist,
// with colour, pin, reminder and sharing), and the Remind me box. Words are in app/copy/notes.en-GB.json.

import { Button, Dialog, DropdownMenu, Input, Switch, Tooltip } from "@cloudflare/kumo";
import {
	ArrowLeftIcon, BellSimpleIcon, BellSimpleSlashIcon, CalendarBlankIcon, CaretDownIcon, CaretRightIcon, CheckIcon, ClockIcon, CopyIcon,
	DotsThreeVerticalIcon, EnvelopeSimpleIcon, ListChecksIcon, PaletteIcon, PlusIcon, PushPinIcon, SunHorizonIcon, SunIcon,
	TextAlignLeftIcon, TrashIcon, UsersThreeIcon, XIcon,
} from "@phosphor-icons/react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { NOTE_COLOURS, toChecklist, toText, type ChecklistItem, type Note, type NoteColour } from "shared/notes";
import { formatWhen, snoozeChoices, type SnoozeChoice } from "shared/reminders";
import copy from "~/copy/notes.en-GB.json";
import { fill } from "~/lib/attachments";

/** A card's colour, and the swatch for picking it. Light and dark. */
export const COLOUR_CLASSES: Record<NoteColour, { card: string; swatch: string }> = {
	none: { card: "bg-kumo-base border-kumo-line", swatch: "bg-kumo-base border-kumo-line" },
	yellow: { card: "bg-amber-50 border-amber-200 dark:bg-amber-950/50 dark:border-amber-900", swatch: "bg-amber-200 border-amber-300 dark:bg-amber-800" },
	green: { card: "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/50 dark:border-emerald-900", swatch: "bg-emerald-200 border-emerald-300 dark:bg-emerald-800" },
	blue: { card: "bg-sky-50 border-sky-200 dark:bg-sky-950/50 dark:border-sky-900", swatch: "bg-sky-200 border-sky-300 dark:bg-sky-800" },
	pink: { card: "bg-rose-50 border-rose-200 dark:bg-rose-950/50 dark:border-rose-900", swatch: "bg-rose-200 border-rose-300 dark:bg-rose-800" },
	purple: { card: "bg-violet-50 border-violet-200 dark:bg-violet-950/50 dark:border-violet-900", swatch: "bg-violet-200 border-violet-300 dark:bg-violet-800" },
	grey: { card: "bg-slate-100 border-slate-200 dark:bg-slate-800/60 dark:border-slate-700", swatch: "bg-slate-300 border-slate-400 dark:bg-slate-600" },
};

/** What the editor works on: a note, or a new one not saved yet (no id). */
export type NoteDraft = Pick<Note, "title" | "body" | "items" | "checklist" | "colour" | "pinned" | "shared" | "remindAt"> & {
	id?: string;
	reminded?: boolean;
	mine?: boolean;
	ownerName?: string;
	updatedAt?: string;
};

export const blankDraft = (checklist: boolean): NoteDraft => ({
	title: "", body: "", items: checklist ? [newItem()] : [], checklist, colour: "none", pinned: false, shared: false, remindAt: null, mine: true,
});

function newItem(text = ""): ChecklistItem {
	return { id: `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, text, done: false };
}

/** "Reminder tomorrow at 08:00", or "Reminder sent today at 08:00" once it's gone. */
export function reminderLine(n: Pick<NoteDraft, "remindAt" | "reminded">): string | null {
	if (n.remindAt === null) return null;
	return fill(n.reminded ? copy.remindSent : copy.remindAt, { when: formatWhen(n.remindAt) });
}

// ── The card in the grid ─────────────────────────────────────────

const MAX_CARD_ITEMS = 8;

export function NoteCard({ note, onOpen, onTick, actions }: {
	note: Note;
	onOpen: () => void;
	/** Ticks a checklist item straight from the card. Left out in the Bin. */
	onTick?: (itemId: string, done: boolean) => void;
	actions?: ReactNode;
}) {
	const written = note.items.filter((i) => i.text.trim());
	const open = note.checklist ? written.filter((i) => !i.done) : [];
	const ticked = note.checklist ? written.length - open.length : 0;
	const remind = reminderLine(note);
	const title = note.title.trim();
	return (
		<article className={`group relative mb-3 break-inside-avoid rounded-xl border p-3 shadow-sm transition-shadow hover:shadow-md ${COLOUR_CLASSES[note.colour].card}`}>
			<button type="button" onClick={onOpen} aria-label={fill(copy.open, { title: title || copy.untitled })}
				className="absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring" />
			<div className="pointer-events-none relative">
				<div className="flex items-start gap-2">
					{title && <h3 className="min-w-0 flex-1 break-words text-[15px] font-semibold text-kumo-default">{title}</h3>}
					{note.pinned && <PushPinIcon size={16} weight="fill" className="ml-auto shrink-0 text-kumo-subtle" aria-label={copy.pinned} />}
				</div>
				{note.checklist ? (
					<ul className="mt-1 space-y-1">
						{open.slice(0, MAX_CARD_ITEMS).map((i) => (
							<li key={i.id} className="flex items-start gap-2 text-sm text-kumo-default">
								{onTick ? (
									<input type="checkbox" checked={false} onChange={() => onTick(i.id, true)} aria-label={fill(copy.tick, { text: i.text })}
										className="pointer-events-auto relative mt-0.5 size-4 shrink-0 accent-[var(--color-kumo-brand)]" />
								) : <span className="mt-0.5 size-4 shrink-0 rounded border border-kumo-line" />}
								<span className="min-w-0 break-words">{i.text}</span>
							</li>
						))}
						{open.length > MAX_CARD_ITEMS && <li className="text-xs text-kumo-subtle">+{open.length - MAX_CARD_ITEMS}</li>}
						{ticked > 0 && <li className="pt-0.5 text-xs text-kumo-subtle">{ticked === 1 ? copy.doneItemOne : fill(copy.doneItems, { count: ticked })}</li>}
					</ul>
				) : (
					note.body.trim() && <p className="mt-1 line-clamp-[10] whitespace-pre-wrap break-words text-sm text-kumo-default">{note.body}</p>
				)}
				{!title && !note.body.trim() && !note.items.some((i) => i.text.trim()) && <p className="text-sm italic text-kumo-subtle">{copy.untitled}</p>}
				{(remind || note.shared) && (
					<div className="mt-2 flex flex-wrap gap-1.5">
						{remind && (
							<span className={`inline-flex items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10 ${note.reminded ? "text-kumo-subtle line-through" : "text-kumo-default"}`}>
								<BellSimpleIcon size={12} /> {remind.replace(/^Reminder (sent )?/, "")}
							</span>
						)}
						{note.shared && (
							<span className="inline-flex items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-xs text-kumo-default dark:bg-white/10">
								<UsersThreeIcon size={12} /> {note.mine ? copy.sharedYoursShort : fill(copy.sharedBy, { name: note.ownerName || note.ownerEmail })}
							</span>
						)}
					</div>
				)}
			</div>
			{actions && <div className="relative mt-2 flex justify-end gap-1">{actions}</div>}
		</article>
	);
}

// ── The editor ───────────────────────────────────────────────────

export function NoteEditor({ draft: start, sharedMailbox, onChange, onClose, onDelete, onEmail, onCopy, saving }: {
	draft: NoteDraft;
	sharedMailbox: boolean;
	/** Every change, as it's made; the page saves them. */
	onChange: (draft: NoteDraft) => void;
	onClose: () => void;
	onDelete?: () => void;
	onEmail: (draft: NoteDraft) => void;
	onCopy: (draft: NoteDraft) => void;
	saving: boolean;
}) {
	const [draft, setDraft] = useState(start);
	const [showTicked, setShowTicked] = useState(false);
	const [reminding, setReminding] = useState(false);
	const [focusId, setFocusId] = useState<string | null>(null);
	const itemRefs = useRef(new Map<string, HTMLInputElement>());

	const set = (patch: Partial<NoteDraft>) => {
		setDraft((d) => {
			const next = { ...d, ...patch };
			onChange(next);
			return next;
		});
	};
	// A note just made gets its id from the page; keep it, so later changes save to the same note.
	useEffect(() => { if (start.id && !draft.id) setDraft((d) => ({ ...d, id: start.id })); }, [start.id, draft.id]);
	useEffect(() => {
		if (!focusId) return;
		itemRefs.current.get(focusId)?.focus();
		setFocusId(null);
	}, [focusId, draft.items]);

	const setItem = (id: string, patch: Partial<ChecklistItem>) => set({ items: draft.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
	const removeItem = (id: string) => {
		const at = draft.items.findIndex((i) => i.id === id);
		const rest = draft.items.filter((i) => i.id !== id);
		set({ items: rest });
		const before = rest.filter((i) => !i.done)[Math.max(0, at - 1)];
		if (before) setFocusId(before.id);
	};
	const addItemAfter = (id: string | null) => {
		const item = newItem();
		const items = [...draft.items];
		const at = id ? items.findIndex((i) => i.id === id) + 1 : items.filter((i) => !i.done).length;
		items.splice(at, 0, item);
		set({ items });
		setFocusId(item.id);
	};
	const itemKeys = (e: KeyboardEvent<HTMLInputElement>, item: ChecklistItem) => {
		if (e.key === "Enter") { e.preventDefault(); addItemAfter(item.id); }
		if (e.key === "Backspace" && !item.text) { e.preventDefault(); removeItem(item.id); }
	};
	const switchKind = () => set(draft.checklist
		? { checklist: false, body: [draft.body, toText(draft.items)].filter((t) => t.trim()).join("\n"), items: [] }
		: { checklist: true, items: toChecklist(draft.body).length ? toChecklist(draft.body) : [newItem()], body: "" });

	const openItems = draft.items.filter((i) => !i.done);
	const tickedItems = draft.items.filter((i) => i.done);
	const remind = reminderLine(draft);
	const canShare = sharedMailbox && draft.mine !== false;

	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="sm" className={`flex max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-xl flex-col sm:w-full sm:min-w-[32rem] overflow-hidden border p-0 ${COLOUR_CLASSES[draft.colour].card}`}>
				<Dialog.Title className="sr-only">{draft.title || copy.untitled}</Dialog.Title>
				{reminding ? (
					<RemindPanel at={draft.reminded ? null : draft.remindAt} onClose={() => setReminding(false)}
						onSet={(at) => { set({ remindAt: at, reminded: false }); setReminding(false); }} />
				) : (<>
				<div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 pt-5">
					<div className="flex items-start gap-2">
						<input value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder={copy.titlePlaceholder} aria-label={copy.titlePlaceholder} maxLength={200}
							className="min-w-0 flex-1 bg-transparent text-lg font-semibold text-kumo-default placeholder:text-kumo-subtle focus:outline-none" />
						<Tooltip content={draft.pinned ? copy.unpin : copy.pin} side="bottom" asChild>
							<Button variant="ghost" shape="square" size="sm" aria-label={draft.pinned ? copy.unpin : copy.pin} aria-pressed={draft.pinned}
								icon={<PushPinIcon size={18} weight={draft.pinned ? "fill" : "regular"} />} onClick={() => set({ pinned: !draft.pinned })} />
						</Tooltip>
					</div>

					{draft.checklist ? (
						<div className="mt-3">
							<ul className="space-y-1">
								{openItems.map((item) => (
									<li key={item.id} className="group/item flex items-center gap-2">
										<input type="checkbox" checked={false} onChange={() => setItem(item.id, { done: true })} aria-label={fill(copy.tick, { text: item.text || copy.itemPlaceholder })}
											className="size-4 shrink-0 accent-[var(--color-kumo-brand)]" />
										<input ref={(el) => { if (el) itemRefs.current.set(item.id, el); else itemRefs.current.delete(item.id); }}
											value={item.text} onChange={(e) => setItem(item.id, { text: e.target.value })} onKeyDown={(e) => itemKeys(e, item)} maxLength={500}
											placeholder={copy.itemPlaceholder} aria-label={copy.itemPlaceholder}
											className="min-w-0 flex-1 bg-transparent py-1 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none" />
										<button type="button" onClick={() => removeItem(item.id)} aria-label={fill(copy.removeItem, { text: item.text || copy.itemPlaceholder })}
											className="rounded p-1 text-kumo-subtle opacity-60 hover:bg-black/5 hover:opacity-100 sm:opacity-0 sm:group-hover/item:opacity-100 sm:focus:opacity-100 dark:hover:bg-white/10">
											<XIcon size={14} />
										</button>
									</li>
								))}
							</ul>
							<button type="button" onClick={() => addItemAfter(null)} className="mt-1 flex items-center gap-2 rounded py-1 text-sm text-kumo-strong hover:text-kumo-default">
								<PlusIcon size={16} /> {copy.addItem}
							</button>
							{tickedItems.length > 0 && (
								<div className="mt-3 border-t border-black/10 pt-2 dark:border-white/10">
									<button type="button" onClick={() => setShowTicked((v) => !v)} aria-expanded={showTicked}
										className="flex items-center gap-1 text-xs font-medium text-kumo-subtle hover:text-kumo-default">
										{showTicked ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
										{tickedItems.length === 1 ? copy.doneItemOne : fill(copy.doneItems, { count: tickedItems.length })}
									</button>
									{showTicked && (
										<ul className="mt-1 space-y-1">
											{tickedItems.map((item) => (
												<li key={item.id} className="flex items-center gap-2">
													<input type="checkbox" checked onChange={() => setItem(item.id, { done: false })} aria-label={fill(copy.tick, { text: item.text })}
														className="size-4 shrink-0 accent-[var(--color-kumo-brand)]" />
													<span className="min-w-0 flex-1 break-words py-1 text-sm text-kumo-subtle line-through">{item.text}</span>
													<button type="button" onClick={() => removeItem(item.id)} aria-label={fill(copy.removeItem, { text: item.text })}
														className="rounded p-1 text-kumo-subtle hover:bg-black/5 dark:hover:bg-white/10">
														<XIcon size={14} />
													</button>
												</li>
											))}
										</ul>
									)}
								</div>
							)}
						</div>
					) : (
						<textarea value={draft.body} onChange={(e) => set({ body: e.target.value })} placeholder={copy.bodyPlaceholder} aria-label={copy.bodyPlaceholder}
							maxLength={20_000} rows={Math.min(18, Math.max(6, draft.body.split("\n").length + 1))} autoFocus={!start.id && !draft.title}
							className="mt-3 w-full resize-none bg-transparent text-sm leading-relaxed text-kumo-default placeholder:text-kumo-subtle focus:outline-none" />
					)}

					{(remind || (draft.shared && !canShare)) && (
						<div className="mt-3 flex flex-wrap gap-1.5">
							{remind && (
								<button type="button" onClick={() => setReminding(true)}
									className={`inline-flex items-center gap-1 rounded-full bg-black/5 px-2.5 py-1 text-xs hover:bg-black/10 dark:bg-white/10 ${draft.reminded ? "text-kumo-subtle" : "text-kumo-default"}`}>
									<BellSimpleIcon size={12} /> {remind}
								</button>
							)}
							{draft.shared && !canShare && (
								<span className="inline-flex items-center gap-1 rounded-full bg-black/5 px-2.5 py-1 text-xs text-kumo-default dark:bg-white/10">
									<UsersThreeIcon size={12} /> {draft.mine === false ? fill(copy.sharedBy, { name: draft.ownerName ?? "" }) : copy.sharedYours}
								</span>
							)}
						</div>
					)}

					{canShare && (
						<label className="mt-4 flex items-start gap-3 rounded-lg bg-black/5 p-3 dark:bg-white/5">
							<Switch checked={draft.shared} onCheckedChange={(v) => set({ shared: v })} aria-label={copy.share} className="mt-0.5" />
							<span>
								<span className="block text-sm font-medium text-kumo-default">{copy.share}</span>
								<span className="block text-xs text-kumo-subtle">{copy.shareHint}</span>
							</span>
						</label>
					)}
				</div>

				{/* The bar along the bottom */}
				<div className="flex items-center gap-1 border-t border-black/10 px-3 py-2 dark:border-white/10">
					<Tooltip content={copy.remind} side="top" asChild>
						<Button variant="ghost" shape="square" size="sm" aria-label={copy.remind} icon={<BellSimpleIcon size={18} weight={draft.remindAt && !draft.reminded ? "fill" : "regular"} />} onClick={() => setReminding(true)} />
					</Tooltip>
					<DropdownMenu>
						<DropdownMenu.Trigger>
							<Button variant="ghost" shape="square" size="sm" aria-label={copy.colour} title={copy.colour} icon={<PaletteIcon size={18} />} />
						</DropdownMenu.Trigger>
						<DropdownMenu.Content>
							<div className="flex gap-1.5 p-2" role="group" aria-label={copy.colour}>
								{NOTE_COLOURS.map((c) => (
									<button key={c} type="button" onClick={() => set({ colour: c })} aria-label={copy.colours[c]} title={copy.colours[c]} aria-pressed={draft.colour === c}
										className={`flex size-7 items-center justify-center rounded-full border ${COLOUR_CLASSES[c].swatch} ${draft.colour === c ? "ring-2 ring-kumo-brand ring-offset-1" : ""}`}>
										{draft.colour === c && <CheckIcon size={14} className="text-kumo-default" />}
									</button>
								))}
							</div>
						</DropdownMenu.Content>
					</DropdownMenu>
					<Tooltip content={draft.checklist ? copy.toText : copy.toChecklist} side="top" asChild>
						<Button variant="ghost" shape="square" size="sm" aria-label={draft.checklist ? copy.toText : copy.toChecklist}
							icon={draft.checklist ? <TextAlignLeftIcon size={18} /> : <ListChecksIcon size={18} />} onClick={switchKind} />
					</Tooltip>
					<DropdownMenu>
						<DropdownMenu.Trigger>
							<Button variant="ghost" shape="square" size="sm" aria-label={copy.more} title={copy.more} icon={<DotsThreeVerticalIcon size={18} weight="bold" />} />
						</DropdownMenu.Trigger>
						<DropdownMenu.Content>
							<DropdownMenu.Item icon={EnvelopeSimpleIcon} onClick={() => onEmail(draft)}>{copy.email}</DropdownMenu.Item>
							<DropdownMenu.Item icon={CopyIcon} onClick={() => onCopy(draft)}>{copy.copy}</DropdownMenu.Item>
							{onDelete && <DropdownMenu.Item icon={TrashIcon} onClick={onDelete}>{copy.delete}</DropdownMenu.Item>}
						</DropdownMenu.Content>
					</DropdownMenu>
					<span className="ml-auto mr-2 text-xs text-kumo-subtle" aria-live="polite">{saving ? copy.saving : ""}</span>
					<Button variant="primary" size="sm" icon={<CheckIcon size={16} />} onClick={onClose}>{copy.done}</Button>
				</div>
				</>)}
			</Dialog>
		</Dialog.Root>
	);
}

// ── Remind me ────────────────────────────────────────────────────

const CHOICE_ICONS: Record<SnoozeChoice["id"], ReactNode> = {
	later: <ClockIcon size={18} />,
	tomorrow: <SunHorizonIcon size={18} />,
	weekend: <SunIcon size={18} />,
	"next-week": <CalendarBlankIcon size={18} />,
};

const choiceTime = (c: SnoozeChoice) =>
	c.at.toLocaleString("en-GB", { ...(c.id === "later" ? {} : { weekday: "short" }), hour: "2-digit", minute: "2-digit" }).replace(",", "");

function localInput(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Shown in the editor in place of the note while a reminder time is picked. */
function RemindPanel({ at, onSet, onClose }: { at: number | null; onSet: (at: number | null) => void; onClose: () => void }) {
	const [choices] = useState(() => snoozeChoices());
	const [custom, setCustom] = useState(() => localInput(new Date(at ?? Date.now() + 3_600_000)));
	const customAt = new Date(custom).getTime();
	const customOk = Number.isFinite(customAt) && customAt > Date.now();
	return (
		<div className="min-h-0 flex-1 overflow-y-auto p-5">
			<h2 className="mb-1 text-base font-semibold text-kumo-default">{copy.remindTitle}</h2>
			<p className="mb-3 text-xs text-kumo-subtle">{copy.remindHint}</p>
			<div className="space-y-1">
				{choices.map((c) => (
					<button key={c.id} type="button" onClick={() => onSet(c.at.getTime())}
						className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-kumo-default hover:bg-black/5 dark:hover:bg-white/10">
						{CHOICE_ICONS[c.id]}
						<span className="flex-1">{copy.remindChoices[c.id]}</span>
						<span className="text-xs text-kumo-subtle">{choiceTime(c)}</span>
					</button>
				))}
			</div>
			<div className="mt-3 border-t border-black/10 pt-3 dark:border-white/10">
				<label className="mb-1 block text-xs font-medium text-kumo-strong" htmlFor="note-remind-at">{copy.remindCustom}</label>
				<div className="flex flex-wrap gap-2">
					<Input id="note-remind-at" type="datetime-local" value={custom} min={localInput(new Date())} onChange={(e) => setCustom(e.target.value)} className="min-w-0 flex-1" />
					<Button variant="primary" size="sm" icon={<BellSimpleIcon size={16} />} disabled={!customOk} onClick={() => onSet(customAt)}>{copy.remindSet}</Button>
				</div>
			</div>
			<div className="mt-4 flex justify-between gap-2">
				{at !== null ? (
					<Button variant="secondary" size="sm" icon={<BellSimpleSlashIcon size={16} />} onClick={() => onSet(null)}>{copy.remindOff}</Button>
				) : <span />}
				<Button variant="secondary" size="sm" icon={<ArrowLeftIcon size={16} />} onClick={onClose}>{copy.backToNote}</Button>
			</div>
		</div>
	);
}
