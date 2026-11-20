// Mail App addition (not part of upstream Agentic Inbox), from Paul O'Brien's KT8 Move IMAP client (2026).
// Just enough of an IMAP client for Other accounts: it logs in, opens the Inbox read-only (EXAMINE), finds
// new mail by UID and fetches each message whole (UID FETCH ... BODY.PEEK[], which never marks anything
// as read). It also lists folders and adds a message (APPEND), to keep a copy of sent mail in Sent.
//
// It talks over a Duplex, so tests can hand it a pretend server; openImap() makes the real one with
// Cloudflare Workers' TCP sockets (see ./socket.ts).

import { ByteReader, openSocket, type Duplex, type Security } from "./socket.ts";
export type { Duplex, Security };

export interface ImapFolder {
	name: string;
	delimiter: string | null;
	flags: string[];
}

export interface ImapReply {
	status: "OK" | "NO" | "BAD";
	/** The text after OK, NO or BAD, such as "[ALREADYEXISTS] Mailbox exists". */
	text: string;
	/** The untagged lines (starting "* ") that came before it, with any literals written in as quoted strings. */
	untagged: string[];
}

export class ImapError extends Error {
	readonly reply?: ImapReply;
	constructor(message: string, reply?: ImapReply) {
		super(message);
		this.reply = reply;
	}
}

const enc = new TextEncoder();
const utf8 = new TextDecoder();
const CRLF = enc.encode("\r\n");

/** "Folder" or a literal when the string can't be quoted (line breaks, 8-bit text, long passwords). */
type Part = string | { literal: Uint8Array };

