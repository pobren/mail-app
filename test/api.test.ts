import { test } from "node:test";
import assert from "node:assert/strict";
import {
	emptyBook, findKey, isPrivateHost, keyFromHeaders, keyId, keyProblem, mailboxIn, newKey, newWebhook, routeFor,
	shouldMarkUsed, signature, verifySignature, webhookProblem, webhooksFor, worthRetrying,
} from "../shared/api.ts";

const now = "2026-10-15T12:00:00.000Z";

test("a new key is shown once and stored as a hash", async () => {
	const { key, record } = await newKey({ name: "Zapier", mailboxes: ["Sales@Example.com", "sales@example.com"], scopes: ["send", "read"], by: "a@b.c", now });
	assert.match(key, /^mailapp_[0-9a-f]{8}_[A-Za-z0-9]{32}$/);
	assert.equal(keyId(key), record.id);
	assert.notEqual(record.hash, key);
	assert.deepEqual(record.mailboxes, ["sales@example.com"]);
	assert.deepEqual(record.scopes, ["read", "send"]);
	assert.ok(record.hint.startsWith(key.slice(0, 15)));
	const book = { ...emptyBook(), keys: [record] };
	assert.equal((await findKey(book, key))?.id, record.id);
	assert.equal(await findKey(book, `${key.slice(0, -1)}${key.endsWith("a") ? "b" : "a"}`), null);
	assert.equal(await findKey(book, "nonsense"), null);
});

test("keys come from Authorization: Bearer or X-API-Key", () => {
	assert.equal(keyFromHeaders(new Headers({ authorization: "Bearer mailapp_abc" })), "mailapp_abc");
	assert.equal(keyFromHeaders(new Headers({ "x-api-key": " mailapp_abc " })), "mailapp_abc");
	assert.equal(keyFromHeaders(new Headers()), null);
});

test("the API answers only its own list of requests, each needing one permission", () => {
	assert.deepEqual(routeFor("GET", "/mailboxes"), { scope: "read" });
	assert.deepEqual(routeFor("GET", "/mailboxes/a%40b.com/emails"), { scope: "read" });
	assert.deepEqual(routeFor("get", "/mailboxes/a@b.com/search"), { scope: "read" });
	assert.deepEqual(routeFor("POST", "/mailboxes/a@b.com/emails"), { scope: "send" });
	assert.deepEqual(routeFor("POST", "/mailboxes/a@b.com/emails/1/reply"), { scope: "send" });
	assert.deepEqual(routeFor("POST", "/mailboxes/a@b.com/emails/1/move"), { scope: "organise" });
	assert.deepEqual(routeFor("PUT", "/mailboxes/a@b.com/emails/1/labels"), { scope: "organise" });
	// Not in the API: deleting, settings, people, admin routes.
	assert.equal(routeFor("DELETE", "/mailboxes/a@b.com/emails/1"), null);
	assert.equal(routeFor("PUT", "/mailboxes/a@b.com"), null);
	assert.equal(routeFor("GET", "/people"), null);
	assert.equal(routeFor("GET", "/developer"), null);
	assert.equal(routeFor("POST", "/mailboxes"), null);
	assert.equal(mailboxIn("/mailboxes/Sales%40Example.com/emails"), "sales@example.com");
	assert.equal(mailboxIn("/mailboxes"), null);
});

test("what an admin asks for is checked", () => {
	const boxes = ["a@b.com"];
	assert.match(keyProblem({ name: "", mailboxes: boxes, scopes: ["read"] }, boxes, 0)!, /name/);
	assert.match(keyProblem({ name: "x", mailboxes: boxes, scopes: [] }, boxes, 0)!, /tick what/);
	assert.match(keyProblem({ name: "x", mailboxes: boxes, scopes: ["admin"] }, boxes, 0)!, /tick what/);
	assert.match(keyProblem({ name: "x", mailboxes: [], scopes: ["read"] }, boxes, 0)!, /mailbox/);
	assert.match(keyProblem({ name: "x", mailboxes: ["z@b.com"], scopes: ["read"] }, boxes, 0)!, /doesn't exist/);
	assert.match(keyProblem({ name: "x", mailboxes: boxes, scopes: ["read"] }, boxes, 25)!, /up to 25/);
	assert.equal(keyProblem({ name: "x", mailboxes: ["A@B.com"], scopes: ["read"] }, boxes, 0), null);
	assert.match(webhookProblem({ url: "http://example.com", events: ["email.sent"], mailboxes: [] }, boxes, 0)!, /https/);
	assert.match(webhookProblem({ url: "https://192.168.1.4/x", events: ["email.sent"], mailboxes: [] }, boxes, 0)!, /private/);
	assert.match(webhookProblem({ url: "https://example.com", events: [], mailboxes: [] }, boxes, 0)!, /when/);
	assert.equal(webhookProblem({ url: "https://example.com/hook", events: ["email.sent"], mailboxes: [] }, boxes, 0), null);
	assert.equal(webhookProblem({ url: "http://127.0.0.1:9/x", events: ["email.sent"], mailboxes: [] }, boxes, 0, true), null);
	assert.ok(isPrivateHost("localhost") && isPrivateHost("10.0.0.1") && isPrivateHost("172.20.1.1") && isPrivateHost("[::1]"));
	assert.ok(!isPrivateHost("example.com") && !isPrivateHost("172.32.0.1") && !isPrivateHost("fcbank.com"));
});

test("events go to the webhooks that want them", () => {
	const all = newWebhook({ name: "", url: "https://a.example/h", events: ["email.received"], mailboxes: [], by: "x", now });
	const one = newWebhook({ name: "Sales", url: "https://b.example/h", events: ["email.received", "email.sent"], mailboxes: ["Sales@B.com"], by: "x", now });
	const paused = { ...newWebhook({ name: "", url: "https://c.example/h", events: ["email.sent"], mailboxes: [], by: "x", now }), paused: true };
	const book = { keys: [], webhooks: [all, one, paused] };
	assert.equal(all.name, "a.example");
	assert.match(all.secret, /^whsec_/);
	assert.deepEqual(webhooksFor(book, "email.received", "sales@b.com").map((w) => w.id), [all.id, one.id]);
	assert.deepEqual(webhooksFor(book, "email.received", "other@b.com").map((w) => w.id), [all.id]);
	assert.deepEqual(webhooksFor(book, "email.sent", "SALES@b.com").map((w) => w.id), [one.id]);
});

test("signatures check out, and old or changed ones don't", async () => {
	const body = JSON.stringify({ type: "email.received" });
	const header = await signature("whsec_test", 1_760_000_000, body);
	assert.match(header, /^t=1760000000,v1=[0-9a-f]{64}$/);
	assert.ok(await verifySignature("whsec_test", header, body, 1_760_000_100));
	assert.ok(!(await verifySignature("whsec_test", header, `${body} `, 1_760_000_100)));
	assert.ok(!(await verifySignature("whsec_other", header, body, 1_760_000_100)));
	assert.ok(!(await verifySignature("whsec_test", header, body, 1_760_001_000)));
});

test("retries and last-used", () => {
	assert.ok(worthRetrying(0) && worthRetrying(500) && worthRetrying(429) && worthRetrying(408));
	assert.ok(!worthRetrying(400) && !worthRetrying(404) && !worthRetrying(410));
	const key = { lastUsedAt: "2026-10-15T11:30:00.000Z" } as never;
	assert.ok(!shouldMarkUsed(key, new Date(now)));
	assert.ok(shouldMarkUsed({ ...(key as object), lastUsedAt: "2026-10-15T10:00:00.000Z" } as never, new Date(now)));
});
