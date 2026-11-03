// Mail App addition (not part of upstream Agentic Inbox).
// The API and webhooks (Admin > API & webhooks), the parts that don't need Cloudflare: what an API key
// looks like, what each permission allows, which requests the API answers, and how a webhook is signed.
//
// Other apps call https://<install>/api/ext/v1/... with `Authorization: Bearer mailapp_<id>_<secret>`.
// The installer lets that one path past Cloudflare sign-in; the Worker refuses any request there
// without a valid key. A key only reaches the mailboxes it was made for, and only does what its
// permissions allow. Keys are stored as a SHA-256 hash, so a key can only be seen once, when it's made.
//
// Webhooks: when an email arrives in (or is sent from) a mailbox, Mail App POSTs a JSON event to each
// matching webhook's address, signed with that webhook's secret:
//   Mail-App-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
// It tries up to four times (straight away, then after 1 minute, 10 minutes and 1 hour) and keeps a log
// of each try.

/** Where the API answers. */
export const API_PREFIX = "/api/ext/v1";

export type Scope = "read" | "send" | "organise";
export const SCOPES: Scope[] = ["read", "send", "organise"];

export type WebhookEvent = "email.received" | "email.sent";
export const WEBHOOK_EVENTS: WebhookEvent[] = ["email.received", "email.sent"];

export const MAX_KEYS = 25;
export const MAX_WEBHOOKS = 10;
/** How many recent deliveries each webhook's log shows. */
export const LOG_LENGTH = 20;
/** Seconds to wait before the second, third and fourth tries. */
export const RETRY_DELAYS = [60, 600, 3600];
export const MAX_TRIES = RETRY_DELAYS.length + 1;

/** Whether a failed try is worth trying again: not when the other app said the request itself was wrong. */
export function worthRetrying(status: number): boolean {
	return status === 0 || status === 408 || status === 429 || status >= 500;
}

export interface ApiKey {
	id: string;
	name: string;
	/** Hex SHA-256 of the whole key. */
	hash: string;
	/** The first few characters, so people can tell keys apart ("mailapp_ab12cd34_Xy…"). */
	hint: string;
	/** Mailbox addresses, lower case. */
	mailboxes: string[];
	scopes: Scope[];
	createdAt: string;
	createdBy: string;
	lastUsedAt?: string;
}

export interface Webhook {
	id: string;
	name: string;
	url: string;
	events: WebhookEvent[];
	/** Mailbox addresses, lower case. Empty means every mailbox. */
	mailboxes: string[];
	/** Signs each event. Shown in the admin page so the other app can check signatures. */
	secret: string;
	paused?: boolean;
	createdAt: string;
	createdBy: string;
}

export interface ApiBook {
	keys: ApiKey[];
	webhooks: Webhook[];
}

export interface Delivery {
	id: string;
	webhook: string;
	event: WebhookEvent | "test";
	at: string;
	/** The HTTP status from the other app, or 0 when it couldn't be reached. */
	status: number;
	ok: boolean;
	attempt: number;
	error?: string;
	/** Milliseconds the other app took. */
	ms: number;
}

export const emptyBook = (): ApiBook => ({ keys: [], webhooks: [] });

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomText(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

function randomHex(bytes: number): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new key: the full text (shown once) and what gets stored. */
export async function newKey(input: { name: string; mailboxes: string[]; scopes: Scope[]; by: string; now: string }): Promise<{ key: string; record: ApiKey }> {
	const id = randomHex(4);
	const key = `mailapp_${id}_${randomText(32)}`;
	return {
		key,
		record: {
			id,
			name: input.name,
			hash: await sha256Hex(key),
			hint: `${key.slice(0, 15)}…`,
			mailboxes: [...new Set(input.mailboxes.map((m) => m.trim().toLowerCase()))].sort(),
			scopes: SCOPES.filter((s) => input.scopes.includes(s)),
			createdAt: input.now,
			createdBy: input.by,
		},
	};
}

/** The key's id, from "mailapp_<id>_<secret>", or null if it isn't shaped like a Mail App key. */
export function keyId(key: string): string | null {
	const m = /^mailapp_([0-9a-f]{8})_[A-Za-z0-9]{32}$/.exec(key.trim());
	return m ? m[1] : null;
}

/** The bearer token from an Authorization header (or an X-API-Key header). */
export function keyFromHeaders(headers: Headers): string | null {
	const auth = headers.get("authorization");
	if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
	return headers.get("x-api-key")?.trim() || null;
}

/** Same length and same characters, without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** The stored key a request's key matches, or null. */
export async function findKey(book: ApiBook, key: string): Promise<ApiKey | null> {
	const id = keyId(key);
	if (!id) return null;
	const record = book.keys.find((k) => k.id === id);
	if (!record) return null;
	return sameText(record.hash, await sha256Hex(key.trim())) ? record : null;
}

/** Last used is saved at most this often, so busy apps don't write on every request. */
export const LAST_USED_EVERY_MS = 60 * 60 * 1000;
export function shouldMarkUsed(key: ApiKey, now: Date): boolean {
	return !key.lastUsedAt || now.getTime() - new Date(key.lastUsedAt).getTime() > LAST_USED_EVERY_MS;
}

// -- What the API answers -----------------------------------------------------

const ROUTES: { method: string; pattern: RegExp; scope: Scope }[] = [
	{ method: "GET", pattern: /^\/mailboxes$/, scope: "read" },
	{ method: "GET", pattern: /^\/mailboxes\/[^/]+\/emails$/, scope: "read" },
	{ method: "GET", pattern: /^\/mailboxes\/[^/]+\/emails\/[^/]+$/, scope: "read" },
	{ method: "GET", pattern: /^\/mailboxes\/[^/]+\/emails\/[^/]+\/attachments\/[^/]+$/, scope: "read" },
	{ method: "GET", pattern: /^\/mailboxes\/[^/]+\/threads\/[^/]+$/, scope: "read" },
	{ method: "GET", pattern: /^\/mailboxes\/[^/]+\/search$/, scope: "read" },
	{ method: "GET", pattern: /^\/mailboxes\/[^/]+\/folders$/, scope: "read" },
	{ method: "GET", pattern: /^\/mailboxes\/[^/]+\/labels$/, scope: "read" },
	{ method: "POST", pattern: /^\/mailboxes\/[^/]+\/emails$/, scope: "send" },
	{ method: "POST", pattern: /^\/mailboxes\/[^/]+\/emails\/[^/]+\/(reply|forward)$/, scope: "send" },
	{ method: "PUT", pattern: /^\/mailboxes\/[^/]+\/emails\/[^/]+$/, scope: "organise" },
	{ method: "POST", pattern: /^\/mailboxes\/[^/]+\/emails\/[^/]+\/move$/, scope: "organise" },
	{ method: "PUT", pattern: /^\/mailboxes\/[^/]+\/emails\/[^/]+\/labels$/, scope: "organise" },
];

/**
 * Whether the API answers this request (`path` is what comes after /api/ext/v1), and which permission
 * it needs. Anything not listed here is refused, whatever the key allows.
 */
export function routeFor(method: string, path: string): { scope: Scope } | null {
	const route = ROUTES.find((r) => r.method === method.toUpperCase() && r.pattern.test(path));
	return route ? { scope: route.scope } : null;
}

/** The mailbox a request is about (from /mailboxes/<address>/...), lower case, or null. */
export function mailboxIn(path: string): string | null {
	const m = /^\/mailboxes\/([^/]+)/.exec(path);
	if (!m) return null;
	try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return null; }
}

