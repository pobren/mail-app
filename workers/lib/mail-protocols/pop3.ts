// Mail App addition (not part of upstream Agentic Inbox).
// Just enough of a POP3 client (RFC 1939, with STLS from RFC 2595) for Other accounts: sign in, list the
// messages with their sizes and unique ids (UIDL), and fetch each one whole (RETR). Mail is always left
// on the server: nothing here deletes anything.

import { ByteReader, openSocket, type Duplex, type Security } from "./socket.ts";

export class Pop3Error extends Error {}

const enc = new TextEncoder();

export interface Pop3Message {
	/** Its number in this session (1 is the oldest). */
	n: number;
	size: number;
	/** The server's lasting id for it. */
	uidl: string;
}

export class Pop3 {
	private reader: ByteReader;
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private conn: Duplex;

	constructor(conn: Duplex) {
		this.conn = conn;
		this.reader = new ByteReader(conn.readable, (m) => new Pop3Error(m));
		this.writer = conn.writable.getWriter();
	}

	private async send(line: string): Promise<void> {
		await this.writer.write(enc.encode(`${line}\r\n`));
	}

	/** One reply line; throws on -ERR with `fail` (or the server's own words). */
	private async ok(fail?: (text: string) => string): Promise<string> {
		const line = await this.reader.line();
		if (line.startsWith("+OK")) return line.slice(3).trim();
		const text = line.replace(/^-ERR\s*/i, "");
		throw new Pop3Error(fail ? fail(text) : text || "The mail server said no.");
	}

	async hello(): Promise<void> {
		await this.ok(() => "That doesn't look like a POP3 mail server.");
	}

	async stls(): Promise<void> {
		await this.send("STLS");
		await this.ok(() => "This server doesn't offer a secure connection on that port. Try port 995.");
		this.reader.release();
		this.writer.releaseLock();
	}

	adopt(conn: Duplex): void {
		this.conn = conn;
		this.reader = new ByteReader(conn.readable, (m) => new Pop3Error(m));
		this.writer = conn.writable.getWriter();
	}

	async login(user: string, password: string): Promise<void> {
		if (/[\r\n]/.test(user) || /[\r\n]/.test(password)) throw new Pop3Error("That user name or password has a line break in it.");
		await this.send(`USER ${user}`);
		await this.ok(popLoginMessage);
		await this.send(`PASS ${password}`);
		await this.ok(popLoginMessage);
	}

	/** Every message waiting, oldest first, with its size and UIDL. */
	async list(): Promise<Pop3Message[]> {
		await this.send("LIST");
		await this.ok();
		const sizes = new Map<number, number>();
		for (const line of decode(await this.reader.dotted(20_000_000)).split("\r\n")) {
			const m = /^(\d+)\s+(\d+)/.exec(line);
			if (m) sizes.set(Number(m[1]), Number(m[2]));
		}
		await this.send("UIDL");
		await this.ok(() => "This POP3 server can't tell its emails apart (no UIDL), so Mail App can't check it safely. Try IMAP instead.");
		const out: Pop3Message[] = [];
		for (const line of decode(await this.reader.dotted(20_000_000)).split("\r\n")) {
			const m = /^(\d+)\s+(\S+)/.exec(line);
			if (m) out.push({ n: Number(m[1]), uidl: m[2], size: sizes.get(Number(m[1])) ?? 0 });
		}
		return out.sort((a, b) => a.n - b.n);
	}

	async retr(n: number, max: number): Promise<Uint8Array> {
		await this.send(`RETR ${n}`);
		await this.ok();
		return this.reader.dotted(max);
	}

	async quit(): Promise<void> {
		try {
			await this.send("QUIT");
			await this.reader.line();
		} catch { /* closing anyway */ }
		await this.close();
	}

	async close(): Promise<void> {
		this.reader.release();
		try { this.writer.releaseLock(); } catch { /* already released */ }
		await Promise.resolve(this.conn.close()).catch(() => undefined);
	}
}

const decode = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

export function popLoginMessage(text: string): string {
	if (/app.?password|application.?specific/i.test(text)) return "Your provider needs an app password here, not your usual password.";
	if (/web ?login|browser|WEBALERT/i.test(text)) return "Your provider wants you to sign in on its website first, then try again.";
	if (/pop.*(disabled|not enabled|not allowed)|enable pop/i.test(text)) return "POP3 is switched off for this account. Switch it on in your provider's settings, then try again.";
	if (/in use|locked|try again later|temporar/i.test(text)) return "Your provider couldn't sign you in just now. Please try again in a few minutes.";
	return "Your provider didn't accept that email address and password. Check them, and use an app password if your provider offers one.";
}

export async function openPop3(server: { host: string; port: number; security: Security | "none" }, user: string, password: string): Promise<Pop3> {
	const conn = await openSocket(server, (m) => new Pop3Error(m));
	let pop = new Pop3(conn.socket);
	try {
		await pop.hello();
		if (server.security === "starttls") {
			await pop.stls();
			pop.adopt(conn.upgrade());
		}
		await pop.login(user, password);
		return pop;
	} catch (e) {
		await pop.close();
		throw e;
	}
}
