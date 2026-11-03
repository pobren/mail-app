// Mail App addition (not part of upstream Agentic Inbox).
// Automatic forwarding: every new email that isn't spam is passed on to one other address (spam too,
// when "Forward spam too" is ticked, for trying Mail App alongside an old email service). Kept in
// the mailbox's settings file in R2 as `forwarding`; how the last one went is kept beside it, in
// forwarding/<mailbox>.json, so Settings can say whether it's working.
//
// Two ways out, best first (workers/lib/forwarding.ts):
// - "forward": Cloudflare Email Routing passes the email on exactly as it arrived. Only works for an
//   address verified in the Cloudflare account (Email Routing > Destination addresses). The original
//   sender, DKIM signature and attachments stay as they were, Cloudflare adds ARC and SRS, so it
//   passes SPF, DKIM and DMARC at the other end. No sending limits.
// - "copy": for any other address, a copy is sent from the mailbox's own address, with Reply-To set to
//   the original sender. Needs sending switched on (Workers Paid), counts towards the mailbox's sending
//   limits and can't carry more than 5 MB.

export interface ForwardingSettings {
	enabled: boolean;
	email: string;
	/** Leave forwarded mail in the Inbox. When false it's filed in Archive, marked as read. */
	keepCopy: boolean;
	/**
	 * Forward spam too, still kept in Spam here. Only ever by Cloudflare's own forward (a verified
	 * address), never as a copy from the mailbox, so spam is never sent from your own address.
	 */
	includeSpam: boolean;
}

export interface ForwardingStatus {
	at: string;
	ok: boolean;
	how?: "forward" | "copy";
	/** Plain-English reason when it didn't go. */
	error?: string;
	/** The address it was for, so a status for an old address isn't shown against a new one. */
	to: string;
}

/** Our own header on forwarded mail, so mail that comes back round isn't forwarded again. */
export const FORWARDED_HEADER = "x-mail-app-forwarded";

/** Cloudflare's limit for a sent email to an address that isn't verified. */
export const COPY_MAX_BYTES = 5 * 1024 * 1024;

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

export function cleanForwarding(raw: unknown): ForwardingSettings {
	const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const email = typeof f.email === "string" ? f.email.trim().toLowerCase().slice(0, 254) : "";
	return { enabled: f.enabled === true && EMAIL_RE.test(email), email, keepCopy: f.keepCopy !== false, includeSpam: f.includeSpam === true };
}

/**
 * Why this address can't be forwarded to, or null when it's fine. An address at one of the install's
 * own domains would go round in a loop or straight back in, so it's refused: an extra address or a
 * shared mailbox does that job better.
 */
export function forwardingProblem(email: string, mailboxId: string, ownDomains: string[]): string | null {
	const address = email.trim().toLowerCase();
	if (!EMAIL_RE.test(address)) return "Enter the email address to forward to, such as name@example.com.";
	if (address === mailboxId.toLowerCase()) return "That's this mailbox's own address. Enter a different one.";
	const domain = address.split("@")[1];
	if (ownDomains.some((d) => d.toLowerCase() === domain)) {
		return `${domain} is one of your own domains in Mail App. To get this mail in another mailbox here, add an extra address or share the mailbox instead.`;
	}
	return null;
}

/** Whether a new email should be forwarded: forwarding is on, it isn't spam (or spam is forwarded too), and it hasn't already been forwarded by this mailbox. */
export function shouldForward(settings: ForwardingSettings, mail: { isSpam: boolean; mailboxId: string; headers: { key: string; value: string }[] }): boolean {
	if (!settings.enabled || (mail.isSpam && !settings.includeSpam)) return false;
	const mine = mail.mailboxId.toLowerCase();
	return !mail.headers.some((h) => h.key.toLowerCase() === FORWARDED_HEADER && h.value.toLowerCase().split(/[\s,]+/).includes(mine));
}

/** The name the copy comes from, such as "Jane Smith via Mail App", so it's clear who wrote it. */
export function copyFromName(senderName: string | null | undefined, sender: string): string {
	const who = (senderName || "").replace(/["<>\r\n]/g, "").trim() || sender || "Someone";
	return `${who} via Mail App`.slice(0, 120);
}

