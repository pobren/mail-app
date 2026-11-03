// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: emails too big for Cloudflare to send are refused with a clear message; replies and forwards can come from the mailbox's extra addresses; in a shared mailbox, who sent each one is kept; a send that hits a setup problem is noted for the admin "Ready to send" card. Webhook events when a reply or forward is sent. The company details footer; "Remind me if no reply"; scheduled send.

import { countRecipients } from "../lib/send-limit";
import type { Context } from "hono";
import { sendNowOrExplain } from "../lib/sending";
import { BAD_SEND_AT, scheduleEmail, sendAtOf } from "../lib/scheduled-send";
import type { SendEmailParams } from "../email-sender";
import { messageTooLarge, storeAttachments } from "../lib/attachments";
import type { EmailFull } from "../lib/schemas";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildReferencesChain,
	buildThreadingHeaders,
	resolveOriginalEmail,
} from "../lib/email-helpers";
import { SendEmailRequestSchema } from "../lib/schemas";
import { Folders } from "../../shared/folders";
import { sendableFor } from "../lib/masked";
import type { MailboxContext } from "../lib/mailbox";
import { sentBy } from "../lib/people";
import { emitEvent } from "../lib/api";
import { addCompanyFooter } from "../lib/company";
import { validDueAt } from "../../shared/reminders";

type AppContext = Context<MailboxContext>;
type RateLimitStub = { checkSendRateLimit: (recipients?: number) => Promise<string | null> };

export async function handleReplyEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, attachments, remind_at } = body;
	// Mail App: scheduled send.
	const sendAt = sendAtOf(body.send_at);
	if (sendAt === "bad") return c.json({ error: BAD_SEND_AT }, 400);
	// Mail App: the company details footer, above the quoted email.
	const { html, text } = await addCompanyFooter(c.env.BUCKET, { html: body.html, text: body.text });

	const stub = c.var.mailboxStub;
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	const originalEmail = await resolveOriginalEmail(stub, rawOriginal);
	const { originalMsgId, references, threadId: thread_id } = buildReferencesChain(originalEmail);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId, await sendableFor(c.env.BUCKET, mailboxId)));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const tooLarge = messageTooLarge(attachments, html, text);
	if (tooLarge) return c.json({ error: tooLarge }, 413);

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rateLimitError = sendAt ? null : await (stub as unknown as RateLimitStub)
		.checkSendRateLimit(countRecipients(to, cc, bcc));
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(
		sendAt ? Folders.SCHEDULED : Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
			bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
			date: new Date().toISOString(),
			body: html || text || "",
			in_reply_to: originalMsgId,
			email_references: JSON.stringify(references),
			thread_id: thread_id,
			message_id: outgoingMessageId,
			...(await sentBy(c.env, c.var.person, mailboxId)),
			raw_headers: JSON.stringify([
				{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject },
				{ key: "date", value: new Date().toISOString() },
				{ key: "message-id", value: `<${outgoingMessageId}>` },
				...(originalMsgId ? [{ key: "in-reply-to", value: `<${originalMsgId}>` }] : []),
				...(references.length > 0 ? [{ key: "references", value: references.map((r: string) => `<${r}>`).join(" ") }] : []),
			]),
		},
		attachmentData,
	);

	await stub.markThreadRead(thread_id);

	const params: SendEmailParams = {
		to,
		cc,
		bcc,
		from,
		subject,
		html,
		text,
		attachments: attachments?.map((att) => ({
			content: att.content,
			filename: att.filename,
			type: att.type,
			disposition: att.disposition,
			contentId: att.contentId,
		})),
		headers: buildThreadingHeaders(originalMsgId, references),
	};
	const event = {
		id: messageId, thread_id: thread_id, folder: Folders.SENT, subject, from: fromEmail, to: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		has_attachments: !!attachments?.some((a) => a.disposition !== "inline"),
	};
	// Mail App: scheduled send: it waits in Scheduled, and the mailbox's alarm sends it.
	if (sendAt) {
		await scheduleEmail(c.env, stub, mailboxId, messageId, sendAt, {
			params, recipients: countRecipients(to, cc, bcc), event, remindAfterMs: validDueAt(remind_at) ? remind_at - Date.now() : null,
		});
		return c.json({ id: messageId, status: "scheduled", send_at: sendAt }, 202);
	}
	const refused = await sendNowOrExplain(c.env, stub, messageId, params);
	if (refused) return c.json({ error: refused }, 502);
	if (validDueAt(remind_at)) await stub.remindIfNoReply(messageId, remind_at);
	// Mail App: tell webhooks it went (see workers/lib/api.ts).
	emitEvent(c.env, c.executionCtx as ExecutionContext, "email.sent", mailboxId, { ...event, date: new Date().toISOString() });

	return c.json({ id: messageId, status: "sent" }, 202);
}

export async function handleForwardEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, attachments, remind_at } = body;
	// Mail App: scheduled send.
	const sendAt = sendAtOf(body.send_at);
	if (sendAt === "bad") return c.json({ error: BAD_SEND_AT }, 400);
	// Mail App: the company details footer, above the quoted email.
	const { html, text } = await addCompanyFooter(c.env.BUCKET, { html: body.html, text: body.text });

	const stub = c.var.mailboxStub;
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	await resolveOriginalEmail(stub, rawOriginal);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId, await sendableFor(c.env.BUCKET, mailboxId)));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const tooLarge = messageTooLarge(attachments, html, text);
	if (tooLarge) return c.json({ error: tooLarge }, 413);

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rateLimitError = sendAt ? null : await (stub as unknown as RateLimitStub)
		.checkSendRateLimit(countRecipients(to, cc, bcc));
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(
		sendAt ? Folders.SCHEDULED : Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
			bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
			date: new Date().toISOString(),
			body: html || text || "",
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: outgoingMessageId,
			...(await sentBy(c.env, c.var.person, mailboxId)),
			raw_headers: JSON.stringify([
				{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject },
				{ key: "date", value: new Date().toISOString() },
				{ key: "message-id", value: `<${outgoingMessageId}>` },
			]),
		},
		attachmentData,
	);

	const params: SendEmailParams = {
		to,
		cc,
		bcc,
		from,
		subject,
		html,
		text,
		attachments: attachments?.map((att) => ({
			content: att.content,
			filename: att.filename,
			type: att.type,
			disposition: att.disposition,
			contentId: att.contentId,
		})),
	};
	const event = {
		id: messageId, thread_id: messageId, folder: Folders.SENT, subject, from: fromEmail, to: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		has_attachments: !!attachments?.some((a) => a.disposition !== "inline"),
	};
	// Mail App: scheduled send: it waits in Scheduled, and the mailbox's alarm sends it.
	if (sendAt) {
		await scheduleEmail(c.env, stub, mailboxId, messageId, sendAt, {
			params, recipients: countRecipients(to, cc, bcc), event, remindAfterMs: validDueAt(remind_at) ? remind_at - Date.now() : null,
		});
		return c.json({ id: messageId, status: "scheduled", send_at: sendAt }, 202);
	}
	const refused = await sendNowOrExplain(c.env, stub, messageId, params);
	if (refused) return c.json({ error: refused }, 502);
	if (validDueAt(remind_at)) await stub.remindIfNoReply(messageId, remind_at);
	// Mail App: tell webhooks it went (see workers/lib/api.ts).
	emitEvent(c.env, c.executionCtx as ExecutionContext, "email.sent", mailboxId, { ...event, date: new Date().toISOString() });

	return c.json({ id: messageId, status: "sent" }, 202);
}