/** An IMAP quoted string, or null when it must go as a literal. */
export function quote(s: string): string | null {
	if (s.length > 1000 || /[\r\n\0]/.test(s) || /[^\x20-\x7e]/.test(s)) return null;
	return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** A command argument: quoted if it can be, else a literal. */
export function arg(s: string): Part {
	return quote(s) ?? { literal: enc.encode(s) };
}

// ── Folder names: IMAP's own UTF-7 (RFC 3501 section 5.1.3) ─────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";

/** "Factures 2024" stays as it is; "Reçus" becomes "Re&AOc-us". */
export function toImapUtf7(name: string): string {
	let out = "";
	let run: number[] = [];
	const flush = () => {
		if (!run.length) return;
		const bytes: number[] = [];
		for (const u of run) bytes.push(u >> 8, u & 0xff);
		let bits = 0;
		let acc = 0;
		let s = "";
		for (const b of bytes) {
			acc = (acc << 8) | b;
			bits += 8;
			while (bits >= 6) {
				bits -= 6;
				s += B64[(acc >> bits) & 0x3f];
			}
		}
		if (bits > 0) s += B64[(acc << (6 - bits)) & 0x3f];
		out += `&${s}-`;
		run = [];
	};
	for (const ch of name) {
		const c = ch.codePointAt(0)!;
		if (c >= 0x20 && c <= 0x7e) {
			flush();
			out += ch === "&" ? "&-" : ch;
		} else {
			// Characters outside the BMP go as their two UTF-16 halves.
			for (let i = 0; i < ch.length; i++) run.push(ch.charCodeAt(i));
		}
	}
	flush();
	return out;
}

/** The other way, for folder names a server lists. */
export function fromImapUtf7(name: string): string {
	return name.replace(/&([^-]*)-/g, (_, s: string) => {
		if (s === "") return "&";
		let bits = 0;
		let acc = 0;
		const units: number[] = [];
		const bytes: number[] = [];
		for (const ch of s) {
			const v = B64.indexOf(ch);
			if (v < 0) return `&${s}-`;
			acc = (acc << 6) | v;
			bits += 6;
			if (bits >= 8) {
				bits -= 8;
				bytes.push((acc >> bits) & 0xff);
			}
		}
		for (let i = 0; i + 1 < bytes.length; i += 2) units.push((bytes[i] << 8) | bytes[i + 1]);
		return String.fromCharCode(...units);
	});
}

// ── Reading replies ────────────────────────────────────────────────

/** Reads CRLF lines from the server, writing any literal ({12}\r\n…) into the line as a quoted string. */
class LineReader {
	private r: ByteReader;

	constructor(readable: ReadableStream<Uint8Array>) {
		this.r = new ByteReader(readable, (m) => new ImapError(m));
	}

	private rawLine(): Promise<string> {
		return this.r.line();
	}

	private bytes(n: number, max = 10_000_000): Promise<Uint8Array> {
		return this.r.bytes(n, max);
	}

	async line(): Promise<string> {
		let line = await this.rawLine();
		for (;;) {
			const m = /\{(\d+)\+?\}$/.exec(line);
			if (!m) return line;
			const data = utf8.decode(await this.bytes(Number(m[1])));
			line = line.slice(0, m.index) + `"${data.replace(/[\\"]/g, (c) => `\\${c}`)}"` + (await this.rawLine());
		}
	}

	/** A line with each literal left as bytes: the line holds a stand-in atom ("\0" and its number) for each one. */
	async rawParts(max: number): Promise<{ line: string; literals: Uint8Array[] }> {
		let line = await this.rawLine();
		const literals: Uint8Array[] = [];
		for (;;) {
			const m = /\{(\d+)\+?\}$/.exec(line);
			if (!m) return { line, literals };
			literals.push(await this.bytes(Number(m[1]), max));
			line = line.slice(0, m.index) + `\0${literals.length - 1}` + (await this.rawLine());
		}
	}

	release(): void {
		this.r.release();
	}
}

// ── Parsing LIST lines ─────────────────────────────────────────────

type Token = string | null | Token[];

/** Splits an IMAP response into atoms, quoted strings (unquoted), NIL (null) and (lists). */
export function tokens(s: string): Token[] {
	let i = 0;
	const parse = (): Token[] => {
		const out: Token[] = [];
		while (i < s.length) {
			const c = s[i];
			if (c === " ") { i++; continue; }
			if (c === "(") { i++; out.push(parse()); continue; }
			if (c === ")") { i++; return out; }
			if (c === '"') {
				let v = "";
				i++;
				while (i < s.length && s[i] !== '"') {
					if (s[i] === "\\" && i + 1 < s.length) i++;
					v += s[i++];
				}
				i++;
				out.push(v);
				continue;
			}
			let j = i;
			while (j < s.length && s[j] !== " " && s[j] !== "(" && s[j] !== ")") j++;
			const atom = s.slice(i, j);
			out.push(atom.toUpperCase() === "NIL" ? null : atom);
			i = j;
		}
		return out;
	};
	return parse();
}

/** "* LIST (\HasNoChildren \Sent) "/" "Sent Items"" as a folder, or null for any other line. */
export function parseList(line: string): ImapFolder | null {
	const m = /^\* (?:LIST|XLIST) (.*)$/i.exec(line);
	if (!m) return null;
	const t = tokens(m[1]);
	if (t.length < 3 || !Array.isArray(t[0])) return null;
	const name = t[2];
	if (typeof name !== "string") return null;
	return {
		flags: (t[0] as Token[]).filter((f): f is string => typeof f === "string"),
		delimiter: typeof t[1] === "string" ? t[1] : null,
		name: fromImapUtf7(name),
	};
}

/** A date for APPEND: "24-Oct-2026 19:35:13 +0000". */
export function imapDate(d: Date): string {
	const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
	const two = (n: number) => String(n).padStart(2, "0");
	return `${two(d.getUTCDate())}-${mon}-${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;
}

export interface FetchedMessage {
	uid: number;
	flags: string[];
	/** Gmail's labels (X-GM-LABELS), such as "\\Inbox", "\\Sent" or "Clients/Invoices". */
	labels: string[];
	date?: Date;
	size?: number;
	body?: Uint8Array;
}

/** One FETCH answer, from inside its brackets; literals come from rawParts(). */
export function parseFetch(text: string, literals: Uint8Array[]): FetchedMessage | null {
	const t = tokens(text);
	const items = Array.isArray(t[0]) ? (t[0] as Token[]) : t;
	const lit = (v: Token): Uint8Array | null => (typeof v === "string" && /^\0\d+$/.test(v) ? literals[Number(v.slice(1))] ?? null : null);
	const str = (v: Token): string | null => {
		const b = lit(v);
		return b ? utf8.decode(b) : typeof v === "string" ? v : null;
	};
	const out: FetchedMessage = { uid: 0, flags: [], labels: [] };
	for (let i = 0; i + 1 < items.length; i += 2) {
		const key = String(items[i]).toUpperCase();
		const v = items[i + 1];
		if (key === "UID") out.uid = Number(v);
		else if (key === "FLAGS" && Array.isArray(v)) out.flags = v.filter((x): x is string => typeof x === "string");
		else if (key === "X-GM-LABELS" && Array.isArray(v)) out.labels = v.map(str).filter((x): x is string => !!x).map((l) => (l.startsWith("\\") ? l : fromImapUtf7(l)));
		else if (key === "INTERNALDATE") {
			const d = parseImapDate(str(v) ?? "");
			if (d) out.date = d;
		} else if (key === "RFC822.SIZE") out.size = Number(v);
		else if (key === "BODY[]" || key === "RFC822") {
			const b = lit(v);
			out.body = b ?? (typeof v === "string" ? enc.encode(v) : new Uint8Array(0));
		}
	}
	return out.uid ? out : null;
}

/** "24-Oct-2026 19:35:13 +0100" as a Date. */
export function parseImapDate(s: string): Date | null {
	const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
	if (!m) return null;
	const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2].toLowerCase());
	if (mon < 0) return null;
	const offset = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
	return new Date(Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60_000);
}

// ── The client ─────────────────────────────────────────────────────

export class Imap {
	private reader: LineReader;
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private tag = 0;
	caps = new Set<string>();
	private conn: Duplex;

	constructor(conn: Duplex) {
		this.conn = conn;
		this.reader = new LineReader(conn.readable);
		this.writer = conn.writable.getWriter();
	}

	private async send(bytes: Uint8Array): Promise<void> {
		await this.writer.write(bytes);
	}

	/** Reads the server's greeting. */
	async hello(): Promise<void> {
		const line = await this.reader.line();
		if (/^\* BYE/i.test(line)) throw new ImapError(`The mail server turned us away: ${line.slice(6)}`);
		if (!/^\* (OK|PREAUTH)/i.test(line)) throw new ImapError("That doesn't look like a mail (IMAP) server.");
		this.readCaps(line);
	}

	private readCaps(line: string): void {
		const m = /CAPABILITY ([^\]]*)/i.exec(line);
		if (m) this.caps = new Set(m[1].trim().split(/\s+/).map((c) => c.toUpperCase()));
	}

	/** Sends one command; literal parts wait for the server's "+" unless it allows LITERAL+. */
	async command(...parts: Part[]): Promise<ImapReply> {
		const tag = `K${++this.tag}`;
		const untagged: string[] = [];
		const literalPlus = this.caps.has("LITERAL+");
		let text = `${tag} `;
		for (let i = 0; i < parts.length; i++) {
			const p = parts[i];
			if (typeof p === "string") {
				text += (i ? " " : "") + p;
				continue;
			}
			const small = p.literal.length <= 4096 && this.caps.has("LITERAL-");
			const plus = literalPlus || small;
			text += `${i ? " " : ""}{${p.literal.length}${plus ? "+" : ""}}`;
			await this.send(enc.encode(text + "\r\n"));
			text = "";
			if (!plus) {
				// Wait for "+ go ahead"; a tagged NO here means the server won't take it.
				for (;;) {
					const line = await this.reader.line();
					if (line.startsWith("+")) break;
					if (line.startsWith(`${tag} `)) return this.finish(line, tag, untagged);
					untagged.push(line);
				}
			}
			await this.send(p.literal);
		}
		await this.send(enc.encode(text + "\r\n"));
		for (;;) {
			const line = await this.reader.line();
			if (line.startsWith(`${tag} `)) return this.finish(line, tag, untagged);
			if (line.startsWith("* ")) {
				untagged.push(line);
				if (/^\* (OK \[)?CAPABILITY/i.test(line)) this.readCaps(line);
			}
		}
	}

	private finish(line: string, tag: string, untagged: string[]): ImapReply {
		const m = /^(OK|NO|BAD)\s?(.*)$/i.exec(line.slice(tag.length + 1));
		const status = (m?.[1].toUpperCase() ?? "BAD") as ImapReply["status"];
		const reply = { status, text: m?.[2] ?? line, untagged };
		this.readCaps(line);
		return reply;
	}

	async capability(): Promise<void> {
		const r = await this.command("CAPABILITY");
		for (const line of r.untagged) this.readCaps(line);
	}

	/** Upgrades a plain connection on port 143 (the caller swaps the socket with startTls first). */
	async starttls(): Promise<void> {
		const r = await this.command("STARTTLS");
		if (r.status !== "OK") throw new ImapError("This server doesn't offer a secure connection on that port. Try port 993.", r);
		this.reader.release();
		this.writer.releaseLock();
	}

	/** Takes over a new (secure) connection after STARTTLS. */
	adopt(conn: Duplex): void {
		this.conn = conn;
		this.reader = new LineReader(conn.readable);
		this.writer = conn.writable.getWriter();
		this.caps = new Set();
	}

	async login(user: string, password: string): Promise<void> {
		if (this.caps.has("LOGINDISABLED")) throw new ImapError("This server doesn't allow signing in over this connection. Try port 993.");
		const r = await this.command("LOGIN", arg(user), arg(password));
		if (r.status !== "OK") throw new ImapError(loginMessage(r.text), r);
		if (!/CAPABILITY/i.test(r.text)) await this.capability();
	}

	async list(): Promise<ImapFolder[]> {
		const special = this.caps.has("SPECIAL-USE") ? " RETURN (SPECIAL-USE)" : "";
		let r = await this.command(`LIST "" "*"${special}`);
		if (r.status !== "OK" && special) r = await this.command(`LIST "" "*"`);
		if (r.status !== "OK") throw new ImapError("We couldn't see the folders in your mailbox.", r);
		return r.untagged.map(parseList).filter((f): f is ImapFolder => f !== null);
	}

	/** Makes a folder. True when it's there afterwards (made now, or already there). */
	async create(name: string): Promise<boolean> {
		const r = await this.command("CREATE", arg(toImapUtf7(name)));
		if (r.status === "OK") return true;
		if (/ALREADYEXISTS|already exists|exists/i.test(r.text)) return true;
		return false;
	}

	async remove(name: string): Promise<boolean> {
		const r = await this.command("DELETE", arg(toImapUtf7(name)));
		return r.status === "OK";
	}

	/** Adds one message to a folder, with its flags and the date it was received. */
	async append(folder: string, message: Uint8Array, flags: string[] = [], date?: Date): Promise<ImapReply> {
		const parts: Part[] = ["APPEND", arg(toImapUtf7(folder))];
		if (flags.length) parts.push(`(${flags.join(" ")})`);
		if (date && !Number.isNaN(date.getTime())) parts.push(`"${imapDate(date)}"`);
		parts.push({ literal: message });
		return this.command(...parts);
	}

	/** Signs in with a Microsoft (or other OAuth) access token instead of a password. */
	async xoauth2(user: string, token: string): Promise<void> {
		const ir = btoa(`user=${user}\x01auth=Bearer ${token}\x01\x01`);
		const tag = `K${++this.tag}`;
		const saslIr = this.caps.has("SASL-IR");
		await this.send(enc.encode(saslIr ? `${tag} AUTHENTICATE XOAUTH2 ${ir}\r\n` : `${tag} AUTHENTICATE XOAUTH2\r\n`));
		let sentIr = saslIr;
		for (;;) {
			const line = await this.reader.line();
			if (line.startsWith("+")) {
				// Before the token: send it. After a refused token the server explains in base64: an empty line ends it.
				await this.send(enc.encode(sentIr ? "\r\n" : `${ir}\r\n`));
				sentIr = true;
				continue;
			}
			if (line.startsWith(`${tag} `)) {
				const r = this.finish(line, tag, []);
				if (r.status !== "OK") throw new ImapError("Microsoft didn't let us into your mailbox. Please sign in with Microsoft again.", r);
				if (!/CAPABILITY/i.test(r.text)) await this.capability();
				return;
			}
		}
	}

	/** Opens a folder read-only. */
	async examine(folder: string): Promise<{ exists: number; uidValidity: number; uidNext: number }> {
		const r = await this.command("EXAMINE", arg(toImapUtf7(folder)));
		if (r.status !== "OK") throw new ImapError(`We couldn't open the folder ${folder}.`, r);
		const num = (re: RegExp) => Number(r.untagged.map((l) => re.exec(l)?.[1]).find(Boolean) ?? 0);
		return { exists: num(/^\* (\d+) EXISTS/i), uidValidity: num(/UIDVALIDITY (\d+)/i), uidNext: num(/UIDNEXT (\d+)/i) };
	}

	/** How many messages a folder holds, without opening it. */
	async count(folder: string): Promise<number> {
		const r = await this.command("STATUS", arg(toImapUtf7(folder)), "(MESSAGES)");
		if (r.status !== "OK") return 0;
		return Number(r.untagged.map((l) => /MESSAGES (\d+)/i.exec(l)?.[1]).find(Boolean) ?? 0);
	}

	/** The message UIDs from `from` to `to` in the open folder. */
	async uids(from: number, to: number): Promise<number[]> {
		const r = await this.command(`UID SEARCH UID ${from}:${to}`);
		if (r.status !== "OK") throw new ImapError("We couldn't list the emails in a folder.", r);
		const out: number[] = [];
		for (const l of r.untagged) {
			const m = /^\* SEARCH(.*)$/i.exec(l);
			if (m) for (const x of m[1].trim().split(/\s+/)) if (/^\d+$/.test(x)) out.push(Number(x));
		}
		// UID SEARCH 5:* always includes the newest message, even below 5.
		return out.filter((u) => u >= from && u <= to).sort((a, b) => a - b);
	}

	/** UIDs of messages in the open folder that arrived on or after a date ("21-Oct-2026"). */
	async since(date: string): Promise<number[]> {
		const r = await this.command(`UID SEARCH SINCE ${date}`);
		if (r.status !== "OK") throw new ImapError("We couldn't list the recent emails.", r);
		const out: number[] = [];
		for (const l of r.untagged) {
			const m = /^\* SEARCH(.*)$/i.exec(l);
			if (m) for (const x of m[1].trim().split(/\s+/)) if (/^\d+$/.test(x)) out.push(Number(x));
		}
		return out.sort((a, b) => a - b);
	}

	/** Fetches messages from the open folder by UID; `items` such as "(UID RFC822.SIZE)". Big literals stay as bytes. */
	async fetch(set: string, items: string, maxLiteral = 1_000_000): Promise<FetchedMessage[]> {
		const tag = `K${++this.tag}`;
		await this.send(enc.encode(`${tag} UID FETCH ${set} ${items}\r\n`));
		const out: FetchedMessage[] = [];
		for (;;) {
			const { line, literals } = await this.reader.rawParts(maxLiteral);
			if (line.startsWith(`${tag} `)) {
				const r = this.finish(line, tag, []);
				if (r.status !== "OK") throw new ImapError(r.text || "The mail server wouldn't send an email.", r);
				return out;
			}
			const m = /^\* \d+ FETCH (.*)$/i.exec(line);
			if (m) {
				const f = parseFetch(m[1], literals);
				if (f) out.push(f);
			}
		}
	}

	async logout(): Promise<void> {
		await this.command("LOGOUT").catch(() => undefined);
		await this.close();
	}

	async close(): Promise<void> {
		this.reader.release();
		try { this.writer.releaseLock(); } catch { /* already released */ }
		await Promise.resolve(this.conn.close()).catch(() => undefined);
	}
}

