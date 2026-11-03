// Mail App addition (not part of upstream Agentic Inbox).
// The API and webhooks on the Worker side: the keys and webhooks file in R2, letting a request with a
// valid key through to the same routes the app uses (limited to that key's mailboxes and permissions),
// and sending webhook events. The rules themselves are in shared/api.ts.

import {
	API_PREFIX, LOG_LENGTH, MAX_TRIES, emptyBook, findKey, mailboxIn, routeFor, shouldMarkUsed, signature, webhooksFor, worthRetrying,
	type ApiBook, type ApiKey, type Delivery, type Webhook, type WebhookEvent,
} from "../../shared/api";
import type { Person } from "../../shared/people";
import type { Env } from "../types";

export const API_BOOK_KEY = "api/book.json";
const DELIVERIES = "api/deliveries/";
const KEEP_TRIES = 100;

export async function loadApiBook(bucket: R2Bucket): Promise<ApiBook> {
	const obj = await bucket.get(API_BOOK_KEY);
	if (!obj) return emptyBook();
	try {
		const book = (await obj.json()) as Partial<ApiBook>;
		return { keys: book.keys ?? [], webhooks: book.webhooks ?? [] };
	} catch {
		return emptyBook();
	}
}

export async function updateApiBook<T>(bucket: R2Bucket, change: (book: ApiBook) => T): Promise<T> {
	const book = await loadApiBook(bucket);
	const result = change(book);
	await bucket.put(API_BOOK_KEY, JSON.stringify(book), { httpMetadata: { contentType: "application/json" } });
	return result;
}

/** The API is on once the installer has opened its path past Cloudflare sign-in (always, when testing locally). */
export function apiSwitchedOn(env: Env, dev = false): boolean {
	return dev || env.PUBLIC_API === "on";
}

/** Who a key acts as: someone who uses just the key's mailboxes, never an admin. */
export function keyPerson(key: ApiKey): Person {
	return {
		email: `api-key-${key.id}@mailapp.invalid`,
		name: key.name,
		role: "member",
		mailboxes: key.mailboxes,
		adminAccess: [],
		status: "active",
		invitedAt: key.createdAt,
	};
}

function apiError(status: number, error: string): Response {
	return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

/**
 * Checks an /api/ext/v1/... request. Returns the internal request to run (the same path under /api/v1)
 * and who it runs as, or a response refusing it.
 */
export async function admitApiRequest(req: Request, env: Env, ctx: ExecutionContext, key: string | null, dev = false): Promise<{ request: Request; person: Person } | Response> {
	if (!apiSwitchedOn(env, dev)) return apiError(503, "The API isn't switched on yet. The README shows how to switch it on.");
	const url = new URL(req.url);
	const path = url.pathname.slice(API_PREFIX.length) || "/";
	if (!url.pathname.startsWith(`${API_PREFIX}/`) && url.pathname !== API_PREFIX) return apiError(404, "Not found. The API lives under /api/ext/v1/.");
	if (!key) return apiError(401, "Missing API key. Send it as: Authorization: Bearer mailapp_…");
	const book = await loadApiBook(env.BUCKET);
	const record = await findKey(book, key);
	if (!record) return apiError(401, "That API key isn't valid. It may have been deleted.");

	const route = routeFor(req.method, path);
	if (!route) return apiError(404, "The API doesn't have that request. See docs/api.md in the Mail App repository for the list.");
	if (!record.scopes.includes(route.scope)) return apiError(403, `This key can't ${route.scope === "read" ? "read mail" : route.scope === "send" ? "send mail" : "move or label mail"}. An admin can make a new key that can.`);
	const mailbox = mailboxIn(path);
	if (mailbox && !record.mailboxes.includes(mailbox)) return apiError(404, "Not found");

	if (shouldMarkUsed(record, new Date())) {
		ctx.waitUntil(updateApiBook(env.BUCKET, (b) => {
			const k = b.keys.find((x) => x.id === record.id);
			if (k) k.lastUsedAt = new Date().toISOString();
		}).catch(() => {}));
	}

	const inner = new URL(`/api/v1${path}${url.search}`, url.origin);
	const headers = new Headers(req.headers);
	headers.delete("authorization");
	headers.delete("x-api-key");
	headers.delete("cookie");
	const request = new Request(inner, { method: req.method, headers, body: req.body, redirect: "manual" });
	return { request, person: keyPerson(record) };
}

// -- Webhooks ---------------------------------------------------------------------

export interface EmailEventData {
	id: string;
	thread_id: string;
	folder: string;
	subject: string;
	from: string;
	from_name?: string | null;
	to: string;
	cc?: string | null;
	date: string;
	has_attachments: boolean;
}

/**
 * Sends an event to every webhook that wants it. A try that fails is booked again in the mailbox's
 * Durable Object (see durableObject/webhooks.ts). Never throws: failures only go in the delivery log.
 */
export function emitEvent(env: Env, ctx: ExecutionContext, event: WebhookEvent, mailbox: string, email: EmailEventData): void {
	ctx.waitUntil((async () => {
		const book = await loadApiBook(env.BUCKET);
		const hooks = webhooksFor(book, event, mailbox);
		if (!hooks.length) return;
		const m = mailbox.toLowerCase();
		const body = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type: event, created: new Date().toISOString(), mailbox: m, data: { email } });
		await Promise.all(hooks.map(async (hook) => {
			const id = crypto.randomUUID();
			const result = await sendOnce(env, hook, event, body, id, 1);
			if (!result.ok && result.retry) {
				await env.MAILBOX.get(env.MAILBOX.idFromName(m)).queueWebhookRetry({ id, webhookId: hook.id, event, body, attempt: 1 });
			}
		}));
	})().catch((e) => console.error("Webhook events failed:", (e as Error).message)));
}

