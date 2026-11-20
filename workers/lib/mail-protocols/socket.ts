// Mail App addition (not part of upstream Agentic Inbox).
// The pieces the IMAP, POP3 and SMTP clients share: a connection made with Cloudflare Workers' TCP
// sockets (secure from the start, or made secure with STARTTLS), and a reader that hands back lines
// and blocks of bytes without copying the whole buffer each time more arrives (emails can be 25 MB).

export interface Duplex {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	close(): Promise<void> | void;
}

export type Security = "tls" | "starttls";

const CONNECT_MS = 15_000;
const WAIT_MS = 30_000;

/**
 * Opens a connection. "none" (no encryption) is only for trying Mail App on your own computer
 * against a test server; the Worker never offers it otherwise.
 */
export async function openSocket(
	server: { host: string; port: number; security: Security | "none" },
	err: (message: string) => Error,
): Promise<{ socket: Duplex; upgrade: () => Duplex }> {
	const { connect } = await import("cloudflare:sockets");
	const secureTransport = server.security === "tls" ? "on" : server.security === "starttls" ? "starttls" : "off";
	let socket: ReturnType<typeof connect>;
	try {
		socket = connect({ hostname: server.host, port: server.port }, { secureTransport, allowHalfOpen: false });
	} catch {
		throw err("We couldn't reach that mail server. Check its name and port.");
	}
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		await Promise.race([
			socket.opened,
			new Promise((_, no) => { timer = setTimeout(() => no(new Error("timeout")), CONNECT_MS); }),
		]);
	} catch {
		await Promise.resolve(socket.close()).catch(() => undefined);
		throw err(`We couldn't reach ${server.host} on port ${server.port}. Check the server name and port.`);
	} finally {
		if (timer !== null) clearTimeout(timer);
	}
	return { socket, upgrade: () => socket.startTls() };
}

/** Reads from a connection: CRLF lines, a set number of bytes, or everything up to a line holding only ".". */
export class ByteReader {
	private chunks: Uint8Array[] = [];
	/** How far into chunks[0] has been used. */
	private offset = 0;
	private buffered = 0;
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private err: (message: string) => Error;

	constructor(readable: ReadableStream<Uint8Array>, err: (message: string) => Error) {
		this.reader = readable.getReader();
		this.err = err;
	}

	private async more(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const timeout = new Promise<never>((_, no) => { timer = setTimeout(() => no(this.err("The mail server stopped answering.")), WAIT_MS); });
		try {
			const { value, done } = await Promise.race([this.reader.read(), timeout]);
			if (done) throw this.err("The mail server closed the connection.");
			if (value.length) {
				this.chunks.push(value);
				this.buffered += value.length;
			}
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	}

	/** Takes n bytes off the front (n must be buffered). */
	private take(n: number): Uint8Array {
		const out = new Uint8Array(n);
		let at = 0;
		while (at < n) {
			const c = this.chunks[0];
			const avail = c.length - this.offset;
			const want = Math.min(avail, n - at);
			out.set(c.subarray(this.offset, this.offset + want), at);
			at += want;
			this.offset += want;
			if (this.offset === c.length) {
				this.chunks.shift();
				this.offset = 0;
			}
		}
		this.buffered -= n;
		return out;
	}

	/** Where the next line feed is, counted from the read position, or -1. */
	private findNewline(): number {
		let pos = 0;
		for (let i = 0; i < this.chunks.length; i++) {
			const c = this.chunks[i];
			const start = i === 0 ? this.offset : 0;
			const nl = c.indexOf(0x0a, start);
			if (nl >= 0) return pos + (nl - start);
			pos += c.length - start;
		}
		return -1;
	}

	/** One line as bytes, without its CRLF. */
	async lineBytes(max = 1_000_000): Promise<Uint8Array> {
		for (;;) {
			const nl = this.findNewline();
			if (nl >= 0) {
				const raw = this.take(nl + 1);
				return raw.subarray(0, nl > 0 && raw[nl - 1] === 0x0d ? nl - 1 : nl);
			}
			if (this.buffered > max) throw this.err("The mail server sent a line that was far too long.");
			await this.more();
		}
	}

	async line(max?: number): Promise<string> {
		return latin1.decode(await this.lineBytes(max));
	}

	async bytes(n: number, max = 30_000_000): Promise<Uint8Array> {
		if (n > max) throw this.err("The mail server sent far more than we asked for.");
		while (this.buffered < n) await this.more();
		return this.take(n);
	}

	/**
	 * POP3 and SMTP's multi-line answers: everything up to a line holding only ".", with the
	 * extra dot taken off lines that start with one. Lines come back joined with CRLF.
	 */
	async dotted(max: number): Promise<Uint8Array> {
		const parts: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const line = await this.lineBytes(max);
			if (line.length === 1 && line[0] === 0x2e) break;
			const body = line[0] === 0x2e ? line.subarray(1) : line;
			size += body.length + 2;
			if (size > max) throw this.err("TOO_BIG");
			parts.push(body);
		}
		const out = new Uint8Array(size);
		let at = 0;
		for (const p of parts) {
			out.set(p, at);
			at += p.length;
			out[at++] = 0x0d;
			out[at++] = 0x0a;
		}
		return out;
	}

	release(): void {
		try { this.reader.releaseLock(); } catch { /* already released */ }
	}
}

const latin1 = new TextDecoder("latin1");
