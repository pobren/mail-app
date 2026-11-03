// Mail App, 2026: turns a stored email back into a standard email file (RFC 5322 with MIME parts) and
// wraps it for an .mbox file, the format Gmail, Apple Mail and Thunderbird use to export and import mail.
// Used by backups (workers/durableObject/backup.ts). No dependencies, so it runs in Workers and in tests.

export interface StoredEmail {
	id: string;
	subject?: string | null;
	sender?: string | null;
	sender_name?: string | null;
	recipient?: string | null;
	cc?: string | null;
	bcc?: string | null;
	date?: string | null;
	body?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	read?: number | boolean | null;
	starred?: number | boolean | null;
}

export interface StoredFile {
	filename: string;
	mimetype: string;
	content_id?: string | null;
	disposition?: string | null;
	bytes: Uint8Array;
}

/** Extra facts kept in each message, so a backup can be put back as it was. */
export interface MboxExtras {
	folder: string;
	labels?: string[];
}

const CRLF = "\r\n";
const enc = new TextEncoder();

// Headers we write ourselves for the rebuilt body, so the originals are left out.
const OWN_HEADERS = new Set([
	"content-type", "content-transfer-encoding", "mime-version", "content-disposition", "content-id",
	"x-mail-app-folder", "x-mail-app-labels", "status", "x-status",
]);
const ADDRESS_HEADERS = new Set(["from", "to", "cc", "bcc", "reply-to", "sender"]);

// ── Encoding helpers ───────────────────────────────────────────────

export function base64(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(out);
}

/** Base64 in lines of 76 characters, as MIME asks. */
function base64Lines(bytes: Uint8Array): string {
	const b64 = base64(bytes);
	const lines: string[] = [];
	for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
	return lines.join(CRLF);
}

const isAscii = (s: string) => /^[\x20-\x7e\t]*$/.test(s);

/** RFC 2047 encoded words for text with accents or other non-English letters. */
function encodeWords(text: string): string {
	const words: string[] = [];
	let chunk = "";
	for (const ch of text) {
		// Keep each encoded word under 75 characters (45 bytes of UTF-8 is 60 in base64).
		if (enc.encode(chunk + ch).length > 45) {
			words.push(chunk);
			chunk = "";
		}
		chunk += ch;
	}
	if (chunk) words.push(chunk);
	return words.map((w) => `=?UTF-8?B?${base64(enc.encode(w))}?=`).join(" ");
}

