// Mail App: label chips, the Label menu and the window for making or changing a label.

import { Button, Dialog, Input, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import { CheckIcon, PlusIcon, TagIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { LABEL_COLORS, LABEL_COLOR_KEYS, MAX_LABEL_NAME, labelDotColour, labelTagVars, nextLabelColor, type Label, type LabelColor } from "shared/labels";
import { FindBox, useShowMore } from "~/components/ShowMore";
import copy from "~/copy/labels.en-GB.json";
import { useCreateLabel, useDeleteLabel, useLabels, useSetEmailLabels, useUpdateLabel } from "~/queries/labels";
import { ApiError } from "~/services/api";
import type { Email } from "~/types";

const fill = (text: string, name: string) => text.replace("{name}", name);

/** Mail App: the drag type for a label picked up from the sidebar. */
export const LABEL_DRAG_TYPE = "application/x-mail-app-label";

/** True while a label from the sidebar is being dragged over this element. */
export function isLabelDrag(e: React.DragEvent) {
	return e.dataTransfer.types.includes(LABEL_DRAG_TYPE);
}

/**
 * Lets an email take a label dropped on it from the sidebar. Spread `props` on the element
 * and use `over` to highlight it.
 */
export function useLabelDrop(mailboxId: string | undefined, email: Email | undefined) {
	const { data: labels = [] } = useLabels(mailboxId);
	const setLabels = useSetEmailLabels();
	const toast = useKumoToastManager();
	const [over, setOver] = useState(false);
	const props = {
		onDragOver: (e: React.DragEvent) => {
			if (!isLabelDrag(e)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			if (!over) setOver(true);
		},
		onDragLeave: (e: React.DragEvent) => {
			if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
		},
		onDrop: (e: React.DragEvent) => {
			setOver(false);
			const id = e.dataTransfer.getData(LABEL_DRAG_TYPE);
			const label = labels.find((l) => l.id === id);
			if (!label || !mailboxId || !email) return;
			e.preventDefault();
			e.stopPropagation();
			if (email.labels?.includes(id)) return;
			setLabels.mutate({ mailboxId, email, add: [id] }, {
				onSuccess: () => toast.add({ title: fill(copy.added, label.name) }),
				onError: () => toast.add({ title: copy.failed, variant: "error" }),
			});
		},
	};
	return { over, props };
}

/** A coloured dot, used in the sidebar and the Label menu. */
export function LabelDot({ color, className = "" }: { color: string; className?: string }) {
	return <span aria-hidden className={`inline-block size-3 shrink-0 rounded-full ${className}`} style={{ backgroundColor: labelDotColour(color) }} />;
}

/** A label's name on its colour. With onRemove it gets a small cross to take the label off. */
export function LabelChip({ label, onRemove, size = "sm" }: { label: Pick<Label, "name" | "color">; onRemove?: () => void; size?: "sm" | "md" }) {
	const pad = size === "md" ? "px-2 py-0.5 text-xs" : "px-1.5 py-px text-[11px]";
	return (
		<span className={`app-label inline-flex max-w-[10rem] shrink-0 items-center gap-0.5 rounded font-medium leading-4 ${pad}`} style={labelTagVars(label.color) as React.CSSProperties}>
			<span className="truncate">{label.name}</span>
			{onRemove && (
				<button
					type="button"
					onClick={(e) => { e.stopPropagation(); onRemove(); }}
					className="-mr-0.5 ml-0.5 inline-flex cursor-pointer rounded-sm border-0 bg-transparent p-0.5 text-current opacity-80 hover:opacity-100 hover:bg-current/15"
					aria-label={fill(copy.remove, label.name)}
				>
					<XIcon size={10} weight="bold" />
				</button>
			)}
		</span>
	);
}

/** The chips for a list of label ids, in A to Z order. Ids of deleted labels are skipped. */
export function LabelChips({ ids, labels, hideId, onRemove, size }: {
	ids?: string[];
	labels: Label[];
	hideId?: string;
	onRemove?: (label: Label) => void;
	size?: "sm" | "md";
}) {
	const shown = useMemo(() => labels.filter((l) => ids?.includes(l.id) && l.id !== hideId), [ids, labels, hideId]);
	if (shown.length === 0) return null;
	return (
		<>
			{shown.map((l) => <LabelChip key={l.id} label={l} size={size} onRemove={onRemove ? () => onRemove(l) : undefined} />)}
		</>
	);
}

/** Round colour buttons to choose a label's colour. */
function ColourPicker({ value, onChange }: { value: LabelColor; onChange: (c: LabelColor) => void }) {
	return (
		<fieldset>
			<legend className="mb-2 text-sm font-medium text-kumo-default">{copy.colourField}</legend>
			<div className="grid grid-cols-6 gap-2.5 sm:gap-2">
				{LABEL_COLOR_KEYS.map((key) => {
					const c = LABEL_COLORS[key];
					const selected = key === value;
					return (
						<button
							key={key}
							type="button"
							onClick={() => onChange(key)}
							aria-label={c.name}
							aria-pressed={selected}
							title={c.name}
							className={`flex size-9 cursor-pointer items-center justify-center rounded-full border-0 transition-transform hover:scale-110 ${selected ? "ring-2 ring-offset-2 ring-kumo-ring ring-offset-kumo-base" : ""}`}
							style={{ backgroundColor: c.dot, color: c.ink }}
						>
							{selected && <CheckIcon size={16} weight="bold" />}
						</button>
					);
				})}
			</div>
		</fieldset>
	);
}

/**
 * Window to make a new label, or rename, recolour or delete one. `onSaved` gets the new label,
 * so the Label menu can put it straight on the email it was opened from.
 */
export function LabelDialog({ mailboxId, label, open, onOpenChange, onSaved, onDeleted }: {
	mailboxId: string;
	label?: Label | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved?: (label: Label) => void;
	onDeleted?: (label: Label) => void;
}) {
	const { data: labels = [] } = useLabels(mailboxId);
	const createLabel = useCreateLabel();
	const updateLabel = useUpdateLabel();
	const deleteLabel = useDeleteLabel();
	const toast = useKumoToastManager();
	const [name, setName] = useState("");
	const [color, setColor] = useState<LabelColor>("blue");
	const [error, setError] = useState("");

	useEffect(() => {
		if (!open) return;
		setName(label?.name ?? "");
		setColor(label?.color ?? nextLabelColor(labels));
		setError("");
	}, [open, label]); // eslint-disable-line react-hooks/exhaustive-deps

	const busy = createLabel.isPending || updateLabel.isPending || deleteLabel.isPending;
	const onError = (err: unknown) => setError(err instanceof ApiError ? err.message : copy.failed);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return;
		const done = (saved: Label) => { onOpenChange(false); onSaved?.(saved); };
		if (label) updateLabel.mutate({ mailboxId, id: label.id, name: trimmed, color }, { onSuccess: done, onError });
		else createLabel.mutate({ mailboxId, name: trimmed, color }, { onSuccess: done, onError });
	};

	const handleDelete = () => {
		if (!label || !window.confirm(fill(copy.deleteConfirm, label.name))) return;
		deleteLabel.mutate({ mailboxId, id: label.id }, {
			onSuccess: () => { onOpenChange(false); onDeleted?.(label); },
			onError: () => toast.add({ title: copy.failed, variant: "error" }),
		});
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="mb-4 text-base font-semibold">{label ? copy.editLabel : copy.newLabel}</Dialog.Title>
				<form onSubmit={handleSubmit} className="space-y-5">
					<Input
						label={copy.nameField}
						placeholder={copy.namePlaceholder}
						value={name}
						maxLength={MAX_LABEL_NAME}
						onChange={(e) => { setName(e.target.value); setError(""); }}
						autoFocus
						required
					/>
					<ColourPicker value={color} onChange={setColor} />
					<div className="flex items-center gap-2">
						<span className="text-sm text-kumo-subtle">{copy.preview}</span>
						<LabelChip label={{ name: name.trim() || copy.namePlaceholder.replace(/^e\.g\. /, ""), color }} size="md" />
					</div>
					{error && <p className="text-sm text-kumo-danger" role="alert">{error}</p>}
					<div className="flex flex-wrap items-center gap-2">
						{label && (
							<Button type="button" variant="ghost" onClick={handleDelete} disabled={busy} className="text-kumo-danger">
								{copy.delete}
							</Button>
						)}
						<div className="ml-auto flex gap-2">
							<Dialog.Close render={(props) => <Button {...props} variant="secondary">{copy.cancel}</Button>} />
							<Button type="submit" variant="primary" disabled={!name.trim() || busy} loading={createLabel.isPending || updateLabel.isPending}>
								{label ? copy.save : copy.create}
							</Button>
						</div>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

/**
 * The Label button: a menu of every label with a tick by the ones on this conversation.
 * Pressing a label puts it on or takes it off straight away. "New label" makes one and adds it.
 */
export function LabelMenu({ mailboxId, email, compact = false, align = "left" }: {
	mailboxId: string;
	email: Email;
	/** A small icon button, for the hover actions in the email list. */
	compact?: boolean;
	align?: "left" | "right";
}) {
	const { data: labels = [] } = useLabels(mailboxId);
	const setLabels = useSetEmailLabels();
	const toast = useKumoToastManager();
	const [open, setOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const current = new Set(email.labels ?? []);
	// The menu scrolls, so every label stays in it, but a long list gets a Find box.
	const list = useShowMore(labels, { limit: Infinity, text: (l) => l.name });

	useEffect(() => {
		if (!open) return;
		const close = (e: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
		const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
		document.addEventListener("mousedown", close);
		document.addEventListener("touchstart", close);
		document.addEventListener("keydown", esc);
		return () => {
			document.removeEventListener("mousedown", close);
			document.removeEventListener("touchstart", close);
			document.removeEventListener("keydown", esc);
		};
	}, [open]);

	const toggle = (label: Label) => {
		const on = current.has(label.id);
		setLabels.mutate(
			{ mailboxId, email, ...(on ? { remove: [label.id] } : { add: [label.id] }) },
			{ onError: () => toast.add({ title: copy.failed, variant: "error" }) },
		);
	};

	return (
		<div ref={ref} className="relative" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
			<Tooltip content={copy.button} side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={<TagIcon size={compact ? 14 : 18} />}
					onClick={() => setOpen((o) => !o)}
					aria-label={copy.button}
					aria-expanded={open}
				/>
			</Tooltip>
			{open && (
				<div
					className={`absolute top-full z-50 mt-1 w-60 max-w-[calc(100vw-2rem)] rounded-lg border border-kumo-line bg-kumo-elevated py-1 shadow-lg ${align === "right" ? "right-0" : "right-0 md:left-0 md:right-auto"}`}
					role="menu"
				>
					<div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle">{copy.menuTitle}</div>
					<div className="my-1 h-px bg-kumo-line" />
					<FindBox list={list} label={copy.find} className="px-2 pb-1" />
					<div className="max-h-72 overflow-y-auto">
						{labels.length === 0 && <p className="px-3 py-2 text-sm text-kumo-subtle">{copy.none}</p>}
						{list.shown.map((label) => {
							const on = current.has(label.id);
							return (
								<button
									key={label.id}
									type="button"
									role="menuitemcheckbox"
									aria-checked={on}
									onClick={() => toggle(label)}
									className="flex w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3 py-2 text-left text-sm text-kumo-default transition-colors hover:bg-kumo-overlay md:py-1.5"
								>
									<span className={`flex size-4 shrink-0 items-center justify-center rounded border ${on ? "border-transparent bg-kumo-brand text-white" : "border-kumo-line"}`}>
										{on && <CheckIcon size={11} weight="bold" />}
									</span>
									<LabelDot color={label.color} />
									<span className="truncate">{label.name}</span>
								</button>
							);
						})}
					</div>
					<div className="my-1 h-px bg-kumo-line" />
					<button
						type="button"
						onClick={() => { setOpen(false); setCreating(true); }}
						className="flex w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3 py-2 text-left text-sm text-kumo-default transition-colors hover:bg-kumo-overlay md:py-1.5"
					>
						<PlusIcon size={16} className="shrink-0" />
						{copy.newLabel}
					</button>
				</div>
			)}
			<LabelDialog
				mailboxId={mailboxId}
				open={creating}
				onOpenChange={setCreating}
				onSaved={(label) => {
					setLabels.mutate({ mailboxId, email, add: [label.id] });
					toast.add({ title: fill(copy.added, label.name) });
				}}
			/>
		</div>
	);
}

/** Gives `children` the drop handlers from useLabelDrop, for places that render rows in a loop. */
export function LabelDropZone({ mailboxId, email, children }: {
	mailboxId: string | undefined;
	email: Email;
	children: (drop: ReturnType<typeof useLabelDrop>) => React.ReactNode;
}) {
	const drop = useLabelDrop(mailboxId, email);
	return <>{children(drop)}</>;
}
