// Mail App, 2026: Gmail-style keyboard shortcuts. A key only counts when you're not typing
// somewhere, and never with Ctrl, Cmd or Alt held, so the browser's own shortcuts still work.

import { useEffect, useRef } from "react";

export function isTyping(e: KeyboardEvent): boolean {
	if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return true;
	const el = e.target as HTMLElement | null;
	if (!el) return false;
	if (el.isContentEditable) return true;
	const tag = el.tagName;
	if (tag === "TEXTAREA" || tag === "SELECT") return true;
	if (tag === "INPUT") {
		const type = (el as HTMLInputElement).type;
		return type !== "checkbox" && type !== "radio" && type !== "button";
	}
	// An open dialog or menu handles its own keys.
	return !!el.closest("[role=dialog], [role=menu], [role=listbox]");
}

/** Calls the handler for each key in the map, while `on` is true. */
export function useShortcuts(keys: Record<string, () => void>, on = true) {
	const latest = useRef(keys);
	latest.current = keys;
	useEffect(() => {
		if (!on) return;
		const handler = (e: KeyboardEvent) => {
			if (e.defaultPrevented || isTyping(e)) return;
			const run = latest.current[e.key];
			if (!run) return;
			e.preventDefault();
			run();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [on]);
}

/** The list shown by "?", in the order people look for them. */
export const SHORTCUT_LIST: [string, string][] = [
	["c", "Write a new email"],
	["/", "Search"],
	["j / k", "Next / previous email"],
	["x", "Tick the open email"],
	["Esc", "Close the email"],
	["r", "Reply"],
	["a", "Reply all"],
	["f", "Forward"],
	["e", "Archive"],
	["s", "Star or unstar"],
	["u", "Mark as unread"],
	["?", "Show these shortcuts"],
];
