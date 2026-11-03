// Mail App addition (not part of upstream Agentic Inbox).
// Files: private storage for documents and photos, kept in the install's own R2 bucket next to the mail.
// Each mailbox has its own files, so a shared mailbox's files are shared by the same people. The rules
// here are used by both the app and the Worker.

/** The biggest file Files takes. Uploads go up in parts, so this isn't held back by Cloudflare's 100 MB request limit. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
/** Each part of an upload. Cloudflare refuses requests over 100 MB on most plans; R2 wants parts of at least 5 MiB. */
export const PART_BYTES = 50 * 1024 * 1024;
/** Files in the Bin are deleted for good after this many days. */
export const BIN_DAYS = 30;
/** Cloudflare R2's free allowance each month, and the price per GB a month after it. */
export const FREE_GB = 10;
export const PRICE_PER_GB = 0.015;
/** Folders saved email attachments go into. */
export const EMAIL_ATTACHMENTS_FOLDER = "Email attachments";
/** Text files bigger than this are downloaded rather than shown. */
export const MAX_TEXT_PREVIEW = 1024 * 1024;

export type FileKind = "file" | "folder";

export interface FileItem {
	id: string;
	parentId: string | null;
	kind: FileKind;
	name: string;
	size: number;
	type: string;
	createdAt: string;
	updatedAt: string;
	createdByName: string | null;
	/** When it went in the Bin (null: it isn't there). */
	binnedAt: string | null;
}

export interface FolderPath {
	id: string;
	name: string;
}

export interface FileListing {
	folder: FileItem | null;
	/** From the top down to the folder being shown, not including it. */
	path: FolderPath[];
	items: FileItem[];
}

export interface FileUsage {
	bytes: number;
	files: number;
	binBytes: number;
}

/** A name that's safe to store and show: no slashes or control characters, trimmed, at most 200 characters. */
export function cleanFileName(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const name = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f\\/]/g, "_").replace(/\s+/g, " ").trim();
	if (name === "." || name === "..") return "";
	return name.slice(0, 200).trim();
}

/** "Report.pdf" -> ["Report", ".pdf"]. A name starting with a dot has no extension. */
export function splitExtension(name: string): [string, string] {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return [name, ""];
	return [name.slice(0, dot), name.slice(dot)];
}

/** The name, changed to "Report (2).pdf" and so on when it's already taken in that folder (ignoring case). */
export function uniqueName(name: string, taken: Iterable<string>, kind: FileKind = "file"): string {
	const used = new Set([...taken].map((n) => n.toLowerCase()));
	if (!used.has(name.toLowerCase())) return name;
	const [stem, ext] = kind === "folder" ? [name, ""] : splitExtension(name);
	for (let n = 2; ; n++) {
		const next = `${stem} (${n})${ext}`;
		if (!used.has(next.toLowerCase())) return next;
	}
}

export type PreviewKind = "image" | "pdf" | "video" | "audio" | "text" | null;

const TEXT_EXTENSIONS = /\.(txt|md|csv|log|json|xml|ya?ml|ini|conf|ics|vcf)$/i;

/** How the app can show a file, if it can. */
export function previewKind(type: string, name = "", size = 0): PreviewKind {
	const t = type.toLowerCase();
	if (/^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/.test(t)) return "image";
	if (t === "application/pdf") return "pdf";
	if (/^video\/(mp4|webm|ogg|quicktime)$/.test(t)) return "video";
	if (/^audio\/(mpeg|mp3|mp4|aac|ogg|wav|x-wav|webm|flac|x-m4a)$/.test(t)) return "audio";
	if ((t.startsWith("text/") || TEXT_EXTENSIONS.test(name)) && size <= MAX_TEXT_PREVIEW) return "text";
	return null;
}

/**
 * The Content-Type a file is served with. Files that could run code in the app (web pages, SVG and the like)
 * are never served as themselves: text is served as plain text, and anything not on the list is just bytes to save.
 */
export function servedType(type: string, name = ""): string {
	const t = type.toLowerCase();
	const kind = previewKind(t, name);
	if (kind === "text") return "text/plain; charset=utf-8";
	if (kind && t !== "image/svg+xml") return t;
	return "application/octet-stream";
}

/** A Content-Type for a file whose browser didn't say: worked out from its name. */
export function guessType(name: string): string {
	const ext = splitExtension(name)[1].toLowerCase();
	const known: Record<string, string> = {
		".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
		".pdf": "application/pdf", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mp3": "audio/mpeg",
		".m4a": "audio/mp4", ".wav": "audio/wav", ".txt": "text/plain", ".csv": "text/csv", ".md": "text/markdown",
		".zip": "application/zip", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	};
	return known[ext] ?? "application/octet-stream";
}

/** A type that's safe to keep: something like "image/png", or the generic one. */
export function cleanType(raw: unknown, name: string): string {
	const t = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) && t.length <= 200 ? t : guessType(name);
}

/** How many parts a file of this size goes up in. */
export function partCount(size: number, partBytes = PART_BYTES): number {
	return Math.max(1, Math.ceil(size / partBytes));
}

/** The date an item in the Bin will be deleted for good. */
export function binExpiry(binnedAt: string, days = BIN_DAYS): Date {
	return new Date(Date.parse(binnedAt) + days * 86_400_000);
}

/** Roughly what storing this much costs a month, in US dollars, after Cloudflare's free allowance. */
export function monthlyCost(bytes: number): number {
	const gb = bytes / 1024 ** 3;
	return Math.max(0, gb - FREE_GB) * PRICE_PER_GB;
}

/** Sizes the way people say them: 820 KB, 4.2 MB, 1.3 GB. */
export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	const units = ["KB", "MB", "GB", "TB"];
	let n = bytes / 1024;
	let u = 0;
	while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
	return `${n >= 100 || u === 0 ? Math.round(n) : n.toFixed(1)} ${units[u]}`;
}

export type FileSort = "name" | "updated" | "size";

/** Folders first, then by the chosen column. */
export function sortItems<T extends FileItem>(items: T[], sort: FileSort, ascending: boolean): T[] {
	const dir = ascending ? 1 : -1;
	return [...items].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
		let diff = 0;
		if (sort === "updated") diff = a.updatedAt.localeCompare(b.updatedAt);
		else if (sort === "size") diff = a.size - b.size;
		if (diff === 0) diff = a.name.localeCompare(b.name, "en-GB", { numeric: true, sensitivity: "base" });
		return diff * dir;
	});
}
