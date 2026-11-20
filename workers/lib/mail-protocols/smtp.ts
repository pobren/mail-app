// Mail App addition (not part of upstream Agentic Inbox).
// Just enough of an SMTP client (RFC 5321, with AUTH from RFC 4954 and STARTTLS from RFC 3207) to send as
// an Other account through its provider's own server: Gmail, iCloud and the rest then sign the email
// themselves, so it arrives as genuinely theirs. Cloudflare doesn't allow port 25, so it's always the
// submission ports, 465 (secure from the start) or 587 (STARTTLS).

import { ByteReader, openSocket, type Duplex, type Security } from "./socket.ts";

export class SmtpError extends Error {
	readonly code: number;
	constructor(message: string, code = 0) {
		super(message);
		this.code = code;
	}
}

const enc = new TextEncoder();

interface Reply {
	code: number;
	lines: string[];
}

export class Smtp {
	private reader: ByteReader;
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private conn: Duplex;
	ext = new Set<string>();
	private authMethods = new Set<string>();

	constructor(conn: Duplex) {
		this.conn = conn;
		this.reader = new ByteReader(conn.readable, (m) => new SmtpError(m));
		this.writer = conn.writable.getWriter();
	}

	private async send(line: string): Promise<void> {
		await this.writer.write(enc.encode(`${line}\r\n`));
	}

	private async reply(): Promise<Reply> {
		const lines: string[] = [];
		for (;;) {
			const line = await this.reader.line();
			const m = /^(\d{3})([ -])?(.*)$/.exec(line);
			if (!m) throw new SmtpError("That doesn't look like a mail (SMTP) server.");
			lines.push(m[3]);
			if (m[2] !== "-") return { code: Number(m[1]), lines };
		}
	}

	private async expect(ok: (code: number) => boolean, fail: (r: Reply) => string): Promise<Reply> {
		const r = await this.reply();
		if (!ok(r.code)) throw new SmtpError(fail(r), r.code);
		return r;
	}

	async hello(name: string): Promise<void> {
		await this.expect((c) => c === 220, () => "That mail server isn't taking email just now.");
		await this.ehlo(name);
	}

	async ehlo(name: string): Promise<void> {
		await this.send(`EHLO ${name}`);
		const r = await this.expect((c) => c === 250, () => "That mail server didn't answer properly.");
		this.ext = new Set(r.lines.slice(1).map((l) => l.split(/\s+/)[0].toUpperCase()));
		const auth = r.lines.find((l) => /^AUTH[ =]/i.test(l));
		this.authMethods = new Set(auth ? auth.slice(5).trim().toUpperCase().split(/\s+/) : []);
	}

	async starttls(): Promise<void> {
		if (!this.ext.has("STARTTLS")) throw new SmtpError("This server doesn't offer a secure connection on that port. Try port 465.");
		await this.send("STARTTLS");
		await this.expect((c) => c === 220, () => "This server wouldn't make the connection secure. Try port 465.");
		this.reader.release();
		this.writer.releaseLock();
	}

	adopt(conn: Duplex): void {
		this.conn = conn;
		this.reader = new ByteReader(conn.readable, (m) => new SmtpError(m));
		this.writer = conn.writable.getWriter();
	}

	async login(user: string, password: string): Promise<void> {
		const fail = (r: Reply) => smtpLoginMessage(r.lines.join(" "));
		if (this.authMethods.has("PLAIN") || !this.authMethods.has("LOGIN")) {
			await this.send(`AUTH PLAIN ${b64(`\0${user}\0${password}`)}`);
			await this.expect((c) => c === 235, fail);
			return;
		}
		await this.send("AUTH LOGIN");
		await this.expect((c) => c === 334, fail);
		await this.send(b64(user));
		await this.expect((c) => c === 334, fail);
		await this.send(b64(password));
		await this.expect((c) => c === 235, fail);
	}

