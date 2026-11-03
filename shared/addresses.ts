// Mail App addition (not part of upstream Agentic Inbox).
// Extra addresses ("aliases") that deliver into a mailbox and can be sent from, each with its own
// optional name and signature, plus an optional catch-all mailbox for each of your domains, which
// gets mail for any other address there. Everything lives in one small file in R2 (addresses.json), so an address can only ever
// belong to one mailbox.
//
// Pure functions only, so the browser, the Worker and the tests can all use them.

export interface Alias {
	/** The extra address, lower case. */
	address: string;
	/** The mailbox it delivers into (that mailbox's own address). */
	mailbox: string;
	/** The name people see when you send from it. Missing means the mailbox's own name. */
	name?: string;
	/** Plain-text signature for emails from it. Missing means the mailbox's own signature. */
	signature?: string;
}

export interface AddressBook {
	aliases: Alias[];
	/**
	 * For each domain (lower case), the mailbox that gets mail for any other address there. A domain
	 * that isn't listed has no catch-all, so that mail is dropped.
	 */
	catchAll: Record<string, string>;
}

export interface Delivery {
	mailbox: string;
	/** The address the mail was actually sent to (an alias, the mailbox itself, or a catch-all address). */
	deliveredTo: string;
}

export const ADDRESS_BOOK_KEY = "addresses.json";
/** Header Mail App adds to each incoming email saying which address it came in on. */
export const DELIVERED_TO_HEADER = "x-mail-app-delivered-to";
export const MAX_ALIASES = 100;
export const MAX_ALIAS_NAME = 80;
export const MAX_ALIAS_SIGNATURE = 2000;

const DOMAIN_LIKE_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ADDRESS_RE = /^[a-z0-9.!#$%&'*/=?^_`{|}~+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function normaliseAddress(a: string): string {
	return a.trim().toLowerCase();
}

export function isAddress(a: string): boolean {
	return ADDRESS_RE.test(normaliseAddress(a));
}

const cleanText = (v: unknown, max: number) =>
	typeof v === "string" ? v.replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0b-\x1f]/g, "").trim().slice(0, max) : "";

/** Reads whatever is stored, dropping anything malformed, so a bad file never stops mail. */
export function cleanAddressBook(raw: unknown): AddressBook {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const seen = new Set<string>();
	const aliases: Alias[] = [];
	for (const a of Array.isArray(r.aliases) ? r.aliases : []) {
		if (!a || typeof a !== "object") continue;
		const address = typeof a.address === "string" ? normaliseAddress(a.address) : "";
		const mailbox = typeof a.mailbox === "string" ? normaliseAddress(a.mailbox) : "";
		if (!ADDRESS_RE.test(address) || !mailbox || seen.has(address)) continue;
		seen.add(address);
		const name = cleanText(a.name, MAX_ALIAS_NAME).replace(/\n/g, " ");
		const signature = cleanText(a.signature, MAX_ALIAS_SIGNATURE);
		aliases.push({ address, mailbox, ...(name ? { name } : {}), ...(signature ? { signature } : {}) });
	}
	const catchAll: Record<string, string> = {};
	if (typeof r.catchAll === "string" && r.catchAll) {
		// Saved before catch-alls were per domain (one domain per install then): it covers its own domain.
		const mailbox = normaliseAddress(r.catchAll);
		catchAll[domainOf(mailbox)] = mailbox;
	} else if (r.catchAll && typeof r.catchAll === "object") {
		for (const [domain, mailbox] of Object.entries(r.catchAll as Record<string, unknown>)) {
			if (typeof mailbox === "string" && mailbox && DOMAIN_LIKE_RE.test(domain.toLowerCase())) catchAll[domain.toLowerCase()] = normaliseAddress(mailbox);
		}
	}
	return { aliases, catchAll };
}

/** "sam+shopping@x.com" → "sam@x.com". Null when there's no +tag. */
export function withoutPlusTag(address: string): string | null {
	const at = address.lastIndexOf("@");
	const plus = address.indexOf("+");
	if (plus <= 0 || plus > at) return null;
	return address.slice(0, plus) + address.slice(at);
}

export function domainOf(address: string): string {
	const a = normaliseAddress(address);
	return a.slice(a.lastIndexOf("@") + 1);
}

/**
 * Which mailbox gets an incoming email, given its possible recipients best first.
 * Each recipient is tried as a mailbox, then an alias, then without any +tag. Only when none
 * match does the catch-all take mail sent to one of your own domains.
 */
export function resolveDelivery(
	candidates: string[],
	mailboxes: Iterable<string>,
	book: AddressBook,
	domains: string[],
): Delivery | null {
	const boxes = new Set([...mailboxes].map(normaliseAddress));
	const byAlias = new Map(book.aliases.map((a) => [a.address, a]));
	const match = (addr: string): Delivery | null => {
		if (boxes.has(addr)) return { mailbox: addr, deliveredTo: addr };
		const alias = byAlias.get(addr);
		if (alias && boxes.has(alias.mailbox)) return { mailbox: alias.mailbox, deliveredTo: addr };
		return null;
	};
	for (const raw of candidates) {
		const addr = normaliseAddress(raw);
		const base = withoutPlusTag(addr);
		const found = match(addr) ?? (base ? match(base) : null);
		if (found) return found;
	}
	const ours = new Set(domains.map(normaliseAddress));
	for (const raw of candidates) {
		const addr = normaliseAddress(raw);
		const domain = domainOf(addr);
		const catcher = book.catchAll[domain];
		if (ours.has(domain) && catcher && boxes.has(catcher)) return { mailbox: catcher, deliveredTo: addr };
	}
	return null;
}

