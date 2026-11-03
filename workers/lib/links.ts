// Mail App addition (not part of upstream Agentic Inbox).
// Download links for files too big to attach. The files arrive already encrypted by the sender's browser
// (see shared/links.ts); this keeps them in R2 under links/<token>, hands one over only to a visitor who
// proves they hold the link's secret or password, and locks a link after repeated wrong passwords.
import { Hono } from "hono";
import {
	LINK_DAYS,
	LOCK_MINUTES,
	MAX_LINK_BYTES,
	MAX_WRONG_PASSWORDS,
	TOKEN_PATTERN,
	expiryFrom,
	fromB64url,
	newToken,
	sameText,
	sha256,
	toB64url,
} from "shared/links";
import type { Env } from "../types";
import { linkPage } from "./link-page";

const PREFIX = "links/";
const B64URL = /^[A-Za-z0-9_-]+$/;

/** True once PUBLIC_LINKS says /f/ is open to people without a sign-in (always on in local development). */
export function linksAvailable(env: Env, dev: boolean): boolean {
	return dev || env.PUBLIC_LINKS === "on";
}

export interface LinkSummary {
	token: string;
	filename: string;
	size: number;
	protected: boolean;
	created: string;
	expires: string;
}

type Meta = Record<string, string>;

function summary(token: string, m: Meta): LinkSummary {
	return { token, filename: m.filename ?? "", size: Number(m.size) || 0, protected: m.protected === "1", created: m.created ?? "", expires: m.expires ?? "" };
}

function expired(m: Meta, now = Date.now()): boolean {
	return !m.expires || Date.parse(m.expires) <= now;
}

async function remove(bucket: R2Bucket, token: string): Promise<void> {
	await bucket.delete([`${PREFIX}${token}`, `${PREFIX}${token}.lock`]);
}

/** Header the composer sends with each upload: everything about the file except its contents. */
interface UploadMeta {
	filename: string;
	type: string;
	size: number;
	iv: string;
	salt: string;
	iterations: number;
	protected: boolean;
	authHash: string;
}

function parseUploadMeta(raw: string | undefined): UploadMeta | null {
	if (!raw) return null;
	try {
		const m = JSON.parse(raw) as Partial<UploadMeta>;
		const ok =
			typeof m.filename === "string" && m.filename.length > 0 &&
			typeof m.type === "string" && m.type.length <= 200 &&
			typeof m.size === "number" && m.size > 0 && m.size <= MAX_LINK_BYTES &&
			typeof m.iv === "string" && B64URL.test(m.iv) && fromB64url(m.iv).length === 12 &&
			typeof m.salt === "string" && B64URL.test(m.salt) && fromB64url(m.salt).length === 16 &&
			typeof m.iterations === "number" && m.iterations >= 0 && m.iterations <= 10_000_000 &&
			typeof m.protected === "boolean" && (m.protected ? m.iterations >= 100_000 : m.iterations === 0) &&
			typeof m.authHash === "string" && B64URL.test(m.authHash) && fromB64url(m.authHash).length === 32;
		if (!ok) return null;
		return { ...(m as UploadMeta), filename: m.filename!.replace(/[\u0000-\u001f\\/]/g, "_").slice(0, 200) };
	} catch {
		return null;
	}
}

/** Stores one encrypted file sent by the composer. The body is streamed straight into R2. */
export async function storeLink(env: Env, mailboxId: string, request: Request, now = new Date()): Promise<{ status: number; body: { token?: string; expires?: string; error?: string } }> {
	let header: string | undefined;
	try { header = decodeURIComponent(request.headers.get("x-mail-app-link") ?? ""); } catch { header = undefined; }
	const meta = parseUploadMeta(header);
	if (!meta) return { status: 400, body: { error: "This file couldn't be prepared for a download link." } };
	const length = Number(request.headers.get("content-length"));
	// AES-GCM adds a 16-byte tag.
	if (!request.body || !Number.isFinite(length) || length !== meta.size + 16) return { status: 400, body: { error: "This file couldn't be prepared for a download link." } };
	const token = newToken();
	const expires = expiryFrom(now, LINK_DAYS).toISOString();
	await env.BUCKET.put(`${PREFIX}${token}`, request.body, {
		httpMetadata: { contentType: "application/octet-stream" },
		customMetadata: {
			mailbox: mailboxId,
			filename: meta.filename,
			type: meta.type || "application/octet-stream",
			size: String(meta.size),
			iv: meta.iv,
			salt: meta.salt,
			iterations: String(meta.iterations),
			protected: meta.protected ? "1" : "0",
			authHash: meta.authHash,
			created: now.toISOString(),
			expires,
		},
	});
	return { status: 201, body: { token, expires } };
}

