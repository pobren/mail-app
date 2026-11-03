// Mail App addition (not part of upstream Agentic Inbox).
// Automatic forwarding of new mail (see shared/forwarding.ts for the two ways it goes out).
import { COPY_MAX_BYTES, FORWARDED_HEADER, copyFromName, type ForwardingSettings, type ForwardingStatus } from "../../shared/forwarding";
import { sendFailureText } from "../../shared/sending";
import { sendTracked } from "./sending";
import type { Env } from "../types";

const statusKey = (mailboxId: string) => `forwarding/${mailboxId.toLowerCase()}.json`;

export async function loadForwardingStatus(bucket: R2Bucket, mailboxId: string): Promise<ForwardingStatus | null> {
	try {
		const obj = await bucket.get(statusKey(mailboxId));
		return obj ? ((await obj.json()) as ForwardingStatus) : null;
	} catch {
		return null;
	}
}

interface IncomingForForwarding {
	mailboxId: string;
	/** Cloudflare's own forward, from the email event. Missing when the mail didn't come through Email Routing. */
	forward?: (rcptTo: string, headers?: Headers) => Promise<void>;
	rawSize: number;
	sender: string;
	senderName: string | null;
	subject: string;
	html: string | null;
	text: string | null;
	/** Any earlier mailboxes that forwarded it, from our own header. */
	forwardedBy: string[];
	/** Spam ("Forward spam too"): only Cloudflare's own forward, never a copy sent from the mailbox. */
	spam?: boolean;
	attachments: { content: ArrayBuffer | Uint8Array | string; filename: string; mimeType: string; disposition: "attachment" | "inline"; contentId?: string | null }[];
}

/**
 * Passes one new email on. Returns true when it went. Never throws: a failure is noted for Settings,
 * and the email stays in the inbox.
 */
export async function forwardEmail(env: Env, settings: ForwardingSettings, mail: IncomingForForwarding): Promise<boolean> {
	const to = settings.email;
	const by = [...mail.forwardedBy, mail.mailboxId.toLowerCase()].join(", ");
	const note = (status: Omit<ForwardingStatus, "at" | "to">) =>
		env.BUCKET.put(statusKey(mail.mailboxId), JSON.stringify({ at: new Date().toISOString(), to, ...status }), { httpMetadata: { contentType: "application/json" } })
			.catch((e) => console.error("Forwarding status not saved:", (e as Error).message));

	// 1. Cloudflare's own forward: only to an address verified in the Cloudflare account.
	if (mail.forward) {
		try {
			const headers = new Headers();
			headers.set(FORWARDED_HEADER, by);
			await mail.forward(to, headers);
			await note({ ok: true, how: "forward" });
			return true;
		} catch (e) {
			console.log("Cloudflare forward refused, sending a copy instead:", (e as Error)?.message ?? e);
		}
	}

	// Spam is never sent on from the mailbox's own address, which would harm its good name with other email services.
	if (mail.spam) return false;

	// 2. A copy from this mailbox, replies going to whoever wrote it.
	if (mail.rawSize > COPY_MAX_BYTES) {
		await note({ ok: false, error: `This email was over 5 MB, so it could only go to an address you've verified in Cloudflare. It's still in your inbox.` });
		return false;
	}
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mail.mailboxId));
	const limit = await (stub as any).checkSendRateLimit(1);
	if (limit) {
		await note({ ok: false, error: `${limit} It's still in your inbox.` });
		return false;
	}
	try {
		await sendTracked(env, {
			to,
			from: { email: mail.mailboxId, name: copyFromName(mail.senderName, mail.sender) },
			...(mail.sender ? { replyTo: mail.senderName ? { email: mail.sender, name: mail.senderName.replace(/["<>\r\n]/g, "") } : mail.sender } : {}),
			subject: mail.subject || "(no subject)",
			html: mail.html || undefined,
			text: mail.text || (mail.html ? undefined : " "),
			attachments: mail.attachments.map((a) => ({
				content: toBase64(a.content), filename: a.filename, type: a.mimeType || "application/octet-stream",
				disposition: a.disposition, ...(a.contentId ? { contentId: a.contentId.replace(/^<|>$/g, "") } : {}),
			})),
			headers: { "X-Mail-App-Forwarded": by, ...(mail.sender ? { "X-Original-From": mail.sender } : {}) },
		});
		await note({ ok: true, how: "copy" });
		return true;
	} catch (e) {
		console.error("Forwarding failed:", (e as { code?: string })?.code ?? "", (e as Error)?.message ?? e);
		await note({ ok: false, error: `${sendFailureText(e).replace(/^Not sent\. /, "")} It's still in your inbox.` });
		return false;
	}
}

function toBase64(content: ArrayBuffer | Uint8Array | string): string {
	const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content instanceof Uint8Array ? content : new Uint8Array(content);
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}
