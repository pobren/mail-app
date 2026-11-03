// Mail App addition (not part of upstream Agentic Inbox).
// The Notes page: ideas, checklists and quick reminders, kept in the mailbox's own database. Pinned notes
// come first. A note saves itself as it's written. ?bin=1 shows the Bin, ?note= opens a note (a
// reminder's notification links here). How notes work is in shared/notes.ts.
import { Button, Loader, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, ArrowLeftIcon, ListChecksIcon, MagnifyingGlassIcon, NotePencilIcon, TrashIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { isEmptyNote, matchesSearch, noteText, sortNotes, type Note, type NoteInput } from "shared/notes";
import { NoteCard, NoteEditor, blankDraft, type NoteDraft } from "~/components/notes/NoteParts";
import copy from "~/copy/notes.en-GB.json";
import { useIsWide } from "~/hooks/useIsWide";
import { useUIStore } from "~/hooks/useUIStore";
import { useNoteChange, useNotes } from "~/queries/notes";
import api from "~/services/api";

const SAVE_AFTER_MS = 700;

const inputOf = (d: NoteDraft): NoteInput => ({
	title: d.title, body: d.body, items: d.items, checklist: d.checklist, colour: d.colour, pinned: d.pinned, shared: d.shared, remindAt: d.remindAt,
});

const errorWords = (e: unknown) => (e as { body?: { error?: string } }).body?.error || copy.failed;

export default function NotesRoute() {
	const { mailboxId = "" } = useParams<{ mailboxId: string }>();
	const [params, setParams] = useSearchParams();
	const inBin = params.get("bin") === "1";
	const openId = params.get("note");
	const [query, setQuery] = useState("");
	const toast = useKumoToastManager();
	const navigate = useNavigate();
	const wide = useIsWide();
	const { startCompose } = useUIStore();

	const list = useNotes(mailboxId, inBin);
	const change = useNoteChange(mailboxId, (fn: () => Promise<unknown>) => fn());
	const sharedMailbox = list.data?.sharedMailbox ?? false;
	const notes = useMemo(() => sortNotes((list.data?.notes ?? []).filter((n) => matchesSearch(n, query))), [list.data, query]);
	const pinned = inBin ? [] : notes.filter((n) => n.pinned);
	const others = inBin ? notes : notes.filter((n) => !n.pinned);

	// ── Editing, saved as you go ───────────────────────────────────

	const [editing, setEditing] = useState<NoteDraft | null>(null);
	// Stays the same while one note is open, even once a new note is given its id.
	const [editKey, setEditKey] = useState(0);
	const [saving, setSaving] = useState(false);
	const latest = useRef<NoteDraft | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const inFlight = useRef<Promise<void>>(Promise.resolve());
	const dirty = useRef(false);

	const save = useCallback((): Promise<void> => {
		if (timer.current) { clearTimeout(timer.current); timer.current = null; }
		// One save at a time, so a new note is only made once.
		inFlight.current = inFlight.current.then(async () => {
			const d = latest.current;
			if (!d || !dirty.current) return;
			if (!d.id && isEmptyNote(d)) return;
			dirty.current = false;
			setSaving(true);
			try {
				if (d.id) {
					await api.updateNote(mailboxId, d.id, inputOf(d));
				} else {
					const made = await api.createNote(mailboxId, inputOf(d));
					if (latest.current) latest.current = { ...latest.current, id: made.id };
					setEditing((e) => (e && !e.id ? { ...e, id: made.id } : e));
				}
			} catch (e) {
				dirty.current = true;
				toast.add({ title: errorWords(e), variant: "error" });
			} finally {
				setSaving(false);
			}
		});
		return inFlight.current;
	}, [mailboxId, toast]);

	const edit = (d: NoteDraft) => {
		latest.current = d;
		dirty.current = false;
		setEditKey((k) => k + 1);
		setEditing(d);
	};

	const onChange = (d: NoteDraft) => {
		latest.current = { ...d, id: d.id ?? latest.current?.id };
		dirty.current = true;
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => { void save(); }, SAVE_AFTER_MS);
	};

	const close = async () => {
		// Empty lines left in a checklist go when it's closed.
		const d = latest.current;
		if (d?.items.some((i) => !i.text.trim())) {
			latest.current = { ...d, items: d.items.filter((i) => i.text.trim()) };
			dirty.current = true;
		}
		await save();
		latest.current = null;
		setEditing(null);
		if (openId) setParams((p) => { const n = new URLSearchParams(p); n.delete("note"); return n; }, { replace: true });
		change.mutate(async () => undefined);
	};

	// Save before the page is left with a change still waiting.
	useEffect(() => () => { if (dirty.current) void save(); }, [save]);

	// A link to one note (from a reminder) opens it.
	useEffect(() => {
		if (!openId || editing || !list.data) return;
		const n = list.data.notes.find((x) => x.id === openId);
		if (n) edit(n);
	}, [openId, list.data, editing]);

	// ── Acting on notes ────────────────────────────────────────────

	const run = (fn: () => Promise<unknown>, done?: string) =>
		change.mutateAsync(fn).then(() => { if (done) toast.add({ title: done }); }).catch((e) => toast.add({ title: errorWords(e), variant: "error" }));

	const tick = (note: Note, itemId: string, done: boolean) =>
		run(() => api.updateNote(mailboxId, note.id, { items: note.items.map((i) => (i.id === itemId ? { ...i, done } : i)) }));

	const remove = async () => {
		const d = latest.current;
		if (timer.current) { clearTimeout(timer.current); timer.current = null; }
		await save();
		const id = latest.current?.id ?? d?.id;
		latest.current = null;
		setEditing(null);
		if (id) await run(() => api.binNotes(mailboxId, [id]), copy.deleted);
	};

	const email = (d: NoteDraft) => {
		const text = noteText({ ...d, title: "" });
		const subject = d.title.trim();
		void close();
		if (wide) startCompose({ mode: "new", originalEmail: null, subject, text });
		else navigate(`/mailbox/${mailboxId}/emails/inbox`, { state: { composeSubject: subject, composeText: text } });
	};

	const copyText = async (d: NoteDraft) => {
		try {
			await navigator.clipboard.writeText(noteText(d));
			toast.add({ title: copy.copied });
		} catch {
			toast.add({ title: copy.failed, variant: "error" });
		}
	};

	const emptyBin = () => {
		if (!window.confirm(copy.emptyBinConfirm)) return;
		void run(() => api.deleteNotesForever(mailboxId, "all"));
	};

	const go = (bin: boolean) => {
		setQuery("");
		setParams(bin ? { bin: "1" } : {});
	};

	const cards = (items: Note[]) => (
		<div className="columns-1 gap-3 sm:columns-2 lg:columns-3 xl:columns-4">
			{items.map((n) => (
				<NoteCard
					key={n.id}
					note={n}
					onOpen={() => (inBin ? undefined : edit(n))}
					onTick={inBin ? undefined : (itemId, done) => tick(n, itemId, done)}
					actions={inBin ? (
						<>
							<Button variant="secondary" size="sm" icon={<ArrowCounterClockwiseIcon size={14} />} onClick={() => run(() => api.restoreNotes(mailboxId, [n.id]), copy.restored)}>{copy.restore}</Button>
							<Button variant="secondary" size="sm" icon={<TrashIcon size={14} />}
								onClick={() => { if (window.confirm(copy.deleteForeverConfirm)) void run(() => api.deleteNotesForever(mailboxId, [n.id])); }}>{copy.deleteForever}</Button>
						</>
					) : undefined}
				/>
			))}
		</div>
	);

	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6">
				<div className="mx-auto max-w-6xl">
					<div className="mb-1 flex flex-wrap items-center justify-between gap-3">
						<div className="flex min-w-0 items-center gap-2">
							{inBin && <Button variant="ghost" shape="square" size="sm" icon={<ArrowLeftIcon size={18} />} aria-label={copy.backToNotes} onClick={() => go(false)} />}
							<h1 className="truncate text-2xl font-semibold text-kumo-default">{inBin ? copy.binTitle : copy.title}</h1>
						</div>
						{inBin ? (
							(list.data?.notes.length ?? 0) > 0 && <Button variant="secondary" size="sm" icon={<TrashIcon size={14} />} onClick={emptyBin}>{copy.emptyBin}</Button>
						) : (
							<div className="flex gap-2">
								<Tooltip content={copy.bin} side="bottom" asChild>
									<Button variant="ghost" shape="square" size="sm" icon={<TrashIcon size={18} />} aria-label={copy.bin} onClick={() => go(true)} />
								</Tooltip>
								<Button variant="secondary" size="sm" icon={<ListChecksIcon size={16} />} onClick={() => edit(blankDraft(true))}>
									<span className="hidden sm:inline">{copy.newChecklist}</span>
								</Button>
								<Button variant="primary" size="sm" icon={<NotePencilIcon size={16} />} onClick={() => edit(blankDraft(false))}>{copy.newNote}</Button>
							</div>
						)}
					</div>
					<p className="mb-4 max-w-2xl text-sm text-kumo-subtle">{inBin ? copy.binIntro : sharedMailbox ? copy.introShared : copy.intro}</p>

					{!inBin && (list.data?.notes.length ?? 0) > 0 && (
						<div className="relative mb-4">
							<MagnifyingGlassIcon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-subtle" />
							<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={copy.search} aria-label={copy.search}
								className="w-full rounded-lg border border-kumo-line bg-kumo-base py-2 pl-9 pr-3 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring" />
						</div>
					)}

					{list.isLoading ? (
						<div className="flex justify-center py-16"><Loader /></div>
					) : notes.length === 0 ? (
						<div className="mx-auto max-w-md py-16 text-center">
							{inBin ? (
								<p className="text-sm text-kumo-subtle">{copy.binEmpty}</p>
							) : query ? (
								<p className="text-sm text-kumo-subtle">{copy.noMatch}</p>
							) : (
								<>
									<NotePencilIcon size={40} className="mx-auto mb-3 text-kumo-subtle" />
									<h2 className="mb-1 text-lg font-semibold text-kumo-default">{copy.emptyTitle}</h2>
									<p className="mb-4 text-sm text-kumo-subtle">{copy.emptyText}</p>
									<Button variant="primary" size="sm" icon={<NotePencilIcon size={16} />} onClick={() => edit(blankDraft(false))}>{copy.newNote}</Button>
								</>
							)}
						</div>
					) : (
						<>
							{pinned.length > 0 && (
								<>
									<h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-kumo-subtle">{copy.pinned}</h2>
									{cards(pinned)}
									{others.length > 0 && <h2 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-kumo-subtle">{copy.others}</h2>}
								</>
							)}
							{cards(others)}
						</>
					)}
				</div>
			</div>

			{editing && (
				<NoteEditor
					key={editKey}
					draft={editing}
					sharedMailbox={sharedMailbox}
					onChange={onChange}
					onClose={() => { void close(); }}
					onDelete={remove}
					onEmail={email}
					onCopy={copyText}
					saving={saving}
				/>
			)}
		</div>
	);
}
