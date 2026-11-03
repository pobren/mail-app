// Mail App addition (not part of upstream Agentic Inbox).
// Branding (Admin > Branding): a company's own name, logo and colour on Mail App, and its own support
// address in the help links. Kept in R2 at setup/branding.json, the logo at setup/branding-logo
// (workers/lib/branding.ts). Nothing set means Mail App's own look. Wording in app/copy/branding.en-GB.json.

export const DEFAULT_NAME = "Mail App";
export const DEFAULT_COLOUR = "#c8102e";
export const MAX_BRAND_NAME = 40;
export const MAX_LOGO_BYTES = 200 * 1024;

export type LogoType = "image/png" | "image/svg+xml" | "image/webp";

export interface BrandLogo {
	type: LogoType;
	/** Its size in pixels, measured when it was added (0 when unknown). A square logo is also the app icon. */
	width: number;
	height: number;
	/** Changes with each new logo, so browsers fetch the new one. */
	version: string;
}

export interface Branding {
	/** Shown in place of "Mail App". Empty means Mail App. */
	name: string;
	/** "#rrggbb". Empty means Mail App's red. */
	colour: string;
	logo: BrandLogo | null;
	/** Shown to everyone in the help links in place of Mail App's. Empty shows none to people who aren't admins. */
	supportEmail: string;
}

/** The ready-made colours on the Branding page. */
export const COLOUR_PRESETS = ["#c8102e", "#0f766e", "#1d4ed8", "#7c3aed", "#be185d", "#c2410c", "#15803d", "#334155"];

const HEX = /^#[0-9a-f]{6}$/;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const LOGO_TYPES: LogoType[] = ["image/png", "image/svg+xml", "image/webp"];

/** "0F766E", "#0f766e" or "#0F7" become "#0f766e"; anything else is "". */
export function cleanColour(raw: unknown): string {
	if (typeof raw !== "string") return "";
	let s = raw.trim().toLowerCase();
	if (!s.startsWith("#")) s = `#${s}`;
	if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
	return HEX.test(s) ? s : "";
}

function cleanLogo(raw: unknown): BrandLogo | null {
	if (!raw || typeof raw !== "object") return null;
	const l = raw as Record<string, unknown>;
	if (!LOGO_TYPES.includes(l.type as LogoType) || typeof l.version !== "string" || !l.version) return null;
	const px = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 10_000) : 0);
	return { type: l.type as LogoType, width: px(l.width), height: px(l.height), version: l.version.slice(0, 40) };
}

export function cleanBranding(raw: unknown): Branding {
	const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const name = typeof r.name === "string" ? r.name.replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_BRAND_NAME) : "";
	const email = typeof r.supportEmail === "string" ? r.supportEmail.trim().toLowerCase().slice(0, 200) : "";
	const colour = cleanColour(r.colour);
	return {
		name: name === DEFAULT_NAME ? "" : name,
		colour: colour === DEFAULT_COLOUR ? "" : colour,
		logo: cleanLogo(r.logo),
		supportEmail: EMAIL.test(email) ? email : "",
	};
}

/** Has the company put its own name or logo on it? Then Mail App's name and help links are kept for admins. */
export function isBranded(b: Branding | null | undefined): boolean {
	return !!b && (!!b.name || !!b.logo);
}

export function brandName(b: Branding | null | undefined): string {
	return b?.name || DEFAULT_NAME;
}

/** Text with "Mail App" swapped for the company's name. */
export function rebrand(text: string, b: Branding | null | undefined): string {
	return b?.name ? text.replaceAll(DEFAULT_NAME, b.name) : text;
}

export function logoUrl(b: Branding | null | undefined): string | null {
	return b?.logo ? `/api/v1/branding/logo?v=${encodeURIComponent(b.logo.version)}` : null;
}

/** A square logo big enough to stand in for the app icon. */
export function logoIsIcon(logo: BrandLogo | null | undefined): boolean {
	if (!logo) return false;
	if (logo.type === "image/svg+xml") return !logo.width || logo.width === logo.height;
	return logo.width >= 192 && logo.width === logo.height;
}

// ── Colours ───────────────────────────────────────────────────────

function rgb(hex: string): [number, number, number] {
	return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function hexOf([r, g, b]: number[]): string {
	return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string): number {
	const [r, g, b] = rgb(hex).map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** How well white text reads on this colour (WCAG contrast ratio, 1 to 21). */
export function contrastWithWhite(hex: string): number {
	return 1.05 / (luminance(hex) + 0.05);
}

function darken(hex: string, by: number): string {
	return hexOf(rgb(hex).map((v) => v * (1 - by)));
}

export interface BrandColours {
	/** Buttons and highlights. Darkened when needed so white text on it is easy to read. */
	brand: string;
	hover: string;
	/** "r, g, b" of brand, for pale tints. */
	rgb: string;
	/** True when the chosen colour was too light for white text and has been darkened. */
	darkened: boolean;
}

export function brandColours(colour: string | null | undefined): BrandColours {
	const chosen = cleanColour(colour) || DEFAULT_COLOUR;
	let brand = chosen;
	for (let i = 0; i < 40 && contrastWithWhite(brand) < 4.5; i++) brand = darken(brand, 0.06);
	return { brand, hover: darken(brand, 0.17), rgb: rgb(brand).join(", "), darkened: brand !== chosen };
}

/** The CSS that puts the brand colour on the app (Kumo's buttons and Mail App's own highlights). */
export function brandCss(b: Branding | null | undefined): string {
	const c = brandColours(b?.colour);
	// Doubled selectors, so this wins over the app's own stylesheet whichever loads last.
	return `:root:root,[data-mode="dark"][data-mode="dark"]{--color-kumo-brand:${c.brand};--color-kumo-brand-hover:${c.hover};--brand:${c.brand};--brand-ink:${c.hover};--brand-rgb:${c.rgb}}`;
}

// ── Logo files ────────────────────────────────────────────────────

/** What a logo file really is, from its first bytes (not its name), or null if it isn't one we take. */
export function sniffLogo(bytes: Uint8Array): LogoType | null {
	const at = (i: number, ...v: number[]) => v.every((x, j) => bytes[i + j] === x);
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
	const head = new TextDecoder().decode(bytes.slice(0, 1024)).replace(/^﻿/, "").trimStart().toLowerCase();
	if ((head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!--")) && head.includes("<svg")) return "image/svg+xml";
	return null;
}

// ── The installed app ─────────────────────────────────────────────

/** The app manifest (Dock, taskbar and home screen) with the company's name, colour and square logo. */
export function brandManifest(base: Record<string, unknown>, b: Branding): Record<string, unknown> {
	const name = brandName(b);
	const url = logoUrl(b);
	const out: Record<string, unknown> = { ...base, name, short_name: name, theme_color: brandColours(b.colour).brand };
	if (url && b.logo && logoIsIcon(b.logo)) {
		const sizes = b.logo.type === "image/svg+xml" ? "any" : `${b.logo.width}x${b.logo.height}`;
		out.icons = [{ src: url, sizes, type: b.logo.type, purpose: "any" }];
		out.shortcuts = ((base.shortcuts as { name: string; url: string }[] | undefined) ?? []).map((s) => ({ ...s, icons: [{ src: url, sizes, type: b.logo!.type }] }));
	}
	return out;
}
