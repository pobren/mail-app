// Mail App addition (not part of upstream Agentic Inbox).
// Automatic spam checks on new mail, borrowing the idea of SpamAssassin's scored rules (Apache 2.0):
// each check that fires adds points, and mail that reaches SPAM_THRESHOLD goes to Spam with a reason
// in plain words. Rules ported from SpamAssassin itself are in shared/spam-rules.ts. Nothing here sends
// the message anywhere; the only outside lookup is the sender's domain age (see workers/lib/domain-age.ts),
// and only the domain name is sent for that. What the mailbox has learnt from Spam and Not spam
// (shared/spam-learning.ts) and the optional AI check (shared/spam-ai.ts) add their points on top.

import { advanceFeePoints, asksForDetails, drugPoints, hiddenRecipients, isFreemail, isShortener, oddHeaderPoints, riskyAttachment, type HeaderLike } from "./spam-rules.ts";

export type SpamCheck =
	| "lying-link"
	| "number-link"
	| "fake-name"
	| "lookalike-domain"
	| "new-domain"
	| "spammy-words"
	| "shouting"
	| "picture-only"
	| "reply-elsewhere"
	| "advance-fee"
	| "drug-spam"
	| "asks-details"
	| "odd-headers"
	| "hidden-recipients"
	| "freemail-reply"
	| "link-shortener"
	| "risky-attachment"
	| "empty-message"
	| "learnt-spam"
	| "learnt-genuine"
	| "ai-check";

export interface SpamFinding {
	check: SpamCheck;
	/** Can be below zero: "learnt-genuine" takes points off. */
	points: number;
	/** For "fake-name": the company the name pretends to be. For "risky-attachment": the file. For "ai-check": its reason. */
	detail?: string;
}

export interface SpamCheckInput {
	sender: string;
	senderName?: string | null;
	replyTo?: string | null;
	subject: string;
	html?: string | null;
	text?: string | null;
	/** Days since the sender's domain was registered, if known. */
	domainAgeDays?: number | null;
	/** Every header as it arrived, for the header checks. Left out, those checks are skipped. */
	headers?: HeaderLike[];
	/** Attachment file names (not pictures in the message itself). */
	attachments?: string[];
	now?: number;
}

/** Points at which a message goes to Spam. One strong sign isn't enough on its own. */
export const SPAM_THRESHOLD = 5;
/** A domain younger than this many days counts as brand new. */
export const NEW_DOMAIN_DAYS = 30;

const POINTS: Record<SpamCheck, number> = {
	"lying-link": 3,
	"number-link": 3,
	"fake-name": 4,
	"lookalike-domain": 2,
	"new-domain": 3,
	"spammy-words": 1,
	shouting: 1,
	"picture-only": 1,
	"reply-elsewhere": 1,
	// Ported from SpamAssassin (shared/spam-rules.ts), which works out its own points per check.
	"advance-fee": 4,
	"drug-spam": 3,
	"asks-details": 3,
	"odd-headers": 3,
	"hidden-recipients": 2,
	"freemail-reply": 2,
	"link-shortener": 1,
	"risky-attachment": 3,
	"empty-message": 2,
	// Worked out by shared/spam-learning.ts and shared/spam-ai.ts.
	"learnt-spam": 4,
	"learnt-genuine": -2,
	"ai-check": 5,
};

// Two-part endings, so "bank.co.uk" and "shop.com.au" count as the site, not "co.uk".
const TWO_PART_ENDINGS = new Set([
	"co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "ac.uk", "gov.uk", "nhs.uk", "sch.uk", "police.uk",
	"com.au", "net.au", "org.au", "gov.au", "edu.au", "co.nz", "org.nz", "govt.nz", "co.za", "org.za", "gov.za",
	"co.in", "org.in", "gov.in", "co.jp", "ne.jp", "or.jp", "com.br", "com.mx", "com.ar", "com.cn", "com.hk",
	"com.sg", "com.tr", "com.tw", "co.kr", "co.il", "com.my", "com.ph", "com.pk", "com.ng", "co.ke",
]);

