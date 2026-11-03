// Mail App addition (not part of upstream Agentic Inbox).
// Sends the out-of-office reply for new mail, keeps a copy in Sent, and remembers who got one.
import { autoReplyActive, autoReplySubject, dueForAutoReply, pruneAutoReplyLog, shouldAutoReply, type AutoReplySettings } from "../../shared/autoreply";
import { templateHtml } from "../../shared/templates";
import { Folders } from "../../shared/folders";
import { sendTracked } from "./sending";
import { addCompanyFooter } from "./company";
import { buildThreadingHeaders, generateMessageId } from "./email-helpers";
import type { Env } from "../types";
import type { Alias } from "../../shared/addresses";

interface IncomingMail {
	mailboxId: string;
	/** The extra address the email came in on, when it wasn't the mailbox's own. The reply comes from it. */
	replyAs?: Alias;
	sender: string;
	subject: string;
	headers: { key: string; value: string }[];
	threadId: string;
	/** The Message-ID of the email being answered, without angle brackets. */
	messageId: string | null;
	references: string[];
}

const logKey = (mailboxId: string) => `autoreplies/${mailboxId.toLowerCase()}.json`;

export async function sendAutoReply(env: Env, settings: Record<string, unknown> | null, mail: IncomingMail): Promise<void> {
	const autoReply = settings?.autoReply as AutoReplySettings | undefined;
	const now = new Date();
	if (!autoReply || !autoReplyActive(autoReply, now)) return;
	if (!shouldAutoReply(mail.sender, mail.mailboxId, mail.headers)) return;

	const logObj = await env.BUCKET.get(logKey(mail.mailboxId));
	const log = logObj ? ((await logObj.json().catch(() => ({}))) as Record<string, string>) : {};
	if (!dueForAutoReply(log[mail.sender], autoReply, now)) return;

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mail.mailboxId));
	if (await (stub as any).checkSendRateLimit(1)) return;

	// Remember first, so two emails arriving together don't both get a reply.
	await env.BUCKET.put(logKey(mail.mailboxId), JSON.stringify({ ...pruneAutoReplyLog(log, now), [mail.sender]: now.toISOString() }));

	const fromName = mail.replyAs?.name || (typeof settings?.fromName === "string" ? settings.fromName : "");
	const fromEmail = mail.replyAs?.address || mail.mailboxId;
	const from = fromName && fromName !== fromEmail ? { email: fromEmail, name: fromName } : fromEmail;
	const subject = autoReplySubject(mail.subject);
	// Mail App: the company details footer goes on auto-replies too.
	const { html, text } = await addCompanyFooter(env.BUCKET, { html: templateHtml(autoReply.message.trim()), text: autoReply.message.trim() });
	const references = mail.messageId ? [...mail.references.filter((r) => r !== mail.messageId), mail.messageId] : [];
	const { messageId, outgoingMessageId } = generateMessageId(fromEmail.split("@")[1]);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: mail.sender, cc: null, bcc: null,
		date: now.toISOString(), body: html,
		in_reply_to: mail.messageId, email_references: references.length ? JSON.stringify(references) : null,
		thread_id: mail.threadId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: mail.sender },
			{ key: "subject", value: subject }, { key: "date", value: now.toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
			{ key: "auto-submitted", value: "auto-replied" },
		]),
	}, []);

	await sendTracked(env, {
		to: mail.sender, from, subject, html, text,
		headers: { "Auto-Submitted": "auto-replied", ...(mail.messageId ? buildThreadingHeaders(mail.messageId, references) : {}) },
	});
}