/** The domains a mailbox is the catch-all for. */
export function catchAllDomains(book: AddressBook, mailbox: string): string[] {
	const m = normaliseAddress(mailbox);
	return Object.keys(book.catchAll).filter((d) => book.catchAll[d] === m).sort();
}

/** The address book without any trace of these mailboxes (they're being deleted). */
export function withoutMailboxes(book: AddressBook, mailboxes: string[]): AddressBook {
	const gone = new Set(mailboxes.map(normaliseAddress));
	return {
		aliases: book.aliases.filter((a) => !gone.has(a.mailbox)),
		catchAll: Object.fromEntries(Object.entries(book.catchAll).filter(([, m]) => !gone.has(m))),
	};
}

export function aliasesOf(book: AddressBook, mailbox: string): Alias[] {
	const m = normaliseAddress(mailbox);
	return book.aliases.filter((a) => a.mailbox === m);
}

/** Every address a mailbox may send from: its own first, then its aliases. */
export function sendableAddresses(book: AddressBook, mailbox: string): string[] {
	return [normaliseAddress(mailbox), ...aliasesOf(book, mailbox).map((a) => a.address)];
}

/** The bare address inside "Name <a@b.c>" or "a@b.c". */
export function bareAddress(value: string): string {
	return normaliseAddress(value.replace(/^.*</, "").replace(/>.*$/, ""));
}

/**
 * The address a reply should come from: whichever of the mailbox's addresses the original was
 * sent to (the address it came in on first, then To and CC), else the mailbox itself.
 */
export function replyFrom(book: AddressBook, mailbox: string, receivedAt: (string | null | undefined)[]): string {
	const mine = sendableAddresses(book, mailbox);
	for (const raw of receivedAt) {
		for (const part of (raw ?? "").split(",")) {
			const addr = bareAddress(part);
			if (mine.includes(addr)) return addr;
			const base = withoutPlusTag(addr);
			if (base && mine.includes(base)) return base;
		}
	}
	return mine[0];
}

/** Which address replies come from: the one the email was sent to, the main address, or one chosen address. */
export type ReplyFromSetting = "received" | "main" | string;

/** The reply's From, following the mailbox's "Reply from" setting. A chosen address that's gone falls back to "received". */
export function replyFromSetting(
	book: AddressBook,
	mailbox: string,
	setting: ReplyFromSetting | null | undefined,
	receivedAt: (string | null | undefined)[],
): string {
	const mine = sendableAddresses(book, mailbox);
	if (setting === "main") return mine[0];
	const chosen = setting && setting !== "received" ? normaliseAddress(setting) : null;
	if (chosen && mine.includes(chosen)) return chosen;
	return replyFrom(book, mailbox, receivedAt);
}

/** The address an incoming email came in on, from the header Mail App adds when it arrives. */
export function deliveredTo(rawHeaders: string | null | undefined): string | null {
	if (!rawHeaders) return null;
	try {
		const headers = JSON.parse(rawHeaders) as { key?: string; value?: string }[];
		const h = Array.isArray(headers) ? headers.find((x) => x?.key?.toLowerCase() === DELIVERED_TO_HEADER) : undefined;
		return h?.value ? normaliseAddress(h.value) : null;
	} catch {
		return null;
	}
}

/** Why an alias can't be added, in plain English, or null when it's fine. */
export function aliasProblem(
	address: string,
	mailbox: string,
	book: AddressBook,
	mailboxes: Iterable<string>,
	domains: string[],
): string | null {
	const addr = normaliseAddress(address);
	if (!ADDRESS_RE.test(addr)) return "That doesn't look like an email address.";
	const ours = domains.map(normaliseAddress).filter(Boolean);
	if (ours.length && !ours.includes(domainOf(addr))) {
		return `It has to be an address at ${ours.join(" or ")}.`;
	}
	if ([...mailboxes].map(normaliseAddress).includes(addr)) return "That address is already a mailbox of its own.";
	const taken = book.aliases.find((a) => a.address === addr);
	if (taken) return taken.mailbox === normaliseAddress(mailbox) ? "This mailbox already has that address." : `That address already goes to ${taken.mailbox}.`;
	if (book.aliases.length >= MAX_ALIASES) return `You can have up to ${MAX_ALIASES} extra addresses.`;
	return null;
}

/** Why a new mailbox can't have this address, in plain English, or null when it's free. */
export function mailboxProblem(address: string, book: AddressBook): string | null {
	const addr = normaliseAddress(address);
	const taken = book.aliases.find((a) => a.address === addr);
	return taken ? `${addr} is already an extra address of ${taken.mailbox}. Remove it there in Settings, Addresses first.` : null;
}