/** The site a host belongs to: "mail.bank.co.uk" → "bank.co.uk", "a.b.example.com" → "example.com". */
export function siteOf(host: string): string {
	const parts = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
	if (parts.length <= 2) return parts.join(".");
	const lastTwo = parts.slice(-2).join(".");
	return TWO_PART_ENDINGS.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

export function domainOf(address: string | null | undefined): string {
	return (address ?? "").trim().toLowerCase().split("@")[1]?.replace(/>$/, "") ?? "";
}

// Mailing services that send links through their own click counters. A link whose words say
// "shop.com" but goes via one of these is normal for newsletters, not a trick.
const CLICK_COUNTERS = [
	"list-manage.com", "mailchimp.com", "mcsv.net", "mandrillapp.com", "sendgrid.net", "mailgun.org", "mailgun.net",
	"createsend.com", "cmail19.com", "cmail20.com", "hubspotlinks.com", "hs-sites.com", "klaviyo.com", "klclick.com",
	"constantcontact.com", "rs6.net", "sendibt2.com", "sendibt3.com", "brevo.com", "sendinblue.com", "exacttarget.com",
	"awstrack.me", "mailjet.com", "mjt.lu", "substack.com", "convertkit-mail.com", "ck.page", "beehiiv.com",
	"campaign-archive.com", "mlsend.com", "mailerlite.com", "postmarkapp.com", "sparkpostmail.com", "google.com",
	"safelinks.protection.outlook.com", "urldefense.com", "linkedin.com", "facebook.com", "t.co",
];

const isClickCounter = (host: string) => CLICK_COUNTERS.some((c) => host === c || host.endsWith(`.${c}`));

// Names fraudsters most often pretend to be, and the sites they really send from.
const BRANDS: { name: RegExp; label: string; sites: string[] }[] = [
	{ name: /\bpay\s?pal\b/i, label: "PayPal", sites: ["paypal.com", "paypal.co.uk", "paypal-communication.com"] },
	{ name: /\bamazon\b/i, label: "Amazon", sites: ["amazon.com", "amazon.co.uk", "amazon.de", "amazonses.com", "amazon.fr", "amazon.es", "amazon.it"] },
	{ name: /\bapple (id|support|pay|store)\b|\bicloud\b/i, label: "Apple", sites: ["apple.com", "icloud.com", "me.com", "mac.com"] },
	{ name: /\bmicrosoft\b|\boutlook\b|\boffice ?365\b/i, label: "Microsoft", sites: ["microsoft.com", "outlook.com", "office.com", "office365.com", "live.com", "hotmail.com", "microsoftonline.com"] },
	{ name: /\bnetflix\b/i, label: "Netflix", sites: ["netflix.com"] },
	{ name: /\bhmrc\b/i, label: "HMRC", sites: ["gov.uk"] },
	{ name: /\bdvla\b/i, label: "DVLA", sites: ["gov.uk"] },
	{ name: /\broyal mail\b/i, label: "Royal Mail", sites: ["royalmail.com", "royalmail.co.uk", "royalmailgroup.com"] },
	{ name: /\bdhl\b/i, label: "DHL", sites: ["dhl.com", "dhl.co.uk", "dhl.de"] },
	{ name: /\bevri\b|\bhermes\b/i, label: "Evri", sites: ["evri.com", "myhermes.co.uk"] },
	{ name: /\bdpd\b/i, label: "DPD", sites: ["dpd.co.uk", "dpd.com", "dpdgroup.com"] },
	{ name: /\bfedex\b/i, label: "FedEx", sites: ["fedex.com"] },
	{ name: /\bbarclays\b/i, label: "Barclays", sites: ["barclays.co.uk", "barclays.com", "barclaycard.co.uk"] },
	{ name: /\bhsbc\b/i, label: "HSBC", sites: ["hsbc.co.uk", "hsbc.com"] },
	{ name: /\blloyds\b/i, label: "Lloyds", sites: ["lloydsbank.co.uk", "lloydsbank.com", "lloydsbankinggroup.com"] },
	{ name: /\bnatwest\b/i, label: "NatWest", sites: ["natwest.com", "natwestgroup.com"] },
	{ name: /\bsantander\b/i, label: "Santander", sites: ["santander.co.uk", "santander.com"] },
	{ name: /\bnationwide\b/i, label: "Nationwide", sites: ["nationwide.co.uk"] },
	{ name: /\bmonzo\b/i, label: "Monzo", sites: ["monzo.com"] },
	{ name: /\brevolut\b/i, label: "Revolut", sites: ["revolut.com"] },
	{ name: /\bdocusign\b/i, label: "DocuSign", sites: ["docusign.com", "docusign.net"] },
	{ name: /\bcoinbase\b/i, label: "Coinbase", sites: ["coinbase.com"] },
	{ name: /\bebay\b/i, label: "eBay", sites: ["ebay.com", "ebay.co.uk"] },
	{ name: /\bgoogle\b|\bgmail\b/i, label: "Google", sites: ["google.com", "gmail.com", "youtube.com"] },
	{ name: /\bfacebook\b|\binstagram\b|\bwhatsapp\b/i, label: "Meta", sites: ["facebook.com", "facebookmail.com", "meta.com", "instagram.com", "whatsapp.com"] },
	{ name: /\bcloudflare\b/i, label: "Cloudflare", sites: ["cloudflare.com", "cloudflare.net"] },
];

// Phrases common in scams and junk. Each one found adds a point, up to three.
const SPAMMY_PHRASES = [
	"you have won", "you've won", "claim your prize", "claim your reward", "lottery", "inheritance", "beneficiary",
	"million dollars", "million pounds", "wire transfer", "western union", "bitcoin investment", "crypto investment",
	"double your money", "guaranteed income", "work from home and earn", "risk-free", "100% free", "act now",
	"verify your account", "account has been suspended", "account will be suspended", "account will be closed",
	"unusual sign-in activity", "confirm your password", "update your payment details", "your parcel is on hold",
	"pay the outstanding fee", "gift card", "dear beneficiary", "dear friend", "kindly reply", "urgent business proposal",
	"no prescription", "cheap meds", "weight loss miracle", "hot singles", "viagra", "casino bonus",
];
const MAX_WORD_POINTS = 3;

export function plainText(html: string): string {
	return html
		.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/\s+/g, " ")
		.trim();
}