/** Splits "A <a@x>, "B, C" <b@x>" at the commas between addresses, not those inside quotes. */
function splitAddresses(value: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quoted = false;
	let angle = false;
	for (const ch of value) {
		if (ch === '"') quoted = !quoted;
		else if (ch === "<" && !quoted) angle = true;
		else if (ch === ">" && !quoted) angle = false;
		if (ch === "," && !quoted && !angle) {
			if (cur.trim()) out.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
}

function encodeAddress(one: string): string {
	if (isAscii(one)) return one;
	const m = one.match(/^\s*"?(.*?)"?\s*<([^>]+)>\s*$/);
	if (!m) return encodeWords(one);
	return `${isAscii(m[1]) ? `"${m[1]}"` : encodeWords(m[1])} <${m[2]}>`;
}

function headerValue(key: string, value: string): string {
	const clean = value.replace(/[\r\n]+/g, " ").trim();
	if (isAscii(clean)) return clean;
	if (ADDRESS_HEADERS.has(key)) return splitAddresses(clean).map(encodeAddress).join(", ");
	return encodeWords(clean);
}

/** One header line, folded at spaces so no line is much longer than 78 characters. */
function headerLine(name: string, value: string): string {
	const line = `${name}: ${value}`;
	if (line.length <= 78) return line;
	const out: string[] = [];
	let cur = "";
	for (const part of line.split(/(?= )/)) {
		if (cur.length + part.length > 76 && cur.trim()) {
			out.push(cur);
			cur = part;
		} else {
			cur += part;
		}
	}
	if (cur) out.push(cur);
	return out.join(CRLF);
}

const titleCase = (key: string) => key.replace(/(^|-)([a-z])/g, (_m, d: string, c: string) => d + c.toUpperCase());

/** "Sun, 11 Oct 2026 08:12:00 +0000" */
export function emailDate(iso: string | null | undefined): string {
	const d = iso ? new Date(iso) : new Date(0);
	return (Number.isNaN(d.getTime()) ? new Date(0) : d).toUTCString().replace(/GMT$/, "+0000");
}

/** A rough plain-text version of an HTML email, for mail apps that prefer text. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|h[1-6]|li|blockquote)>/gi, "\n")
		.replace(/<li[^>]*>/gi, "• ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const isHtml = (body: string) => /<[a-z][^>]*>/i.test(body);

function boundary(tag: string, id: string): string {
	return `app-${tag}-${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}-${Math.random().toString(36).slice(2, 10)}`;
}

function textPart(type: "plain" | "html", text: string): string {
	return [
		`Content-Type: text/${type}; charset=utf-8`,
		"Content-Transfer-Encoding: base64",
		"",
		base64Lines(enc.encode(text.replace(/\r?\n/g, CRLF))),
	].join(CRLF);
}

function quoteParam(value: string): string {
	return isAscii(value) ? `"${value.replace(/["\\]/g, "\\$&")}"` : `"${encodeWords(value)}"`;
}

function filePart(file: StoredFile): string {
	const inline = file.disposition === "inline" && !!file.content_id;
	const cid = file.content_id?.replace(/^<|>$/g, "");
	return [
		`Content-Type: ${file.mimetype || "application/octet-stream"}; name=${quoteParam(file.filename)}`,
		"Content-Transfer-Encoding: base64",
		`Content-Disposition: ${inline ? "inline" : "attachment"}; filename=${quoteParam(file.filename)}`,
		...(inline ? [`Content-ID: <${cid}>`] : []),
		"",
		base64Lines(file.bytes),
	].join(CRLF);
}

function multipart(kind: string, tag: string, id: string, parts: string[]): string {
	const b = boundary(tag, id);
	return [
		`Content-Type: multipart/${kind}; boundary="${b}"`,
		"",
		...parts.flatMap((p) => [`--${b}`, p]),
		`--${b}--`,
		"",
	].join(CRLF);
}

// ── The message ────────────────────────────────────────────────────

/** Rebuilds a stored email as a complete email file, with CRLF line ends. */
export function buildMessage(email: StoredEmail, files: StoredFile[] = []): string {
	let raw: { key: string; value: string }[] = [];
	try {
		const parsed = JSON.parse(email.raw_headers || "[]");
		if (Array.isArray(parsed)) raw = parsed.filter((h) => h && typeof h.key === "string" && typeof h.value === "string");
	} catch { /* no stored headers: rebuilt from the email's own fields below */ }

	const headers = new Map<string, string>();
	const extra: [string, string][] = [];
	for (const { key, value } of raw) {
		const k = key.toLowerCase();
		if (OWN_HEADERS.has(k)) continue;
		// Received and the like can appear many times; everything else once.
		if (headers.has(k)) extra.push([k, value]);
		else headers.set(k, value);
	}
	const from = email.sender_name && email.sender ? `"${email.sender_name}" <${email.sender}>` : (email.sender || "unknown@localhost");
	if (!headers.has("from")) headers.set("from", from);
	if (!headers.has("to") && email.recipient) headers.set("to", email.recipient);
	if (!headers.has("cc") && email.cc) headers.set("cc", email.cc);
	if (!headers.has("subject")) headers.set("subject", email.subject || "");
	// The stored date (in ISO form) becomes the standard email form; an original Date line is kept as it was.
	const dateLine = headers.get("date");
	headers.set("date", dateLine && !/^\d{4}-\d\d-\d\dT/.test(dateLine) ? dateLine : emailDate(email.date));
	if (!headers.has("message-id")) {
		const id = (email.message_id || `${email.id}@mail-app.local`).replace(/^<|>$/g, "");
		headers.set("message-id", `<${id}>`);
	}
	if (!headers.has("in-reply-to") && email.in_reply_to) headers.set("in-reply-to", `<${email.in_reply_to.replace(/^<|>$/g, "")}>`);
	if (!headers.has("references") && email.email_references) {
		try {
			const refs = JSON.parse(email.email_references);
			if (Array.isArray(refs) && refs.length) headers.set("references", refs.map((r: string) => `<${String(r).replace(/^<|>$/g, "")}>`).join(" "));
		} catch { /* leave it out */ }
	}

	const lines = [
		...[...headers].map(([k, v]) => headerLine(titleCase(k), headerValue(k, v))),
		...extra.map(([k, v]) => headerLine(titleCase(k), headerValue(k, v))),
		"MIME-Version: 1.0",
	];

	const body = email.body || "";
	const html = isHtml(body);
	let content = html
		? multipart("alternative", "alt", email.id, [textPart("plain", htmlToText(body)), textPart("html", body)])
		: textPart("plain", body);
	const inline = files.filter((f) => f.disposition === "inline" && f.content_id);
	const attached = files.filter((f) => !(f.disposition === "inline" && f.content_id));
	if (inline.length) content = multipart("related", "rel", email.id, [content, ...inline.map(filePart)]);
	if (attached.length) content = multipart("mixed", "mix", email.id, [content, ...attached.map(filePart)]);

	return `${lines.join(CRLF)}${CRLF}${content}`;
}

// ── mbox ───────────────────────────────────────────────────────────

/** "Sun Oct 11 08:12:00 2026", the date form an mbox "From " line uses. */
function asctime(iso: string | null | undefined): string {
	const d = iso ? new Date(iso) : new Date(0);
	const t = Number.isNaN(d.getTime()) ? new Date(0) : d;
	const [wd, mon] = [t.toUTCString().slice(0, 3), t.toUTCString().slice(8, 11)];
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${wd} ${mon} ${String(t.getUTCDate()).padStart(2, " ")} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())} ${t.getUTCFullYear()}`;
}

/**
 * One message as an mbox entry (the "mboxrd" kind): a "From " line, the Mail App folder, labels and flags,
 * the message, and a blank line. Lines starting "From " get a ">" so they can't be mistaken for a new
 * message. Uses plain line feeds, as mbox files do.
 */
export function mboxEntry(email: StoredEmail, files: StoredFile[], extras: MboxExtras): string {
	const message = buildMessage(email, files);
	const sender = (email.sender || "MAILER-DAEMON").replace(/\s/g, "") || "MAILER-DAEMON";
	const flags = [
		`X-Mail-App-Folder: ${headerValue("x-mail-app-folder", extras.folder)}`,
		...(extras.labels?.length ? [headerLine("X-Mail-App-Labels", headerValue("x-mail-app-labels", extras.labels.join(", ")))] : []),
		`Status: ${email.read ? "RO" : "O"}`,
		...(email.starred ? ["X-Status: F"] : []),
	];
	const text = `${flags.join(CRLF)}${CRLF}${message}`
		.split(/\r?\n/)
		.map((line) => (/^>*From /.test(line) ? `>${line}` : line))
		.join("\n");
	return `From ${sender} ${asctime(email.date)}\n${text}\n\n`;
}
