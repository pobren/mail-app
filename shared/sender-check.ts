// Mail App, 2026: the sender check shown on each message. It reads the SPF, DKIM and DMARC results
// Cloudflare's mail server recorded when the email arrived (only headers stamped by mx.cloudflare.net
// count, since a sender can write any Authentication-Results header they like), says whether this is
// the first email from that address, and warns when the sender's domain looks like a well-known one
// with a letter swapped (paypa1.com, rnicrosoft.com).

/** Our own header, stamped on arrival, when nothing has come from this sender before. */
export const FIRST_CONTACT_HEADER = "x-mail-app-first-contact";

export type AuthResult = "pass" | "fail" | "none";

export interface SenderCheck {
	/** Overall: verified (DMARC passed), failed (DMARC failed) or unknown (no DMARC result). */
	status: "verified" | "failed" | "unknown";
	spf: AuthResult;
	dkim: AuthResult;
	dmarc: AuthResult;
	firstContact: boolean;
	/** The well-known domain the sender's domain imitates, if any. */
	lookalike: string | null;
}

type Header = { key: string; value: string };

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

function result(value: string, method: "spf" | "dkim" | "dmarc"): AuthResult {
	const m = value.match(new RegExp(`(?:^|[;\\s])${method}=([a-z]+)`, "i"));
	if (!m) return "none";
	const r = m[1].toLowerCase();
	if (r === "pass") return "pass";
	if (r === "fail" || r === "softfail" || r === "permerror") return "fail";
	return "none";
}

/** SPF, DKIM and DMARC as Cloudflare's mail server saw them. */
export function cloudflareAuth(raw: string | Header[] | null | undefined): { spf: AuthResult; dkim: AuthResult; dmarc: AuthResult } {
	for (const h of parseHeaders(raw)) {
		const key = h.key.toLowerCase();
		if (key !== "authentication-results" && key !== "arc-authentication-results") continue;
		const value = h.value.replace(/\s+/g, " ").trim().replace(/^i=\d+;\s*/, "");
		if (!/^mx\.cloudflare\.net\s*;/i.test(value)) continue;
		return { spf: result(value, "spf"), dkim: result(value, "dkim"), dmarc: result(value, "dmarc") };
	}
	return { spf: "none", dkim: "none", dmarc: "none" };
}

// Domains people are most often tricked with. Kept short on purpose: a lookalike of one of these is
// almost never innocent.
const WELL_KNOWN = [
	"paypal.com", "apple.com", "icloud.com", "microsoft.com", "outlook.com", "office.com", "live.com", "google.com",
	"gmail.com", "amazon.com", "amazon.co.uk", "ebay.com", "ebay.co.uk", "netflix.com", "facebook.com", "instagram.com",
	"linkedin.com", "dropbox.com", "docusign.com", "stripe.com", "cloudflare.com", "github.com", "fastmail.com",
	"proton.me", "dhl.com", "fedex.com", "ups.com", "royalmail.com", "hmrc.gov.uk", "gov.uk", "barclays.co.uk",
	"hsbc.co.uk", "lloydsbank.com", "natwest.com", "santander.co.uk", "monzo.com", "revolut.com", "wise.com",
	"coinbase.com", "binance.com", "adobe.com", "zoom.us", "slack.com", "x.com", "twitter.com", "booking.com",
	"airbnb.com", "spotify.com", "yahoo.com", "zoho.com",
];

// Names that are never ordinary words, so a near miss (paypai, amazom) or a name inside another
// (paypal-secure) is a warning. Ordinary words like apple, office or booking only count when a
// letter has been swapped for one that looks the same (app1e).
const DISTINCT = new Set([
	"paypal", "microsoft", "outlook", "google", "gmail", "amazon", "netflix", "facebook", "instagram", "linkedin",
	"dropbox", "docusign", "cloudflare", "github", "fastmail", "icloud", "barclays", "natwest", "santander", "revolut",
	"coinbase", "binance", "royalmail", "lloydsbank", "adobe", "airbnb", "spotify", "yahoo",
]);

// Characters people swap in to fool the eye.
function skeleton(s: string): string {
	return s.toLowerCase()
		.replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d")
		.replace(/[0]/g, "o").replace(/[1il|!]/g, "l").replace(/[3]/g, "e").replace(/[5$]/g, "s").replace(/[@4]/g, "a")
		.replace(/-/g, "");
}

function editDistance(a: string, b: string): number {
	if (Math.abs(a.length - b.length) > 2) return 3;
	const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0];
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j];
			prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return prev[b.length];
}

const SECOND_LEVEL = new Set(["co.uk", "org.uk", "gov.uk", "ac.uk", "com.au", "co.nz", "co.jp", "com.br"]);

/** The registrable part of a domain: mail.paypal.com becomes paypal.com. */
export function siteDomain(domain: string): string {
	const parts = domain.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
	if (parts.length <= 2) return parts.join(".");
	const lastTwo = parts.slice(-2).join(".");
	return SECOND_LEVEL.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

/** The well-known domain this one is pretending to be, or null. A real subdomain of it isn't. */
export function lookalikeOf(senderDomain: string): string | null {
	const site = siteDomain(senderDomain);
	if (!site || WELL_KNOWN.includes(site)) return null;
	const name = site.split(".")[0];
	if (name.length < 4) return null;
	for (const known of WELL_KNOWN) {
		const knownName = known.split(".")[0];
		if (knownName.length < 4) continue;
		// The same name at a different ending (paypal.co) isn't flagged: many brands own those.
		if (name === knownName) continue;
		// The whole name, and each part of a hyphenated one (paypal-security.com, secure-paypa1.net).
		const parts = name.includes("-") ? [name, ...name.split("-")] : [name];
		for (const part of parts) {
			const joined = part !== name;
			if (part === knownName) { if (joined && DISTINCT.has(knownName)) return known; continue; }
			if (skeleton(part) === skeleton(knownName)) return known;
			if (DISTINCT.has(knownName) && editDistance(part, knownName) === 1) return known;
		}
	}
	return null;
}

export function senderCheck(sender: string, rawHeaders: string | Header[] | null | undefined): SenderCheck {
	const headers = parseHeaders(rawHeaders);
	const auth = cloudflareAuth(headers);
	const domain = sender.split("@")[1] ?? "";
	return {
		...auth,
		status: auth.dmarc === "pass" ? "verified" : auth.dmarc === "fail" ? "failed" : "unknown",
		firstContact: headers.some((h) => h.key.toLowerCase() === FIRST_CONTACT_HEADER),
		lookalike: domain ? lookalikeOf(domain) : null,
	};
}
