// Mail App addition (not part of upstream Agentic Inbox).
// Admin > API & webhooks: making, changing and deleting API keys, and adding, pausing, testing and deleting
// webhooks. Admins only. The API itself is in workers/lib/api.ts, the rules in shared/api.ts.

import { Hono } from "hono";
import { z } from "zod";
import { API_PREFIX, MAX_KEYS, MAX_WEBHOOKS, SCOPES, WEBHOOK_EVENTS, keyAccess, keyProblem, newKey, newWebhook, webhookProblem, type Scope, type WebhookEvent } from "../../shared/api";
import { apiSwitchedOn, clearDeliveries, loadApiBook, recentDeliveries, sendTest, updateApiBook } from "../lib/api";
import { listMailboxes } from "../lib/email-helpers";
import { requireAdmin } from "../lib/people";
import type { MailboxContext } from "../lib/mailbox";

export const developer = new Hono<MailboxContext>();

const dev = () => !!import.meta.env?.DEV;

developer.get("/api/v1/developer", requireAdmin, async (c) => {
	const [book, mailboxes] = await Promise.all([loadApiBook(c.env.BUCKET), listMailboxes(c.env.BUCKET)]);
	return c.json({
		apiOn: apiSwitchedOn(c.env, dev()),
		baseUrl: `${new URL(c.req.url).origin}${API_PREFIX}`,
		mailboxes: mailboxes.map((m) => m.email.toLowerCase()).sort(),
		keys: book.keys.map(({ hash: _hash, ...k }) => k),
		webhooks: book.webhooks,
		limits: { keys: MAX_KEYS, webhooks: MAX_WEBHOOKS },
	});
});

const KeyBody = z.object({
	name: z.string().max(200),
	mailboxes: z.array(z.string().max(254)).max(500).default([]),
	allMailboxes: z.boolean().default(false),
	scopes: z.array(z.string().max(20)).max(SCOPES.length),
});

developer.post("/api/v1/developer/keys", requireAdmin, async (c) => {
	const input = KeyBody.parse(await c.req.json());
	const [book, mailboxes] = await Promise.all([loadApiBook(c.env.BUCKET), listMailboxes(c.env.BUCKET)]);
	const problem = keyProblem(input, mailboxes.map((m) => m.email), book.keys.length);
	if (problem) return c.json({ error: problem }, 400);
	const { key, record } = await newKey({ name: input.name.trim(), mailboxes: input.mailboxes, allMailboxes: input.allMailboxes, scopes: input.scopes as Scope[], by: c.var.person.email, now: new Date().toISOString() });
	await updateApiBook(c.env.BUCKET, (b) => { b.keys.push(record); });
	const { hash: _hash, ...shown } = record;
	return c.json({ key, record: shown }, 201);
});

// Changing a key's name, permissions or mailboxes keeps the key itself, so apps using it carry on.
developer.patch("/api/v1/developer/keys/:id", requireAdmin, async (c) => {
	const id = c.req.param("id");
	const input = KeyBody.parse(await c.req.json());
	const mailboxes = await listMailboxes(c.env.BUCKET);
	const problem = keyProblem(input, mailboxes.map((m) => m.email), 0);
	if (problem) return c.json({ error: problem }, 400);
	const now = new Date().toISOString();
	const changed = await updateApiBook(c.env.BUCKET, (b) => {
		const k = b.keys.find((x) => x.id === id);
		if (!k) return null;
		delete k.allMailboxes;
		Object.assign(k, { name: input.name.trim(), ...keyAccess(input), updatedAt: now, updatedBy: c.var.person.email });
		const { hash: _hash, ...shown } = k;
		return shown;
	});
	return changed ? c.json(changed) : c.json({ error: "Not found" }, 404);
});

developer.delete("/api/v1/developer/keys/:id", requireAdmin, async (c) => {
	const id = c.req.param("id");
	const found = await updateApiBook(c.env.BUCKET, (b) => {
		const before = b.keys.length;
		b.keys = b.keys.filter((k) => k.id !== id);
		return b.keys.length !== before;
	});
	return found ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
});

const WebhookBody = z.object({
	name: z.string().max(60).default(""),
	url: z.string().max(2000),
	events: z.array(z.string().max(40)).max(WEBHOOK_EVENTS.length),
	mailboxes: z.array(z.string().max(254)).max(500).default([]),
});

developer.post("/api/v1/developer/webhooks", requireAdmin, async (c) => {
	const input = WebhookBody.parse(await c.req.json());
	const [book, mailboxes] = await Promise.all([loadApiBook(c.env.BUCKET), listMailboxes(c.env.BUCKET)]);
	const problem = webhookProblem(input, mailboxes.map((m) => m.email), book.webhooks.length, dev());
	if (problem) return c.json({ error: problem }, 400);
	const hook = newWebhook({ ...input, events: input.events as WebhookEvent[], by: c.var.person.email, now: new Date().toISOString() });
	await updateApiBook(c.env.BUCKET, (b) => { b.webhooks.push(hook); });
	return c.json(hook, 201);
});

developer.patch("/api/v1/developer/webhooks/:id", requireAdmin, async (c) => {
	const { paused } = z.object({ paused: z.boolean() }).parse(await c.req.json());
	const id = c.req.param("id");
	const hook = await updateApiBook(c.env.BUCKET, (b) => {
		const h = b.webhooks.find((w) => w.id === id);
		if (h) h.paused = paused;
		return h;
	});
	return hook ? c.json(hook) : c.json({ error: "Not found" }, 404);
});

developer.delete("/api/v1/developer/webhooks/:id", requireAdmin, async (c) => {
	const id = c.req.param("id");
	const found = await updateApiBook(c.env.BUCKET, (b) => {
		const before = b.webhooks.length;
		b.webhooks = b.webhooks.filter((w) => w.id !== id);
		return b.webhooks.length !== before;
	});
	if (!found) return c.json({ error: "Not found" }, 404);
	c.executionCtx.waitUntil(clearDeliveries(c.env.BUCKET, id).catch(() => {}));
	return c.body(null, 204);
});

developer.post("/api/v1/developer/webhooks/:id/test", requireAdmin, async (c) => {
	const hook = (await loadApiBook(c.env.BUCKET)).webhooks.find((w) => w.id === c.req.param("id"));
	if (!hook) return c.json({ error: "Not found" }, 404);
	const { retry: _retry, ...result } = await sendTest(c.env, hook, hook.mailboxes[0] ?? "");
	return c.json(result);
});

developer.get("/api/v1/developer/webhooks/:id/deliveries", requireAdmin, async (c) => {
	return c.json({ deliveries: await recentDeliveries(c.env.BUCKET, c.req.param("id")) });
});
