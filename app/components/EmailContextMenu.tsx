// Mail App: the menu that opens when you right-click an email in the list, or press and hold it on a phone.

import { useKumoToastManager } from "@cloudflare/kumo";
import { CaretLeftIcon, CaretRightIcon, CheckIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Label } from "shared/labels";
import { LabelDot } from "~/components/Labels";
import copy from "~/copy/labels.en-GB.json";
import { useSetEmailLabels } from "~/queries/labels";
import type { Email, Folder } from "~/types";

export type MenuItem =
	| { kind: "item"; label: string; icon: React.ReactNode; onSelect: () => void; danger?: boolean }
	| { kind: "move"; label: string; icon: React.ReactNode; folders: Folder[]; onMove: (folderId: string) => void }
	| { kind: "labels"; label: string; icon: React.ReactNode; mailboxId: string; email: Email; labels: Label[] }
	| { kind: "separator" };

/** Where a right-click (or a press and hold) happened. */
export interface MenuPoint { x: number; y: number }

const ROW = "flex w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3 py-2.5 text-left text-sm text-kumo-default transition-colors hover:bg-kumo-overlay focus:bg-kumo-overlay focus:outline-none md:py-1.5";

/** How long a finger has to stay down before the menu opens. */
const HOLD_MS = 500;

/**
 * Press and hold on touch screens, for a list of rows. Spread `bind(key)` on each row;
 * `opened()` is true for the tap that follows a hold, so the row's click can ignore it.
 */
export function useLongPress<K>(onHold: (point: MenuPoint, key: K) => void) {
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const start = useRef<MenuPoint | null>(null);
	const held = useRef(false);
	const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
	useEffect(() => cancel, []);
	return {
		opened: () => { const was = held.current; held.current = false; return was; },
		bind: (key: K) => ({
			onTouchStart: (e: React.TouchEvent) => {
				cancel();
				if (e.touches.length !== 1) return;
				const t = e.touches[0];
				const point = { x: t.clientX, y: t.clientY };
				start.current = point;
				held.current = false;
				timer.current = setTimeout(() => {
					held.current = true;
					navigator.vibrate?.(10);
					onHold(point, key);
				}, HOLD_MS);
			},
			onTouchMove: (e: React.TouchEvent) => {
				const t = e.touches[0];
				if (start.current && t && Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 10) cancel();
			},
			onTouchEnd: (e: React.TouchEvent) => {
				cancel();
				// Stops the tap that ends a hold from opening the email underneath.
				if (held.current && e.cancelable) e.preventDefault();
			},
			onTouchCancel: () => cancel(),
		}),
	};
}

