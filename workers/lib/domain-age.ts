// Mail App addition (not part of upstream Agentic Inbox).
// How many days ago a sender's domain was registered, for the "brand-new domain" spam check.
// Asks the domain's own registry over RDAP, found from IANA's public list, so only the domain name
// leaves the install and it goes to the people who already run that domain ending. Answers are
// cached for a day. Any failure or slow answer just means "don't know", which never marks spam.

const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const TIMEOUT_MS = 2500;
const DAY = 86_400_000;

async function fetchJson(url: string, cacheSeconds: number): Promise<unknown> {
	const res = await fetch(url, {
		headers: { accept: "application/rdap+json, application/json" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
		cf: { cacheTtl: cacheSeconds, cacheEverything: true },
	} as RequestInit);
	if (!res.ok) return null;
	return res.json();
}

/** The registry's RDAP address for a domain ending, from IANA's list. */
async function registryFor(ending: string): Promise<string | null> {
	const list = (await fetchJson(BOOTSTRAP_URL, 86_400)) as { services?: [string[], string[]][] } | null;
	for (const [endings, urls] of list?.services ?? []) {
		if (endings.includes(ending)) return urls.find((u) => u.startsWith("https://")) ?? urls[0] ?? null;
	}
	return null;
}

/**
 * Days since a site (such as "example.co.uk", not a mail server name under it) was registered,
 * or null when it can't be found out.
 */
export async function domainAgeDays(site: string, now = Date.now()): Promise<number | null> {
	try {
		if (!site.includes(".")) return null;
		const ending = site.split(".").pop()!;
		const base = await registryFor(ending);
		if (!base) return null;
		const info = (await fetchJson(`${base.replace(/\/?$/, "/")}domain/${encodeURIComponent(site)}`, 86_400)) as
			{ events?: { eventAction?: string; eventDate?: string }[] } | null;
		const registered = info?.events?.find((e) => e.eventAction === "registration")?.eventDate;
		const when = registered ? Date.parse(registered) : NaN;
		return Number.isFinite(when) ? Math.floor((now - when) / DAY) : null;
	} catch {
		return null;
	}
}