// -- Checking what an admin asks for ------------------------------------------

export function keyProblem(input: { name: string; mailboxes: string[]; scopes: string[] }, mailboxes: string[], count: number): string | null {
	if (!input.name.trim()) return "Please give the key a name, so you know which app uses it.";
	if (input.name.length > 60) return "Please use a shorter name (60 characters at most).";
	if (!input.scopes.length || input.scopes.some((s) => !SCOPES.includes(s as Scope))) return "Please tick what the key can do.";
	if (!input.mailboxes.length) return "Please tick at least one mailbox.";
	const known = new Set(mailboxes.map((m) => m.toLowerCase()));
	if (input.mailboxes.some((m) => !known.has(m.toLowerCase()))) return "One of those mailboxes doesn't exist any more. Please refresh the page.";
	if (count >= MAX_KEYS) return `You can have up to ${MAX_KEYS} keys. Delete one you no longer use first.`;
	return null;
}

export function webhookProblem(input: { url: string; events: string[]; mailboxes: string[] }, mailboxes: string[], count: number, dev = false): string | null {
	let url: URL;
	try { url = new URL(input.url); } catch { return "Please enter the full web address, starting with https://"; }
	if (url.protocol !== "https:" && !(dev && url.protocol === "http:")) return "The address must start with https://";
	if (!dev && isPrivateHost(url.hostname)) return "That address is on a private network, which Mail App can't reach.";
	if (!input.events.length || input.events.some((e) => !WEBHOOK_EVENTS.includes(e as WebhookEvent))) return "Please tick when to send it.";
	const known = new Set(mailboxes.map((m) => m.toLowerCase()));
	if (input.mailboxes.some((m) => !known.has(m.toLowerCase()))) return "One of those mailboxes doesn't exist any more. Please refresh the page.";
	if (count >= MAX_WEBHOOKS) return `You can have up to ${MAX_WEBHOOKS} webhooks. Delete one you no longer use first.`;
	return null;
}

/** localhost, private IPv4 ranges and the like: nothing a webhook should be sent to. */
export function isPrivateHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
	if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return h.includes(":");
	const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
	if (!v4) return false;
	const [a, b] = [Number(v4[1]), Number(v4[2])];
	return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function newWebhook(input: { name: string; url: string; events: WebhookEvent[]; mailboxes: string[]; by: string; now: string }): Webhook {
	return {
		id: randomHex(6),
		name: input.name.trim() || new URL(input.url).hostname,
		url: input.url.trim(),
		events: WEBHOOK_EVENTS.filter((e) => input.events.includes(e)),
		mailboxes: [...new Set(input.mailboxes.map((m) => m.trim().toLowerCase()))].sort(),
		secret: `whsec_${randomText(32)}`,
		createdAt: input.now,
		createdBy: input.by,
	};
}

/** The webhooks an event goes to. */
export function webhooksFor(book: ApiBook, event: WebhookEvent, mailbox: string): Webhook[] {
	const m = mailbox.toLowerCase();
	return book.webhooks.filter((w) => !w.paused && w.events.includes(event) && (w.mailboxes.length === 0 || w.mailboxes.includes(m)));
}

// -- Signing --------------------------------------------------------------------

async function hmacHex(secret: string, text: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
	return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The Mail-App-Signature header for a body sent at `timestamp` (unix seconds). */
export async function signature(secret: string, timestamp: number, body: string): Promise<string> {
	return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

/** What the other app does: checks a Mail-App-Signature header, refusing ones older than `toleranceSeconds`. */
export async function verifySignature(secret: string, header: string, body: string, nowSeconds: number, toleranceSeconds = 300): Promise<boolean> {
	const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
	const t = Number(parts.t);
	if (!Number.isFinite(t) || !parts.v1 || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
	return sameText(parts.v1, await hmacHex(secret, `${t}.${body}`));
}