export default function EmailContextMenu({ at, title, items, onClose }: {
	at: MenuPoint;
	/** A short line at the top, such as the subject or "3 selected". */
	title?: string;
	items: MenuItem[];
	onClose: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [page, setPage] = useState<"main" | "move" | "labels">("main");
	const [pos, setPos] = useState({ left: at.x, top: at.y });

	// Keep the menu on screen: flip it left or up when it would run off the edge.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const { width, height } = el.getBoundingClientRect();
		const pad = 8;
		const left = at.x + width + pad > window.innerWidth ? Math.max(pad, at.x - width) : at.x;
		const top = at.y + height + pad > window.innerHeight ? Math.max(pad, window.innerHeight - height - pad) : at.y;
		setPos({ left, top });
	}, [at.x, at.y, page]);

	useEffect(() => {
		const away = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
		const keys = (e: KeyboardEvent) => {
			if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
			if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
			e.preventDefault();
			const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
			const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
			const next = e.key === "ArrowDown" ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length;
			buttons[next]?.focus();
		};
		document.addEventListener("mousedown", away);
		document.addEventListener("touchstart", away);
		document.addEventListener("contextmenu", away);
		document.addEventListener("keydown", keys, true);
		window.addEventListener("resize", onClose);
		window.addEventListener("blur", onClose);
		document.addEventListener("scroll", onClose, true);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("touchstart", away);
			document.removeEventListener("contextmenu", away);
			document.removeEventListener("keydown", keys, true);
			window.removeEventListener("resize", onClose);
			window.removeEventListener("blur", onClose);
			document.removeEventListener("scroll", onClose, true);
		};
	}, [onClose]);

	useEffect(() => { ref.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [page]);

	const move = items.find((i) => i.kind === "move");
	const labels = items.find((i) => i.kind === "labels");

	return (
		<div
			ref={ref}
			role="menu"
			aria-label={title}
			onContextMenu={(e) => e.preventDefault()}
			onClick={(e) => e.stopPropagation()}
			style={{ left: pos.left, top: pos.top }}
			className="fixed z-[60] w-60 max-w-[calc(100vw-1rem)] rounded-lg border border-kumo-line bg-kumo-elevated py-1 shadow-lg select-none"
		>
			{page === "main" && (
				<>
					{title && <div className="truncate px-3 py-1.5 text-xs font-medium text-kumo-subtle">{title}</div>}
					{title && <div className="my-1 h-px bg-kumo-line" />}
					{items.map((item, i) => {
						if (item.kind === "separator") return <div key={i} className="my-1 h-px bg-kumo-line" />;
						if (item.kind === "item") {
							return (
								<button key={i} type="button" role="menuitem" className={`${ROW} ${item.danger ? "text-kumo-destructive" : ""}`}
									onClick={() => { onClose(); item.onSelect(); }}>
									<span className="shrink-0 text-kumo-subtle">{item.icon}</span>
									{item.label}
								</button>
							);
						}
						return (
							<button key={i} type="button" role="menuitem" aria-haspopup="menu" className={ROW}
								onClick={() => setPage(item.kind)}>
								<span className="shrink-0 text-kumo-subtle">{item.icon}</span>
								{item.label}
								<CaretRightIcon size={14} className="ml-auto shrink-0 text-kumo-subtle" />
							</button>
						);
					})}
				</>
			)}

			{page !== "main" && (
				<button type="button" className={`${ROW} text-kumo-subtle`} onClick={() => setPage("main")}>
					<CaretLeftIcon size={14} className="shrink-0" />
					{page === "move" ? move?.label : labels?.label}
				</button>
			)}
			{page !== "main" && <div className="my-1 h-px bg-kumo-line" />}

			{page === "move" && move?.kind === "move" && (
				<div className="max-h-72 overflow-y-auto">
					{move.folders.map((f) => (
						<button key={f.id} type="button" role="menuitem" className={ROW}
							onClick={() => { onClose(); move.onMove(f.id); }}>
							{f.name}
						</button>
					))}
				</div>
			)}

			{page === "labels" && labels?.kind === "labels" && <LabelPicker {...labels} />}
		</div>
	);
}

/** Tick labels on and off, as the Label button does. The menu stays open so you can pick several. */
function LabelPicker({ mailboxId, email, labels }: { mailboxId: string; email: Email; labels: Label[] }) {
	const setLabels = useSetEmailLabels();
	const toast = useKumoToastManager();
	const [on, setOn] = useState(() => new Set(email.labels ?? []));
	if (labels.length === 0) return <p className="px-3 py-2 text-sm text-kumo-subtle">{copy.none}</p>;
	return (
		<div className="max-h-72 overflow-y-auto">
			{labels.map((label) => {
				const ticked = on.has(label.id);
				return (
					<button key={label.id} type="button" role="menuitemcheckbox" aria-checked={ticked} className={ROW}
						onClick={() => {
							setOn((prev) => { const next = new Set(prev); if (ticked) next.delete(label.id); else next.add(label.id); return next; });
							setLabels.mutate(
								{ mailboxId, email, ...(ticked ? { remove: [label.id] } : { add: [label.id] }) },
								{ onError: () => toast.add({ title: copy.failed, variant: "error" }) },
							);
						}}>
						<span className={`flex size-4 shrink-0 items-center justify-center rounded border ${ticked ? "border-transparent bg-kumo-brand text-white" : "border-kumo-line"}`}>
							{ticked && <CheckIcon size={11} weight="bold" />}
						</span>
						<LabelDot color={label.color} />
						<span className="truncate">{label.name}</span>
					</button>
				);
			})}
		</div>
	);
}
