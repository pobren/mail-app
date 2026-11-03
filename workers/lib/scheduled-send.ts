// Mail App addition (not part of upstream Agentic Inbox).
// Scheduled send, the Worker's side (see shared/scheduled.ts). The three ways of sending (new email,
// reply, forward) file the email in Scheduled instead of Sent and call scheduleEmail rather than sending
// it. What to send, attachments and all, waits in R2 until the mailbox's alarm sends it
// (workers/durableObject/scheduled.ts).

import { scheduledKey, validSendAt } from "../../shared/scheduled";
import type { SendEmailParams } from "../email-sender";
import type { EmailEventData } from "./api";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";

export interface ScheduledPayload {
	params: SendEmailParams;
	/** How many people it goes to, for the sending limit when it goes. */
	recipients: number;
	/** "Remind me if no reply": this long after it goes, or null. */
	remindAfterMs: number | null;
	/** For the email.sent webhook event, less the date (it's dated when it goes). */
	event: Omit<EmailEventData, "date">;
}

export async function scheduleEmail(
	env: Env, stub: DurableObjectStub<MailboxDO>, mailbox: string, emailId: string, sendAt: number, payload: ScheduledPayload,
): Promise<void> {
	await env.BUCKET.put(scheduledKey(mailbox, emailId), JSON.stringify(payload), { httpMetadata: { contentType: "application/json" } });
	await stub.scheduleSend(mailbox, emailId, sendAt);
}

export async function loadScheduled(env: Env, mailbox: string, emailId: string): Promise<ScheduledPayload | null> {
	try {
		const obj = await env.BUCKET.get(scheduledKey(mailbox, emailId));
		return obj ? ((await obj.json()) as ScheduledPayload) : null;
	} catch {
		return null;
	}
}

export async function forgetScheduled(env: Env, mailbox: string, emailId: string): Promise<void> {
	await env.BUCKET.delete(scheduledKey(mailbox, emailId));
}

export const BAD_SEND_AT = "Choose a time at least a minute from now and no more than a year ahead.";

/** The send time asked for: a valid time, null for "send now", or "bad". */
export function sendAtOf(v: number | undefined): number | null | "bad" {
	if (v === undefined) return null;
	return validSendAt(v) ? v : "bad";
}
