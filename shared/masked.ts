// Mail App addition (not part of upstream Agentic Inbox).
// Masked email: a fresh address for each website you sign up to, so your real address stays private.
// The admin picks, for each domain, the one mailbox that gets masked email there. After that, any
// address at that domain that isn't a mailbox or an extra address is a masked address: make one up
// when you sign up somewhere, or let Mail App make one for you. The first email to a new one asks
// you to Keep or Block it (or, with the setting on, keeps it without asking). A masked address can
// end on a date, after a number of days or after its first email; once it's off or has ended, mail to
// it is sent back. An email from a different website than the one the address was for is flagged as
// a possible leak. Everything lives in one small file in R2 (masked.json).
//
// Pure functions only, so the browser, the Worker and the tests can all use them.

import { domainOf, isAddress, normaliseAddress, resolveDelivery, type AddressBook, type Delivery } from "./addresses.ts";
import { siteOf } from "./spam-checks.ts";

export type MaskedStatus = "waiting" | "on" | "off";

export interface MaskedAddress {
	/** The masked address, lower case. */
	address: string;
	/** The mailbox it delivers into. */
	mailbox: string;
	/** What it's for, in your words ("Amazon", "amazon.co.uk"). */
	label?: string;
	/** The websites (such as "amazon.co.uk") whose email to it is expected. Learnt from the first email when empty. */
	sites: string[];
	/** waiting: arrived out of the blue, Keep or Block not chosen yet. on: in use. off: mail to it is sent back. */
	status: MaskedStatus;
	created: string;
	/** When it ends (ISO). Mail after that is sent back. */
	expires?: string;
	/** Ends after its first email. */
	once?: boolean;
	/** How many emails have come to it. */
	count: number;
	/** When the latest one came. */
	last?: string;
	/** The website of the latest email that didn't come from one of `sites`: a possible leak. */
	leak?: string;
}

export interface MaskedFile {
	/** For each domain (lower case), the mailbox that gets masked email there. */
	domains: Record<string, string>;
	addresses: MaskedAddress[];
}

export const MASKED_KEY = "masked.json";
/** Header Mail App adds to an email that came to a masked address from an unexpected website. */
export const MASKED_LEAK_HEADER = "x-mail-app-masked-leak";
export const MAX_MASKED = 1000;
export const MAX_MASKED_LABEL = 60;
const MAX_SITES = 10;
/** What a sender is told when mail to a masked address that's off or has ended is sent back. */
export const MASKED_BOUNCE = "This address is no longer in use.";

const DOMAIN_LIKE_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** Reads whatever is stored, dropping anything malformed, so a bad file never stops mail. */
export function cleanMaskedFile(raw: unknown): MaskedFile {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const domains: Record<string, string> = {};
	if (r.domains && typeof r.domains === "object") {
		for (const [d, m] of Object.entries(r.domains as Record<string, unknown>)) {
			if (typeof m === "string" && m && DOMAIN_LIKE_RE.test(d.toLowerCase())) domains[d.toLowerCase()] = normaliseAddress(m);
		}
	}
	const seen = new Set<string>();
	const addresses: MaskedAddress[] = [];
	for (const a of Array.isArray(r.addresses) ? r.addresses : []) {
		if (!a || typeof a !== "object") continue;
		const address = typeof a.address === "string" ? normaliseAddress(a.address) : "";
		const mailbox = typeof a.mailbox === "string" ? normaliseAddress(a.mailbox) : "";
		if (!isAddress(address) || !mailbox || seen.has(address)) continue;
		seen.add(address);
		const label = typeof a.label === "string" ? a.label.replace(/[\x00-\x1f]/g, "").trim().slice(0, MAX_MASKED_LABEL) : "";
		const sites = (Array.isArray(a.sites) ? a.sites : [])
			.filter((s: unknown): s is string => typeof s === "string" && DOMAIN_LIKE_RE.test(s.toLowerCase()))
			.map((s: string) => s.toLowerCase()).slice(0, MAX_SITES) as string[];
		addresses.push({
			address, mailbox,
			...(label ? { label } : {}),
			sites: [...new Set(sites)],
			status: a.status === "waiting" || a.status === "off" ? a.status : "on",
			created: isIso(a.created) ? a.created : new Date(0).toISOString(),
			...(isIso(a.expires) ? { expires: a.expires } : {}),
			...(a.once === true ? { once: true } : {}),
			count: Number.isInteger(a.count) && a.count > 0 ? a.count : 0,
			...(isIso(a.last) ? { last: a.last } : {}),
			...(typeof a.leak === "string" && DOMAIN_LIKE_RE.test(a.leak) ? { leak: a.leak } : {}),
		});
	}
	return { domains, addresses };
}

