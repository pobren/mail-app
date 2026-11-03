// Mail App: labels. Names and colours you can put on conversations, like Gmail's labels.
// A conversation can have several labels, and each label has its own page in the sidebar.

export interface Label {
	id: string;
	name: string;
	color: LabelColor;
	/** Unread messages in conversations with this label (Spam and Trash left out). */
	unreadCount?: number;
}

/**
 * The colours to choose from. `dot` is a soft mid-tone for the dots and the colour picker.
 * Tags use a pale `tint` with darker `ink` writing so a busy inbox stays calm; in dark mode
 * they use a deep `darkTint` with light `darkInk` writing.
 */
export const LABEL_COLORS = {
	red: { name: "Red", dot: "#f87171", tint: "#fee2e2", ink: "#991b1b", darkTint: "#450a0a", darkInk: "#fecaca" },
	orange: { name: "Orange", dot: "#fb923c", tint: "#ffedd5", ink: "#9a3412", darkTint: "#431407", darkInk: "#fed7aa" },
	amber: { name: "Yellow", dot: "#fcd34d", tint: "#fef3c7", ink: "#854d0e", darkTint: "#422006", darkInk: "#fde68a" },
	green: { name: "Green", dot: "#4ade80", tint: "#dcfce7", ink: "#166534", darkTint: "#052e16", darkInk: "#bbf7d0" },
	teal: { name: "Teal", dot: "#2dd4bf", tint: "#ccfbf1", ink: "#115e59", darkTint: "#042f2e", darkInk: "#99f6e4" },
	blue: { name: "Blue", dot: "#60a5fa", tint: "#dbeafe", ink: "#1e40af", darkTint: "#172554", darkInk: "#bfdbfe" },
	indigo: { name: "Indigo", dot: "#818cf8", tint: "#e0e7ff", ink: "#3730a3", darkTint: "#1e1b4b", darkInk: "#c7d2fe" },
	purple: { name: "Purple", dot: "#c084fc", tint: "#f3e8ff", ink: "#6b21a8", darkTint: "#3b0764", darkInk: "#e9d5ff" },
	pink: { name: "Pink", dot: "#f472b6", tint: "#fce7f3", ink: "#9d174d", darkTint: "#500724", darkInk: "#fbcfe8" },
	brown: { name: "Brown", dot: "#c4956c", tint: "#f5e6d8", ink: "#78350f", darkTint: "#2b1608", darkInk: "#f0d5bc" },
	grey: { name: "Grey", dot: "#9ca3af", tint: "#f3f4f6", ink: "#374151", darkTint: "#1f2937", darkInk: "#e5e7eb" },
	black: { name: "Black", dot: "#4b5563", tint: "#e5e7eb", ink: "#111827", darkTint: "#030712", darkInk: "#f3f4f6" },
} as const;

export type LabelColor = keyof typeof LABEL_COLORS;

export const LABEL_COLOR_KEYS = Object.keys(LABEL_COLORS) as LabelColor[];

export const MAX_LABEL_NAME = 40;
export const MAX_LABELS = 100;

export function isLabelColor(value: unknown): value is LabelColor {
	return typeof value === "string" && value in LABEL_COLORS;
}

function colourOf(color: string | null | undefined) {
	return isLabelColor(color) ? LABEL_COLORS[color] : LABEL_COLORS.grey;
}

/** The colour for dots and swatches. Unknown colours fall back to grey. */
export function labelDotColour(color: string | null | undefined) {
	return colourOf(color).dot;
}

/** The colours for a tag, as CSS variables read by the `.app-label` class in app/index.css. */
export function labelTagVars(color: string | null | undefined): Record<string, string> {
	const c = colourOf(color);
	return { "--label-tint": c.tint, "--label-ink": c.ink, "--label-dark-tint": c.darkTint, "--label-dark-ink": c.darkInk };
}

/** Tidies a label name: trims it, squashes runs of spaces and cuts it to length. "" means unusable. */
export function cleanLabelName(name: unknown): string {
	if (typeof name !== "string") return "";
	return name.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_NAME);
}

/** Picks a colour for a new label: the first one not used yet, then round again. */
export function nextLabelColor(existing: { color: string }[]): LabelColor {
	const used = new Set(existing.map((l) => l.color));
	return LABEL_COLOR_KEYS.find((k) => !used.has(k)) ?? LABEL_COLOR_KEYS[existing.length % LABEL_COLOR_KEYS.length];
}

/** Moves label `id` to just before `beforeId` (or to the end when beforeId is null). */
export function moveLabel<T extends { id: string }>(labels: T[], id: string, beforeId: string | null): T[] {
	const moving = labels.find((l) => l.id === id);
	if (!moving || id === beforeId) return labels;
	const rest = labels.filter((l) => l.id !== id);
	const at = beforeId ? rest.findIndex((l) => l.id === beforeId) : -1;
	if (at < 0) return [...rest, moving];
	return [...rest.slice(0, at), moving, ...rest.slice(at)];
}
