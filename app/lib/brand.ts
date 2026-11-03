// Mail App addition (not part of upstream Agentic Inbox).
// The company's branding (shared/branding.ts) in the app. The root route reads it with the page, so the
// first paint already has the right name, logo and colour. Its name replaces "Mail App" in the wording
// files, apart from the welcome email (the Worker writes that one).

import { useRouteLoaderData } from "react-router";
import { DEFAULT_NAME, brandName, cleanBranding, isBranded, type Branding } from "shared/branding";

const files = import.meta.glob<Record<string, unknown>>("../copy/*.json", { eager: true, import: "default" });

/** Wording that keeps "Mail App" whatever the branding. */
const KEEP_FILES = ["welcome.en-GB.json", "branding.en-GB.json"];
const KEEP: string[] = [];

/** Lines that name the app in another way, and what they say once branded. */
const BRANDED_LINES: Record<string, (text: string) => string> = {};

type Slot = { obj: Record<string, unknown> | unknown[]; key: string | number; original: string; path: string };
let slots: Slot[] | null = null;
let applied = "";

function collect(): Slot[] {
	const out: Slot[] = [];
	const walk = (obj: Record<string, unknown> | unknown[], path: string) => {
		for (const [key, value] of Object.entries(obj)) {
			if (key.startsWith("_")) continue;
			const here = `${path}.${key}`;
			const k = Array.isArray(obj) ? Number(key) : key;
			if (typeof value === "string") {
				if ((value.includes(DEFAULT_NAME) || BRANDED_LINES[here]) && !KEEP.some((p) => here.startsWith(p))) out.push({ obj, key: k, original: value, path: here });
			} else if (value && typeof value === "object") walk(value as Record<string, unknown>, here);
		}
	};
	for (const [file, copy] of Object.entries(files)) {
		const name = file.split("/").pop()!;
		if (KEEP_FILES.includes(name) || !copy) continue;
		walk(copy, name.replace(".en-GB.json", ""));
	}
	return out;
}

/** Puts the company's name into the wording (or puts Mail App back). Cheap to call on every render. */
export function applyBrand(b: Branding | null | undefined) {
	const name = b?.name ?? "";
	if (name === applied) return;
	slots ??= collect();
	for (const s of slots) {
		let text = s.original;
		if (name) {
			text = text.replaceAll(DEFAULT_NAME, name);
			text = BRANDED_LINES[s.path]?.(text) ?? text;
		}
		(s.obj as Record<string | number, unknown>)[s.key] = text;
	}
	applied = name;
}

/** The branding the page was loaded with. */
export function useBranding(): Branding {
	const data = useRouteLoaderData("root") as { branding?: Branding } | undefined;
	return data?.branding ?? cleanBranding(null);
}

export function useIsBranded(): boolean {
	return isBranded(useBranding());
}

/** "Reports · Smith & Jones Mail", for a page's meta(). */
export function pageTitle(matches: readonly unknown[] | undefined, label?: string): string {
	const root = (matches ?? []).find((m) => (m as { id?: string } | undefined)?.id === "root") as { data?: { branding?: Branding }; loaderData?: { branding?: Branding } } | undefined;
	const name = brandName(root?.loaderData?.branding ?? root?.data?.branding);
	return label ? `${label} · ${name}` : name;
}