/** This mailbox's links, newest first. Expired ones are deleted on the way. */
export async function listLinks(env: Env, mailboxId: string): Promise<LinkSummary[]> {
	const found: LinkSummary[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.BUCKET.list({ prefix: PREFIX, cursor, include: ["customMetadata"] });
		for (const obj of page.objects) {
			if (obj.key.endsWith(".lock")) continue;
			const m = obj.customMetadata ?? {};
			if (m.mailbox !== mailboxId) continue;
			const token = obj.key.slice(PREFIX.length);
			if (expired(m)) await remove(env.BUCKET, token);
			else found.push(summary(token, m));
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return found.sort((a, b) => b.created.localeCompare(a.created));
}

export async function deleteLink(env: Env, mailboxId: string, token: string): Promise<boolean> {
	if (!TOKEN_PATTERN.test(token)) return false;
	const head = await env.BUCKET.head(`${PREFIX}${token}`);
	if (!head || head.customMetadata?.mailbox !== mailboxId) return false;
	await remove(env.BUCKET, token);
	return true;
}

// -- The public side: /f/<token> --------------------------------------------

interface Lock { fails: number; until?: string }

async function readLock(bucket: R2Bucket, token: string): Promise<Lock> {
	const obj = await bucket.get(`${PREFIX}${token}.lock`);
	if (!obj) return { fails: 0 };
	try { return (await obj.json()) as Lock; } catch { return { fails: 0 }; }
}

function lockedFor(lock: Lock, now = Date.now()): number {
	return lock.until ? Math.max(0, Date.parse(lock.until) - now) : 0;
}

async function liveLink(bucket: R2Bucket, token: string): Promise<Meta | null> {
	if (!TOKEN_PATTERN.test(token)) return null;
	const head = await bucket.head(`${PREFIX}${token}`);
	if (!head) return null;
	const m = head.customMetadata ?? {};
	if (expired(m)) { await remove(bucket, token); return null; }
	return m;
}

const NO_STORE = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };

/** Routes anyone can reach, mounted at /f. They never touch a mailbox, only links/. */
export const publicLinks = new Hono<{ Bindings: Env }>();

publicLinks.get("/:token", async (c) => {
	const token = c.req.param("token");
	const exists = !!(await liveLink(c.env.BUCKET, token));
	return new Response(linkPage(exists ? token : null), {
		status: exists ? 200 : 404,
		headers: {
			...NO_STORE,
			"content-type": "text/html; charset=utf-8",
			"x-frame-options": "DENY",
			"x-content-type-options": "nosniff",
			// The page's own script and style only; it talks to nothing but /f/.
			"content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		},
	});
});

publicLinks.get("/:token/info", async (c) => {
	const m = await liveLink(c.env.BUCKET, c.req.param("token"));
	if (!m) return c.json({ error: "gone" }, 404, NO_STORE);
	const lock = await readLock(c.env.BUCKET, c.req.param("token"));
	return c.json({
		protected: m.protected === "1",
		salt: m.salt,
		iterations: Number(m.iterations) || 0,
		size: Number(m.size) || 0,
		expires: m.expires,
		lockedSeconds: Math.ceil(lockedFor(lock) / 1000),
	}, 200, NO_STORE);
});

publicLinks.post("/:token/open", async (c) => {
	const token = c.req.param("token");
	const m = await liveLink(c.env.BUCKET, token);
	if (!m) return c.json({ error: "gone" }, 404, NO_STORE);
	const lock = await readLock(c.env.BUCKET, token);
	const wait = lockedFor(lock);
	if (wait > 0) return c.json({ error: "locked", lockedSeconds: Math.ceil(wait / 1000) }, 429, NO_STORE);

	let auth = "";
	try { auth = String(((await c.req.json()) as { auth?: unknown }).auth ?? ""); } catch { /* treated as wrong */ }
	const proof = B64URL.test(auth) && auth.length < 100 ? toB64url(await sha256(fromB64url(auth))) : "";
	if (!proof || !sameText(proof, m.authHash ?? "")) {
		const fails = (lockedFor(lock) === 0 && lock.until ? 0 : lock.fails) + 1;
		const next: Lock = fails >= MAX_WRONG_PASSWORDS ? { fails: 0, until: new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() } : { fails };
		await c.env.BUCKET.put(`${PREFIX}${token}.lock`, JSON.stringify(next));
		return c.json({ error: "wrong", left: next.until ? 0 : MAX_WRONG_PASSWORDS - fails, lockedSeconds: next.until ? LOCK_MINUTES * 60 : 0 }, 403, NO_STORE);
	}
	if (lock.fails || lock.until) await c.env.BUCKET.delete(`${PREFIX}${token}.lock`);

	const obj = await c.env.BUCKET.get(`${PREFIX}${token}`);
	if (!obj) return c.json({ error: "gone" }, 404, NO_STORE);
	return new Response(obj.body, {
		headers: {
			...NO_STORE,
			"content-type": "application/octet-stream",
			"content-length": String(obj.size),
			"x-mail-app-iv": m.iv ?? "",
			"x-mail-app-name": encodeURIComponent(m.filename ?? "download"),
			"x-mail-app-type": encodeURIComponent(m.type ?? "application/octet-stream"),
		},
	});
});

// Nothing else lives under /f/: anything that doesn't match above stops here and never reaches the app.
publicLinks.all("*", () => new Response("Not found", { status: 404, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" } }));
