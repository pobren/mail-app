// Mail App addition (not part of upstream Agentic Inbox).
// Scheduled send: changing an email that's waiting in Scheduled (see shared/scheduled.ts). Scheduling
// itself happens where emails are sent (POST .../emails, .../reply and .../forward with send_at).

import { Hono } from "hono";
import { validSendAt } from "../../shared/scheduled";
import type { MailboxContext } from "../lib/mailbox";
import { BAD_SEND_AT, forgetScheduled } from "../lib/scheduled-send";

export const scheduled = new Hono<MailboxContext>();

const base = "/api/v1/mailboxes/:mailboxId/emails/:id";
const GONE = "That email isn't waiting to be sent any more. It may have gone already.";

/** Another time: { send_at } in ms, or { now: true } to send it straight away. */
scheduled.post(`${base}/schedule`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { send_at?: unknown; now?: unknown };
	const at = body.now === true ? Date.now() : body.send_at;
	if (body.now !== true && !validSendAt(at)) return c.json({ error: BAD_SEND_AT }, 400);
	const done = await c.var.mailboxStub.rescheduleSend(c.req.param("id"), at as number);
	if (!done) return c.json({ error: GONE }, 404);
	return c.json({ send_at: at });
});

/** Cancel send: it goes back to Drafts to be changed or sent later. */
scheduled.post(`${base}/unschedule`, async (c) => {
	const id = c.req.param("id");
	const mailbox = await c.var.mailboxStub.unscheduleSend(id);
	if (!mailbox) return c.json({ error: GONE }, 404);
	await forgetScheduled(c.env, mailbox, id);
	return c.json({ ok: true });
});
