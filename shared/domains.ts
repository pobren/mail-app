// Mail App addition (not part of upstream Agentic Inbox).
// The extra domains an install receives mail for, beyond the one it was installed with. mailapp.com's
// "Add domains" page sets each one up on the person's Cloudflare account and then lists it here, in
// domains.json in the install's own storage (R2). Admins can take a domain off the list again on
// the Mailboxes page.
//
// Pure functions only, so the app, the Worker and the tests can all use them.

export const DOMAINS_KEY = "domains.json";
/** Plenty for one person or a small business, and keeps the Mailboxes page and DNS checks quick. */
export const MAX_DOMAINS = 50;

export interface AddedDomain {
	/** Lower case, no trailing dot. */
	name: string;
	/** When it was added (ISO). */
	added: string;
}

export interface DomainsFile {
	domains: AddedDomain[];
}

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

export function cleanDomainName(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const d = input.trim().toLowerCase().replace(/\.$/, "");
	return DOMAIN_RE.test(d) ? d : null;
}

/** Reads whatever is stored, dropping anything malformed or repeated, so a bad file never stops mail. */
export function cleanDomainsFile(raw: unknown): DomainsFile {
	const list = (raw && typeof raw === "object" ? (raw as { domains?: unknown }).domains : null) ?? [];
	const seen = new Set<string>();
	const domains: AddedDomain[] = [];
	for (const d of Array.isArray(list) ? list : []) {
		const name = cleanDomainName((d as { name?: unknown } | null)?.name);
		if (!name || seen.has(name)) continue;
		seen.add(name);
		const added = (d as { added?: unknown }).added;
		domains.push({ name, added: typeof added === "string" ? added : "" });
		if (domains.length >= MAX_DOMAINS) break;
	}
	return { domains };
}

/** The file with these domains added (those already there keep their date). */
export function addDomains(file: DomainsFile, names: string[], now: string): DomainsFile {
	const have = new Set(file.domains.map((d) => d.name));
	const extra = names.map(cleanDomainName).filter((n): n is string => !!n && !have.has(n));
	return cleanDomainsFile({ domains: [...file.domains, ...[...new Set(extra)].map((name) => ({ name, added: now }))] });
}