/** Has it ended: past its date, or used once when it was only for one email. */
export function maskedEnded(m: MaskedAddress, now: Date = new Date()): boolean {
	return (!!m.expires && Date.parse(m.expires) <= now.getTime()) || (!!m.once && m.count >= 1);
}

/** Does mail to it still arrive. */
export function maskedWorks(m: MaskedAddress, now: Date = new Date()): boolean {
	return m.status !== "off" && !maskedEnded(m, now);
}

/** The domains a mailbox gets masked email at. */
export function maskedDomainsOf(file: MaskedFile, mailbox: string): string[] {
	const m = normaliseAddress(mailbox);
	return Object.keys(file.domains).filter((d) => file.domains[d] === m).sort();
}

export function maskedOf(file: MaskedFile, mailbox: string): MaskedAddress[] {
	const m = normaliseAddress(mailbox);
	return file.addresses.filter((a) => a.mailbox === m);
}

/** The masked addresses a mailbox can still send from (replies to mail that came to them). */
export function sendableMasked(file: MaskedFile, mailbox: string, now: Date = new Date()): string[] {
	return maskedOf(file, mailbox).filter((a) => a.status !== "off" && !(a.expires && Date.parse(a.expires) <= now.getTime())).map((a) => a.address);
}

/** The masked file without any trace of these mailboxes (they're being deleted). */
export function maskedWithoutMailboxes(file: MaskedFile, mailboxes: string[]): MaskedFile {
	const gone = new Set(mailboxes.map(normaliseAddress));
	return {
		domains: Object.fromEntries(Object.entries(file.domains).filter(([, m]) => !gone.has(m))),
		addresses: file.addresses.filter((a) => !gone.has(a.mailbox)),
	};
}

/** The website a label like "amazon.co.uk" or "https://www.amazon.co.uk/signup" names, or null for "Amazon". */
export function siteFromLabel(label: string | undefined): string | null {
	const host = (label ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/^www\./, "");
	return DOMAIN_LIKE_RE.test(host) ? siteOf(host) : null;
}

/**
 * A fresh address for a website: "amazon.k7q2xm@yourdomain", or "k7q2xm9p@yourdomain" with no label.
 * `random` gives the random part (tests pass a fixed one).
 */
export function newMaskedAddress(domain: string, label: string | undefined, taken: (a: string) => boolean, random: () => string = randomPart): string {
	const site = siteFromLabel(label);
	const word = (site ? site.split(".")[0] : (label ?? "")).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "").slice(0, 16);
	for (let i = 0; i < 20; i++) {
		const address = `${word ? `${word}.${random().slice(0, 6)}` : random()}@${normaliseAddress(domain)}`;
		if (!taken(address)) return address;
	}
	throw new Error("Couldn't make a new address. Please try again.");
}

function randomPart(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	// No 0/o or 1/l, so it's easy to read out or type.
	const letters = "abcdefghijkmnpqrstuvwxyz23456789";
	return [...bytes].map((b) => letters[b % letters.length]).join("");
}

export type IncomingRoute =
	| (Delivery & { masked?: { address: string; isNew: boolean } })
	| { reject: string; address: string }
	| null;

/**
 * Where an incoming email goes. A mailbox or an extra address always wins. Then a masked address
 * (sent back when it's off or has ended), then a new masked address at a domain with masked email,
 * and only then a catch-all.
 */