/** Sends a test event straight away, once, for the admin page's "Send a test" button. */
export async function sendTest(env: Env, hook: Webhook, mailbox: string): Promise<Delivery & { retry: boolean }> {
	const body = JSON.stringify({
		id: `evt_${crypto.randomUUID()}`, type: "test", created: new Date().toISOString(), mailbox,
		data: { message: "This is a test from Mail App. If you can read this, the webhook works." },
	});
	return sendOnce(env, hook, "test", body, crypto.randomUUID(), 1);
}

/** One try at sending an event to a webhook, written to its delivery log. */
export async function sendOnce(env: Env, hook: Webhook, event: WebhookEvent | "test", body: string, id: string, attempt: number): Promise<Delivery & { retry: boolean }> {
	const started = Date.now();
	const at = new Date().toISOString();
	let delivery: Delivery;
	try {
		const res = await fetch(hook.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent": "Mail-App-Webhooks/1",
				"mail-app-event": event,
				"mail-app-delivery": id,
				"mail-app-signature": await signature(hook.secret, Math.floor(Date.now() / 1000), body),
			},
			body,
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
		delivery = { id, webhook: hook.id, event, at, status: res.status, ok: res.ok, attempt, ms: Date.now() - started, ...(res.ok ? {} : { error: `It answered ${res.status}` }) };
	} catch (e) {
		const timedOut = (e as Error)?.name === "TimeoutError";
		delivery = { id, webhook: hook.id, event, at, status: 0, ok: false, attempt, ms: Date.now() - started, error: timedOut ? "It didn't answer within 10 seconds" : "It couldn't be reached" };
	}
	await logDelivery(env.BUCKET, delivery).catch(() => {});
	return { ...delivery, retry: event !== "test" && !delivery.ok && attempt < MAX_TRIES && worthRetrying(delivery.status) };
}

/** Each try is its own small file, newest first by name, so tries never overwrite each other. */
async function logDelivery(bucket: R2Bucket, d: Delivery): Promise<void> {
	const newestFirst = String(9_999_999_999_999 - Date.now()).padStart(13, "0");
	await bucket.put(`${DELIVERIES}${d.webhook}/${newestFirst}-${d.id}-${d.attempt}.json`, JSON.stringify(d));
	// Keep the newest hundred tries; the page shows the newest few.
	const listed = await bucket.list({ prefix: `${DELIVERIES}${d.webhook}/`, limit: 200 });
	if (listed.objects.length > KEEP_TRIES) await bucket.delete(listed.objects.slice(KEEP_TRIES).map((o) => o.key));
}

export async function recentDeliveries(bucket: R2Bucket, webhookId: string): Promise<Delivery[]> {
	const listed = await bucket.list({ prefix: `${DELIVERIES}${webhookId}/`, limit: LOG_LENGTH });
	const items = await Promise.all(listed.objects.map(async (o) => (await (await bucket.get(o.key))?.json()) as Delivery | undefined));
	return items.filter((d): d is Delivery => !!d);
}

/** Removes a deleted webhook's log. */
export async function clearDeliveries(bucket: R2Bucket, webhookId: string): Promise<void> {
	let cursor: string | undefined;
	do {
		const listed = await bucket.list({ prefix: `${DELIVERIES}${webhookId}/`, cursor });
		if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key));
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
}
