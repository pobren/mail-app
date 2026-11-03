// Mail App addition (not part of upstream Agentic Inbox).
// Reads and saves the install's extra addresses (shared/addresses.ts) and extra domains
// (shared/domains.ts) in R2.
import { ADDRESS_BOOK_KEY, cleanAddressBook, domainOf, type AddressBook } from "../../shared/addresses";
import { DOMAINS_KEY, cleanDomainsFile, type DomainsFile } from "../../shared/domains";
import { listMailboxes } from "./email-helpers";
import { configuredDomains } from "./setup-checks";
import type { Env } from "../types";

export async function loadAddressBook(bucket: R2Bucket): Promise<AddressBook> {
	try {
		const obj = await bucket.get(ADDRESS_BOOK_KEY);
		return cleanAddressBook(obj ? await obj.json() : null);
	} catch {
		return cleanAddressBook(null);
	}
}

export async function saveAddressBook(bucket: R2Bucket, book: AddressBook): Promise<void> {
	await bucket.put(ADDRESS_BOOK_KEY, JSON.stringify(cleanAddressBook(book)), { httpMetadata: { contentType: "application/json" } });
}

export async function loadDomainsFile(bucket: R2Bucket): Promise<DomainsFile> {
	try {
		const obj = await bucket.get(DOMAINS_KEY);
		return cleanDomainsFile(obj ? await obj.json() : null);
	} catch {
		return cleanDomainsFile(null);
	}
}

export async function saveDomainsFile(bucket: R2Bucket, file: DomainsFile): Promise<void> {
	await bucket.put(DOMAINS_KEY, JSON.stringify(cleanDomainsFile(file)), { httpMetadata: { contentType: "application/json" } });
}

/**
 * The domains this install receives mail for: the one it was set up with first, then any added from
 * the Mailboxes page, then those of its mailboxes.
 */
export function ownDomains(env: Pick<Env, "DOMAINS">, mailboxes: string[], added: string[] = []): string[] {
	return [...new Set([...configuredDomains(env), ...added, ...mailboxes.map(domainOf)])].filter(Boolean);
}

/** ownDomains, reading the mailboxes and added domains from storage. */
export async function installDomains(env: Pick<Env, "DOMAINS" | "BUCKET">): Promise<{ domains: string[]; mailboxes: string[] }> {
	const [boxes, file] = await Promise.all([listMailboxes(env.BUCKET), loadDomainsFile(env.BUCKET)]);
	const mailboxes = boxes.map((m) => m.email);
	return { mailboxes, domains: ownDomains(env, mailboxes, file.domains.map((d) => d.name)) };
}