export function routeIncoming(
	candidates: string[],
	mailboxes: Iterable<string>,
	book: AddressBook,
	masked: MaskedFile,
	domains: string[],
	now: Date = new Date(),
): IncomingRoute {
	const boxes = new Set([...mailboxes].map(normaliseAddress));
	const direct = resolveDelivery(candidates, boxes, { ...book, catchAll: {} }, domains);
	if (direct) return direct;
	const byAddress = new Map(masked.addresses.map((a) => [a.address, a]));
	for (const raw of candidates) {
		const addr = normaliseAddress(raw);
		const m = byAddress.get(addr);
		if (!m || !boxes.has(m.mailbox)) continue;
		return maskedWorks(m, now) ? { mailbox: m.mailbox, deliveredTo: addr, masked: { address: addr, isNew: false } } : { reject: MASKED_BOUNCE, address: addr };
	}
	const ours = new Set(domains.map(normaliseAddress));
	for (const raw of candidates) {
		const addr = normaliseAddress(raw);
		const domain = domainOf(addr);
		const box = masked.domains[domain];
		if (ours.has(domain) && box && boxes.has(box) && isAddress(addr)) {
			return { mailbox: box, deliveredTo: addr, masked: { address: addr, isNew: true } };
		}
	}
	return resolveDelivery(candidates, boxes, book, domains);
}

/**
 * Notes an email that came to a masked address: adds a new one (waiting, or on when the mailbox keeps
 * new ones without asking), counts it, learns the website from the first email, and spots a possible
 * leak. Returns the updated file and the website to warn about, if any.
 */
export function recordMaskedMail(
	file: MaskedFile,
	route: { address: string; isNew: boolean; mailbox: string },
	senderAddress: string,
	opts: { keepNew: boolean; now?: Date },
): { file: MaskedFile; leak: string | null; added: boolean } {
	const now = opts.now ?? new Date();
	const senderSite = siteOf(domainOf(senderAddress));
	let addresses = file.addresses;
	let m = addresses.find((a) => a.address === route.address);
	let added = false;
	if (!m) {
		if (addresses.length >= MAX_MASKED) return { file, leak: null, added: false };
		m = { address: route.address, mailbox: normaliseAddress(route.mailbox), sites: [], status: opts.keepNew ? "on" : "waiting", created: now.toISOString(), count: 0 };
		addresses = [...addresses, m];
		added = true;
	}
	const next: MaskedAddress = { ...m, count: m.count + 1, last: now.toISOString() };
	let leak: string | null = null;
	if (senderSite) {
		if (next.sites.length === 0) next.sites = [senderSite];
		else if (!next.sites.includes(senderSite)) { leak = senderSite; next.leak = senderSite; }
	}
	return { file: { ...file, addresses: addresses.map((a) => (a.address === next.address ? next : a)) }, leak, added };
}

/** Why a masked address can't be made, in plain English, or null when it's fine. */
export function maskedProblem(address: string, mailbox: string, file: MaskedFile, book: AddressBook, mailboxes: Iterable<string>): string | null {
	const addr = normaliseAddress(address);
	if (!isAddress(addr)) return "That doesn't look like an email address.";
	if (file.domains[domainOf(addr)] !== normaliseAddress(mailbox)) return "This mailbox doesn't have masked email at that domain.";
	if ([...mailboxes].map(normaliseAddress).includes(addr) || book.aliases.some((a) => a.address === addr)) return "That address is already in use.";
	if (file.addresses.some((a) => a.address === addr)) return "That address is already in use.";
	if (file.addresses.length >= MAX_MASKED) return `You can have up to ${MAX_MASKED} masked addresses.`;
	return null;
}

/** The leak website an email's header names, from the header Mail App adds when it arrives. */
export function leakFromHeaders(rawHeaders: string | null | undefined): string | null {
	if (!rawHeaders) return null;
	try {
		const headers = JSON.parse(rawHeaders) as { key?: string; value?: string }[];
		const h = Array.isArray(headers) ? headers.find((x) => x?.key?.toLowerCase() === MASKED_LEAK_HEADER) : undefined;
		return h?.value ? h.value.toLowerCase() : null;
	} catch {
		return null;
	}
}

/** "In 7 days", "on 1 Nov" etc. turned into an end date. Days are whole days from now. */
export function expiryFromDays(days: number, now: Date = new Date()): string {
	return new Date(now.getTime() + days * 86_400_000).toISOString();
}