	/** Sends one message. `message` is the whole email with CRLF line ends. */
	async sendMail(from: string, recipients: string[], message: Uint8Array): Promise<void> {
		const bad = (r: Reply) => sendMessage(r);
		await this.send(`MAIL FROM:<${from}>${this.ext.has("SMTPUTF8") && /[^\x00-\x7f]/.test(from) ? " SMTPUTF8" : ""}`);
		await this.expect((c) => c === 250, bad);
		for (const to of recipients) {
			await this.send(`RCPT TO:<${to}>`);
			await this.expect((c) => c === 250 || c === 251, (r) => r.code >= 500 ? `Not sent. ${to} was refused: ${r.lines.join(" ")}` : sendMessage(r));
		}
		await this.send("DATA");
		await this.expect((c) => c === 354, bad);
		await this.writer.write(dotStuff(message));
		await this.expect((c) => c === 250, bad);
	}

	async quit(): Promise<void> {
		try {
			await this.send("QUIT");
			await this.reply();
		} catch { /* closing anyway */ }
		await this.close();
	}

	async close(): Promise<void> {
		this.reader.release();
		try { this.writer.releaseLock(); } catch { /* already released */ }
		await Promise.resolve(this.conn.close()).catch(() => undefined);
	}
}

function b64(s: string): string {
	const bytes = enc.encode(s);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

/** Lines starting with "." get another, the message ends with CRLF.CRLF (RFC 5321 section 4.5.2). */
export function dotStuff(message: Uint8Array): Uint8Array {
	let dots = 0;
	for (let i = 0; i < message.length; i++) if (message[i] === 0x2e && (i === 0 || message[i - 1] === 0x0a)) dots++;
	const endsWithCrlf = message.length >= 2 && message[message.length - 2] === 0x0d && message[message.length - 1] === 0x0a;
	const out = new Uint8Array(message.length + dots + (endsWithCrlf ? 0 : 2) + 3);
	let at = 0;
	for (let i = 0; i < message.length; i++) {
		if (message[i] === 0x2e && (i === 0 || message[i - 1] === 0x0a)) out[at++] = 0x2e;
		out[at++] = message[i];
	}
	if (!endsWithCrlf) { out[at++] = 0x0d; out[at++] = 0x0a; }
	out[at++] = 0x2e; out[at++] = 0x0d; out[at++] = 0x0a;
	return out.subarray(0, at);
}

export function smtpLoginMessage(text: string): string {
	if (/application-specific|app password|InvalidSecondFactor|534[ -]5\.7\.9/i.test(text)) return "Your provider needs an app password for sending, not your usual password.";
	if (/web ?login|browser|WebLoginRequired/i.test(text)) return "Your provider wants you to sign in on its website first, then try again.";
	if (/disabled|not enabled|SmtpClientAuthentication/i.test(text)) return "Sending from apps (SMTP) is switched off for this account. Switch it on in your provider's settings, then try again.";
	return "Your provider didn't accept that email address and password for sending. Check them, and use an app password if your provider offers one.";
}

function sendMessage(r: Reply): string {
	const text = r.lines.join(" ").trim();
	if (r.code === 552 || /size|too large|too big/i.test(text)) return "Not sent. The email is bigger than your provider allows.";
	if (r.code === 550 && /limit|quota|rate/i.test(text)) return "Not sent. Your provider says you've reached its sending limit for now.";
	if (r.code === 421 || r.code === 451 || r.code === 450) return "Not sent. Your provider is busy just now. Please try again in a few minutes.";
	return `Not sent. Your provider said: ${text || `error ${r.code}`}`;
}

/** Connects, says hello, makes the connection secure if needed and signs in. */
export async function openSmtp(server: { host: string; port: number; security: Security | "none" }, user: string, password: string, helloName: string): Promise<Smtp> {
	const conn = await openSocket(server, (m) => new SmtpError(m));
	const smtp = new Smtp(conn.socket);
	try {
		await smtp.hello(helloName);
		if (server.security === "starttls") {
			await smtp.starttls();
			smtp.adopt(conn.upgrade());
			await smtp.ehlo(helloName);
		}
		await smtp.login(user, password);
		return smtp;
	} catch (e) {
		await smtp.close();
		throw e;
	}
}
