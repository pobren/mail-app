// Mail App addition (not part of upstream Agentic Inbox).
// Keeps track of whether this install can send email to anyone (see shared/sending.ts), in R2 at
// setup/sending.json. Everyday sends record setup problems they hit; a sending check (the mailbox
// emailing itself) is the only thing that marks sending as working. Each send is also counted for
// Admin > Reports, in the mailbox it was sent from.
import { sendEmail, type SendEmailParams } from "../email-sender";
import { CHECK_SUBJECT, afterCheck, afterSend, sendFailureText, type SendingStatus } from "../../shared/sending";
import type { Env } from "../types";
import { loadAddressBook } from "./addresses";

/** Where a send is counted for Admin > Reports. Inside a mailbox, its own tally (calling itself could stall). */
export interface SendTally {
	countMail(kinds: ["sent"]): unknown;
	sendFailed(recipient: string, error: string): unknown;
}

const KEY = "setup/sending.json";

export async function loadSending(bucket: R2Bucket): Promise<SendingStatus> {
	try {
		const obj = await bucket.get(KEY);
		if (!obj) return { state: "unknown" };
		const s = (await obj.json()) as SendingStatus;
		return s && typeof s.state === "string" ? s : { state: "unknown" };
	} catch {
		return { state: "unknown" };
	}
}

async function saveSending(bucket: R2Bucket, status: SendingStatus): Promise<void> {
	await bucket.put(KEY, JSON.stringify(status), { httpMetadata: { contentType: "application/json" } });
}

function fromAddress(from: SendEmailParams["from"]): string {
	return (typeof from === "string" ? from : from.email).toLowerCase();
}

/**
 * sendEmail, plus a note of any setup problem the send runs into (so admins are told), and a count for
 * Admin > Reports. Throws the send's own error as before.
 */
export async function sendTracked(env: Env, params: SendEmailParams, tally?: SendTally): Promise<{ messageId: string }> {
	try {
		const sent = await sendEmail(env.EMAIL, params);
		await countSend(env, params, null, tally);
		return sent;
	} catch (e) {
		try {
			const next = afterSend(await loadSending(env.BUCKET), fromAddress(params.from), e);
			if (next) await saveSending(env.BUCKET, next);
		} catch { /* the send's error matters more */ }
		await countSend(env, params, e, tally);
		throw e;
	}
}

const listOf = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

/** Counts a send in the mailbox it came from (an extra address counts for its mailbox). Never throws. */
async function countSend(env: Env, params: SendEmailParams, error: unknown, tally?: SendTally): Promise<void> {
	try {
		let target = tally;
		if (!target) {
			const from = fromAddress(params.from);
			const mailbox = (await loadAddressBook(env.BUCKET)).aliases.find((a) => a.address === from)?.mailbox ?? from;
			// Only real mailboxes: this mustn't make an empty one for an address that isn't.
			if (!(await env.BUCKET.head(`mailboxes/${mailbox}.json`))) return;
			target = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox)) as unknown as SendTally;
		}
		if (error) await target.sendFailed(listOf(params.to as string | string[]).join(", "), sendFailureText(error) || (error as Error).message || "");
		else await target.countMail(["sent"]);
	} catch { /* a count isn't worth failing a send over */ }
}

/**
 * The sending check: `mailbox` emails itself. Its own address isn't one of the account's verified
 * destination addresses (the only ones a free account can send to), so getting through means the
 * plan and the domain are both ready. TODO(confirm on a free account): that Cloudflare refuses this
 * send without Workers Paid. The email lands in that inbox and says so.
 */
export async function checkSending(env: Env, mailbox: string, now = new Date()): Promise<SendingStatus> {
	const from = mailbox.toLowerCase();
	let error: unknown;
	try {
		await sendEmail(env.EMAIL, {
			to: from,
			from: { email: from, name: "Mail App" },
			subject: CHECK_SUBJECT,
			text: [
				"This is a quick check from Mail App to make sure outbound email is enabled.",
				"It arrived, so sending is working and there's nothing for you to do. You can delete this email.",
			].join("\n\n"),
			headers: { "Auto-Submitted": "auto-generated" },
		});
	} catch (e) {
		error = e ?? new Error("sending failed");
	}
	const status = afterCheck(from, now.toISOString(), error);
	await saveSending(env.BUCKET, status);
	return status;
}

/**
 * Sends an email the person has just written and waits for Cloudflare's answer, so a refusal can be
 * shown to them while the composer is still open. On a refusal the copy already filed in Sent (and
 * its attachments) is taken back out, so Sent never shows mail that didn't go, and the plain-English
 * reason is returned. Returns null when the email went.
 */
export async function sendNowOrExplain(
	env: Env,
	stub: { deleteEmail(id: string): Promise<{ id: string; filename: string }[] | null> },
	messageId: string,
	params: SendEmailParams,
): Promise<string | null> {
	try {
		await sendTracked(env, params);
		return null;
	} catch (e) {
		console.error("Email delivery failed:", (e as { code?: string })?.code ?? "", (e as Error)?.message ?? e);
		try {
			const removed = await stub.deleteEmail(messageId);
			if (removed?.length) await env.BUCKET.delete(removed.map((att) => `attachments/${messageId}/${att.id}/${att.filename}`));
		} catch (cleanup) {
			console.error("Couldn't take the unsent email out of Sent:", (cleanup as Error)?.message);
		}
		return sendFailureText(e);
	}
}