/** What to tell someone whose sign-in was refused, from the server's words. */
export function loginMessage(text: string): string {
	if (/WEBALERT|web ?login|browser/i.test(text)) return "Your provider wants you to sign in on its website first, then try again.";
	if (/application-specific|app password|app-specific|ALERT.*password/i.test(text)) return "Your provider needs an app password here, not your usual password.";
	if (/UNAVAILABLE|try again later|temporar/i.test(text)) return "Your provider couldn't sign you in just now. Please try again in a few minutes.";
	if (/IMAP.*(disabled|not enabled)|enable IMAP/i.test(text)) return "IMAP is switched off for this mailbox. Switch it on in your provider's settings, then try again.";
	return "Your provider didn't accept that email address and password. Check them, and use an app password if your provider offers one.";
}

/** How we sign in: a password (or app password), or an OAuth access token. */
export type Login = string | { token: string };

/** Connects to a mail server, signs in and hands back the client. */
export async function openImap(server: { host: string; port: number; security: Security | "none" }, user: string, login: Login): Promise<Imap> {
	const conn = await openSocket(server, (m) => new ImapError(m));
	let imap = new Imap(conn.socket);
	try {
		await imap.hello();
		if (server.security === "starttls") {
			await imap.starttls();
			imap.adopt(conn.upgrade());
			await imap.capability();
		}
		if (typeof login === "string") await imap.login(user, login);
		else await imap.xoauth2(user, login.token);
		return imap;
	} catch (e) {
		await imap.close();
		throw e;
	}
}
