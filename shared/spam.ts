// Mail App addition (not part of upstream Agentic Inbox).
// Decides whether new mail goes to Spam. Cloudflare already rejects mail that fails both SPF and DKIM,
// and mail that fails the sender's DMARC policy, so this catches what gets through: senders the person
// has blocked, and mail Cloudflare let in although its DMARC check failed (domains with a p=none policy).

export interface SpamSettings {
	/** Addresses ("bob@example.com") or whole domains ("example.com"). */
	blockedSenders?: string[];
	/** Senders marked "Not spam". The DMARC check is skipped for them. */
	safeSenders?: string[];
}

export type SpamReason = "blocked" | "dmarc-fail";

/** Lower-cases an address or domain and strips a leading "@", so "@Example.com" and "example.com" match. */
export function cleanSenderEntry(entry: string): string {
	return entry.trim().toLowerCase().replace(/^@+/, "");
}

/** True when the sender's address, or its domain or a parent domain, is in the list. */
export function senderMatches(sender: string, list: string[] | undefined): boolean {
	const address = cleanSenderEntry(sender);
	if (!address || !list?.length) return false;
	const entries = new Set(list.map(cleanSenderEntry));
	if (entries.has(address)) return true;
	const domain = address.split("@")[1];
	if (!domain) return false;
	const parts = domain.split(".");
	for (let i = 0; i < parts.length - 1; i++) if (entries.has(parts.slice(i).join("."))) return true;
	return false;
}

/**
 * Reads the DMARC result Cloudflare's own mail server recorded. Only headers stamped by
 * mx.cloudflare.net count, since a sender can write any Authentication-Results header they like.
 */
export function cloudflareDmarc(headers: { key: string; value: string }[] | undefined): string | null {
	for (const h of headers ?? []) {
		const key = h.key.toLowerCase();
		if (key !== "authentication-results" && key !== "arc-authentication-results") continue;
		const value = h.value.replace(/\s+/g, " ").trim().replace(/^i=\d+;\s*/, "");
		if (!/^mx\.cloudflare\.net\s*;/i.test(value)) continue;
		const m = value.match(/(?:^|[;\s])dmarc=([a-z]+)/i);
		return m ? m[1].toLowerCase() : null;
	}
	return null;
}

export function spamReason(
	sender: string,
	headers: { key: string; value: string }[] | undefined,
	settings: SpamSettings | null | undefined,
): SpamReason | null {
	if (senderMatches(sender, settings?.blockedSenders)) return "blocked";
	if (senderMatches(sender, settings?.safeSenders)) return null;
	if (cloudflareDmarc(headers) === "fail") return "dmarc-fail";
	return null;
}

/** Adds an entry to a list once, keeping the list tidy. */
export function addEntry(list: string[] | undefined, entry: string): string[] {
	const clean = cleanSenderEntry(entry);
	const out = (list ?? []).map(cleanSenderEntry).filter((e) => e && e !== clean);
	return clean ? [...out, clean] : out;
}

export function removeEntry(list: string[] | undefined, entry: string): string[] {
	const clean = cleanSenderEntry(entry);
	return (list ?? []).map(cleanSenderEntry).filter((e) => e && e !== clean);
}

/** A plausible address or domain, so the block list doesn't fill with typos. */
export function isValidSenderEntry(entry: string): boolean {
	const clean = cleanSenderEntry(entry);
	return /^([^\s@]+@)?([a-z0-9-]+\.)+[a-z]{2,}$/.test(clean) && clean.length <= 254;
}
