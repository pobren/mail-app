// Mail App, 2026: one-click unsubscribe. Newsletters say how to leave in their List-Unsubscribe header:
// a web link, an email address, or both. When they also send "List-Unsubscribe-Post:
// List-Unsubscribe=One-Click" (RFC 8058), Mail App can unsubscribe for you with one request, without
// opening their page. Otherwise it opens their page, or writes the unsubscribe email for you.

type Header = { key: string; value: string };

export interface Unsubscribe {
	/** An https link that takes a one-click POST (RFC 8058). */
	oneClick: string | null;
	/** An https link to open in the browser. */
	url: string | null;
	/** A mailto: address, and the subject and body it asks for. */
	mailto: { to: string; subject: string; body: string } | null;
}

function parseHeaders(raw: string | Header[] | null | undefined): Header[] {
	if (!raw) return [];
	if (Array.isArray(raw)) return raw;
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((h) => h && typeof h.key === "string" && typeof h.value === "string") : [];
	} catch {
		return [];
	}
}

function header(headers: Header[], name: string): string | null {
	const h = headers.find((x) => x.key.toLowerCase() === name);
	return h ? h.value : null;
}

function parseMailto(link: string): Unsubscribe["mailto"] {
	try {
		const u = new URL(link);
		const to = decodeURIComponent(u.pathname).trim();
		if (!/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(to)) return null;
		return { to, subject: u.searchParams.get("subject") || "Unsubscribe", body: u.searchParams.get("body") || "Unsubscribe" };
	} catch {
		return null;
	}
}

/** How to leave this mailing list, or null when the email doesn't say. */
export function unsubscribeFrom(rawHeaders: string | Header[] | null | undefined): Unsubscribe | null {
	const headers = parseHeaders(rawHeaders);
	const list = header(headers, "list-unsubscribe");
	if (!list) return null;
	const links = [...list.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
	const https = links.find((l) => /^https:\/\//i.test(l)) ?? null;
	const mailtoLink = links.find((l) => /^mailto:/i.test(l)) ?? null;
	const post = header(headers, "list-unsubscribe-post");
	const oneClick = https && post && /List-Unsubscribe\s*=\s*One-Click/i.test(post) ? https : null;
	const mailto = mailtoLink ? parseMailto(mailtoLink) : null;
	if (!https && !mailto) return null;
	return { oneClick, url: https, mailto };
}

/** The body RFC 8058 says to send with the one-click POST. */
export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";