function hostOf(url: string): string | null {
	try {
		const u = new URL(url.trim());
		return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
	} catch {
		return null;
	}
}

/** A web address written in link words, such as "www.paypal.com" or "https://bank.co.uk/login". */
function hostInWords(words: string): string | null {
	const m = words.trim().match(/^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[\/:?#]\S*)?$/i);
	return m ? m[1].toLowerCase() : null;
}

const NUMBER_HOST = /^\d{1,3}(\.\d{1,3}){3}$|^\[[0-9a-f:]+\]$/i;

export function checkLinks(html: string): SpamFinding[] {
	const found: SpamFinding[] = [];
	let lying = false;
	let numbers = false;
	let short = false;
	for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
		const host = hostOf(m[2].replace(/&amp;/g, "&"));
		if (!host) continue;
		if (NUMBER_HOST.test(host)) numbers = true;
		if (isShortener(host)) short = true;
		const said = hostInWords(plainText(m[3]));
		if (!said || isClickCounter(host)) continue;
		if (siteOf(said) !== siteOf(host)) lying = true;
	}
	if (lying) found.push({ check: "lying-link", points: POINTS["lying-link"] });
	if (numbers) found.push({ check: "number-link", points: POINTS["number-link"] });
	if (short) found.push({ check: "link-shortener", points: POINTS["link-shortener"] });
	return found;
}

export function checkName(sender: string, senderName: string | null | undefined): SpamFinding | null {
	const name = (senderName ?? "").trim();
	if (!name) return null;
	const site = siteOf(domainOf(sender));
	// A name with an address in it that isn't the real one, such as "service@paypal.com <x@other.ru>".
	const shown = name.match(/[a-z0-9._%+-]+@((?:[a-z0-9-]+\.)+[a-z]{2,})/i);
	if (shown && siteOf(shown[1]) !== site) return { check: "fake-name", points: POINTS["fake-name"], detail: shown[0].toLowerCase() };
	for (const brand of BRANDS) {
		if (!brand.name.test(name)) continue;
		if (brand.sites.some((s) => site === s || site.endsWith(`.${s}`))) return null;
		// A company name is a weaker sign than a made-up address, as small firms share words with big ones.
		return { check: "fake-name", points: POINTS["fake-name"] - 1, detail: brand.label };
	}
	return null;
}

/** Runs every check. Returns what fired, strongest first. */
export function spamChecks(input: SpamCheckInput): SpamFinding[] {
	const found: SpamFinding[] = [];
	const html = input.html ?? "";
	const text = input.text?.trim() || (html ? plainText(html) : "");
	const senderDomain = domainOf(input.sender);

	if (html) found.push(...checkLinks(html));

	const name = checkName(input.sender, input.senderName);
	if (name) found.push(name);

	// Internationalised look-alike domains such as "pаypal.com" with a Cyrillic "а" are stored as "xn--".
	if (senderDomain.split(".").some((p) => p.startsWith("xn--"))) found.push({ check: "lookalike-domain", points: POINTS["lookalike-domain"] });

	if (input.domainAgeDays != null && input.domainAgeDays >= 0 && input.domainAgeDays < NEW_DOMAIN_DAYS) {
		found.push({ check: "new-domain", points: POINTS["new-domain"] });
	}

	const haystack = `${input.subject} ${text}`.toLowerCase().replace(/[’‘]/g, "'");
	const words = SPAMMY_PHRASES.filter((p) => haystack.includes(p)).length;
	if (words) found.push({ check: "spammy-words", points: Math.min(words, MAX_WORD_POINTS) * POINTS["spammy-words"] });

	const letters = input.subject.replace(/[^a-z]/gi, "");
	if ((letters.length >= 10 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.7) || /!!!|\$\$\$|£££/.test(input.subject)) {
		found.push({ check: "shouting", points: POINTS.shouting });
	}

	if (/<img\b/i.test(html) && text.replace(/\s/g, "").length < 40) found.push({ check: "picture-only", points: POINTS["picture-only"] });

	const replyDomain = domainOf(input.replyTo);
	if (replyDomain && senderDomain && siteOf(replyDomain) !== siteOf(senderDomain)) {
		// A business sending from its own domain but wanting replies at a free email account (FREEMAIL_FORGED_REPLYTO).
		if (isFreemail(replyDomain) && !isFreemail(senderDomain)) found.push({ check: "freemail-reply", points: POINTS["freemail-reply"] });
		else found.push({ check: "reply-elsewhere", points: POINTS["reply-elsewhere"] });
	}

	// SpamAssassin's rules (shared/spam-rules.ts).
	const body = `${input.subject}\n${text}`;
	const fee = advanceFeePoints(body);
	if (fee) found.push({ check: "advance-fee", points: fee });
	const drugs = drugPoints(body);
	if (drugs) found.push({ check: "drug-spam", points: drugs });
	if (asksForDetails(input.text?.trim() || (html ? html.replace(/<br\s*\/?>|<\/(?:p|div|li|tr)>/gi, "\n").replace(/<[^>]+>/g, " ") : ""))) {
		found.push({ check: "asks-details", points: POINTS["asks-details"] });
	}
	const odd = oddHeaderPoints(input.headers, input.now);
	if (odd) found.push({ check: "odd-headers", points: odd });
	if (hiddenRecipients(input.headers)) found.push({ check: "hidden-recipients", points: POINTS["hidden-recipients"] });
	const risky = riskyAttachment(input.attachments);
	if (risky) found.push({ check: "risky-attachment", points: POINTS["risky-attachment"], detail: risky });
	if (!text.replace(/\s/g, "") && !/<img\b/i.test(html) && !input.attachments?.length) found.push({ check: "empty-message", points: POINTS["empty-message"] });

	return found.sort((a, b) => b.points - a.points);
}

export function spamScore(found: SpamFinding[]): number {
	return found.reduce((n, f) => n + f.points, 0);
}

// -- The reason shown on a message in Spam -------------------------------------------------

/** Mail App's own header recording why a message went to Spam, such as "lying-link fake-name:PayPal". */
export const SPAM_REASON_HEADER = "x-mail-app-spam";

export type StoredReason = "blocked" | "dmarc-fail" | SpamCheck;

/** The points a check is worth, for checks worked out elsewhere (learning, the AI check). */
export function pointsFor(check: SpamCheck): number {
	return POINTS[check];
}

export function reasonHeaderValue(reasons: { check: StoredReason; detail?: string }[]): string {
	return reasons.map((r) => (r.detail ? `${r.check}:${encodeURIComponent(r.detail)}` : r.check)).join(" ");
}

export function readReasonHeader(value: string | null | undefined): { check: StoredReason; detail?: string }[] {
	return (value ?? "").split(/\s+/).filter(Boolean).map((part) => {
		const [check, detail] = part.split(":");
		let d: string | undefined;
		try { d = detail ? decodeURIComponent(detail) : undefined; } catch { d = undefined; }
		return { check: check as StoredReason, ...(d ? { detail: d } : {}) };
	});
}

/** The header's value in a message's stored headers (JSON list of { key, value }), if any. */
export function reasonFromHeaders(rawHeaders: string | null | undefined): { check: StoredReason; detail?: string }[] {
	if (!rawHeaders) return [];
	try {
		const list = JSON.parse(rawHeaders) as { key: string; value: string }[];
		return readReasonHeader(list.find((h) => h.key?.toLowerCase() === SPAM_REASON_HEADER)?.value);
	} catch {
		return [];
	}
}
