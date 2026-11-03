// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: people can only reach mailboxes that are theirs (team access).

/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation.
 * Checks if the mailbox exists in R2, then instantiates the DO stub
 * and attaches it to the Hono context (`c.var.mailboxStub`).
 */
import { createMiddleware } from "hono/factory";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";
import { canOpen } from "../../shared/people";
import type { PeopleVars } from "./people";

export type MailboxContext = {
	Bindings: Env;
	Variables: PeopleVars & {
		mailboxStub: DurableObjectStub<MailboxDO>;
	};
};

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId);

	// Mail App: someone else's mailbox looks the same as one that doesn't exist.
	if (!canOpen(c.var.person, mailboxId) && !adminRoute(c.req.method, c.req.path, c.var.person?.role)) {
		return c.json({ error: "Not found" }, 404);
	}

	// Verify mailbox exists
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await c.env.BUCKET.head(key);
	if (!obj) {
		return c.json({ error: "Not found" }, 404);
	}

	// Instantiate DO stub
	const ns = c.env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	const stub = ns.get(id);

	c.set("mailboxStub", stub);
	
	await next();
});

/**
 * Mail App: the few mailbox routes an admin can use without opening the mailbox: managing its extra
 * addresses and catch-all, which the Mailboxes page does for everyone.
 */
function adminRoute(method: string, path: string, role: string | undefined): boolean {
	if (role !== "admin") return false;
	return /\/addresses(\/[^/]+)?$/.test(path) || (method === "PUT" && /\/(catch-all|people)$/.test(path));
}
