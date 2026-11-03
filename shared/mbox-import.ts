// Mail App, 2026: reading .mbox files back in, for restoring a Mail App backup or bringing mail across from
// Gmail (Google Takeout), Apple Mail or Thunderbird. MboxReader splits a file into messages a piece at
// a time, so a file of many gigabytes never has to fit in memory. placement() works out where each
// message goes: its folder, labels, and whether it's read or starred.

const NL = 0x0a;
const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20]; // "From "

function startsFrom(buf: Uint8Array, at: number): boolean {
	for (let k = 0; k < 5; k++) if (buf[at + k] !== FROM[k]) return false;
	return true;
}

/** Takes the "From " line off the top and turns ">From " lines back into "From " (the mboxrd way).  */
export function finish(raw: Uint8Array): Uint8Array {
	let start = 0;
	if (startsFrom(raw, 0)) {
		const nl = raw.indexOf(NL);
		start = nl === -1 ? raw.length : nl + 1;
	}
	let end = raw.length;
	// The blank line that separates messages isn't part of the message.
	while (end > start && (raw[end - 1] === NL || raw[end - 1] === 0x0d)) end--;
	const body = raw.subarray(start, end);
	// Lines that were "From ..." in the original were written as ">From ...": find them.
	const cuts: number[] = [];
	let pos = 0;
	while (pos < body.length) {
		if (body[pos] === 0x3e /* > */) {
			let j = pos;
			while (body[j] === 0x3e) j++;
			if (startsFrom(body, j)) cuts.push(pos);
		}
		const nl = body.indexOf(NL, pos);
		if (nl === -1) break;
		pos = nl + 1;
	}
	if (cuts.length === 0) return body;
	const out = new Uint8Array(body.length - cuts.length);
	let o = 0;
	let prev = 0;
	for (const cut of cuts) {
		out.set(body.subarray(prev, cut), o);
		o += cut - prev;
		prev = cut + 1;
	}
	out.set(body.subarray(prev), o);
	return out;
}

/** Splits an .mbox file into messages as its bytes arrive. */
export class MboxReader {
	private buf = new Uint8Array(0);
	private scan = 0;

	/** Adds the next piece of the file; returns the messages it completed. */
	push(chunk: Uint8Array): Uint8Array[] {
		const next = new Uint8Array(this.buf.length + chunk.length);
		next.set(this.buf);
		next.set(chunk, this.buf.length);
		this.buf = next;
		const out: Uint8Array[] = [];
		let msgStart = 0;
		let i = this.scan;
		for (;;) {
			const nl = this.buf.indexOf(NL, i);
			if (nl === -1 || nl + 5 >= this.buf.length) break;
			if (startsFrom(this.buf, nl + 1)) {
				const raw = this.buf.subarray(msgStart, nl + 1);
				if (raw.some((b) => b !== NL && b !== 0x0d)) out.push(finish(raw));
				msgStart = nl + 1;
			}
			i = nl + 1;
		}
		this.buf = this.buf.slice(msgStart);
		this.scan = Math.max(0, i - msgStart - 1);
		return out;
	}

	/** The last message, once the whole file has been read. */
	end(): Uint8Array[] {
		const raw = this.buf;
		this.buf = new Uint8Array(0);
		return raw.some((b) => b !== NL && b !== 0x0d) ? [finish(raw)] : [];
	}
}

// ── Where a message goes ───────────────────────────────────────────

export type SystemFolder = "inbox" | "sent" | "draft" | "archive" | "spam" | "trash";

export interface Placement {
	/** A built-in folder, or the name of a folder of your own (made if it doesn't exist). */
	folder: { system: SystemFolder } | { name: string };
	labels: string[];
	read: boolean;
	starred: boolean;
}

const SYSTEM_BY_NAME: Record<string, SystemFolder> = {
	inbox: "inbox", sent: "sent", "sent mail": "sent", "sent items": "sent", "sent messages": "sent",
	draft: "draft", drafts: "draft", archive: "archive", archived: "archive", "all mail": "archive",
	spam: "spam", junk: "spam", "junk e-mail": "spam", trash: "trash", bin: "trash", "deleted items": "trash",
	"deleted messages": "trash",
	// Mail App: snoozed mail in a backup comes back to the Inbox, as its snooze isn't in the backup.
	snoozed: "inbox",
};

// Gmail's own labels, which say where a message is rather than what it's about.
const GMAIL_STATE = new Set(["inbox", "sent", "spam", "trash", "drafts", "draft", "important", "starred", "unread", "opened", "archived", "chat", "all mail"]);

function header(headers: { key: string; value: string }[], name: string): string | undefined {
	return headers.find((h) => h.key.toLowerCase() === name)?.value;
}

/** Splits "Inbox,Work,"Bills, home",Category Updates" at commas outside quotes. */
export function splitLabels(value: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quoted = false;
	for (const ch of value) {
		if (ch === '"') { quoted = !quoted; continue; }
		if (ch === "," && !quoted) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
		cur += ch;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
}

export function systemFolderFor(name: string): SystemFolder | undefined {
	return SYSTEM_BY_NAME[name.trim().toLowerCase()];
}

/**
 * Works out a message's folder, labels and flags from its headers. Mail App backups say exactly; Gmail's
 * export lists labels; other mail apps only mark read and flagged, and their mail goes to `fallback`.
 */
export function placement(headers: { key: string; value: string }[], fallback: Placement["folder"]): Placement {
	const status = header(headers, "status") ?? "";
	const xStatus = header(headers, "x-status") ?? "";
	const mozilla = Number.parseInt(header(headers, "x-mozilla-status") ?? "", 16);
	const hasMozilla = !Number.isNaN(mozilla);
	let read = status ? status.includes("R") : hasMozilla ? (mozilla & 0x1) !== 0 : true;
	let starred = xStatus.includes("F") || (hasMozilla && (mozilla & 0x4) !== 0);

	const appFolder = header(headers, "x-mail-app-folder");
	if (appFolder) {
		const labels = splitLabels(header(headers, "x-mail-app-labels") ?? "");
		const system = systemFolderFor(appFolder);
		return { folder: system ? { system } : { name: appFolder.trim() }, labels, read, starred };
	}

	const gmail = header(headers, "x-gmail-labels");
	if (gmail) {
		const all = splitLabels(gmail);
		const has = (name: string) => all.some((l) => l.toLowerCase() === name);
		read = !has("unread");
		starred = has("starred");
		const system: SystemFolder = has("spam") ? "spam" : has("trash") ? "trash" : has("draft") || has("drafts") ? "draft"
			: has("sent") ? "sent" : has("inbox") ? "inbox" : "archive";
		const labels = all.filter((l) => !GMAIL_STATE.has(l.toLowerCase()) && !/^category /i.test(l));
		return { folder: { system }, labels, read, starred };
	}

	return { folder: fallback, labels: [], read, starred };
}

/** A folder name from a file name: "Work.mbox" or "Work.mbox.zip" becomes "Work". */
export function folderFromFileName(fileName: string): string {
	const base = fileName.replace(/^.*[\\/]/, "").replace(/(\.mbox)?(\.txt|\.eml)?$/i, "").replace(/\.mbox$/i, "").trim();
	return base.slice(0, 60) || "Imported";
}
