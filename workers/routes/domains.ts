// Mail App addition (not part of upstream Agentic Inbox).
// The Domains page: every domain this install receives mail for and whether its mail records look
// right. A domain is set up in Cloudflare first (Email Routing with a catch-all to this Worker), then
// listed here in domains.json. An admin can take an added domain off the list again.

import { Hono } from "hono";
import { z } from "zod";
import { domainOf } from "../../shared/addresses";
import { cleanDomainName } from "../../shared/domains";
import { installDomains, loadAddressBook, loadDomainsFile, saveDomainsFile } from "../lib/addresses";
import { requireAdmin } from "../lib/people";
import { checkDomain, configuredDomains } from "../lib/setup-checks";
import type { MailboxContext } from "../lib/mailbox";

export const domains = new Hono<MailboxContext>();

domains.get("/api/v1/domains", requireAdmin, async (c) => {
	const [{ domains: all, mailboxes }, file, book] = await Promise.all([
		installDomains(c.env), loadDomainsFile(c.env.BUCKET), loadAddressBook(c.env.BUCKET),
	]);
	const main = configuredDomains(c.env)[0] ?? null;
	const added = new Set(file.domains.map((d) => d.name));
	// Each domain's records, looked up in public DNS like any other mail service would (quick, and in parallel).
	const checks = await Promise.all(all.map((d) => checkDomain(d, mailboxes.find((m) => domainOf(m) === d))));
	return c.json({
		domains: all.map((name, i) => {
			const inUse = mailboxes.filter((m) => domainOf(m) === name).length + book.aliases.filter((a) => domainOf(a.address) === name).length;
			return {
				name,
				main: name === main,
				// Only domains added from here can be taken off here; the main one came with the install.
				removable: added.has(name) && name !== main && inUse === 0,
				mailboxes: mailboxes.filter((m) => domainOf(m) === name).length,
				checks: checks[i].checks.map((ch) => ({ id: ch.id, status: ch.status })),
			};
		}),
	});
});

// Takes a domain off Mail App's list. Its Cloudflare settings stay as they are (mail to it still
// reaches Mail App, which drops it, as for any address it doesn't know), so nothing on the account
// changes without the person seeing it.
domains.delete("/api/v1/domains/:domain", requireAdmin, async (c) => {
	const name = cleanDomainName(c.req.param("domain"));
	if (!name) return c.json({ error: "That isn't a domain." }, 400);
	const [{ mailboxes }, file, book] = await Promise.all([installDomains(c.env), loadDomainsFile(c.env.BUCKET), loadAddressBook(c.env.BUCKET)]);
	if (!file.domains.some((d) => d.name === name)) return c.json({ error: "Not found" }, 404);
	if (mailboxes.some((m) => domainOf(m) === name) || book.aliases.some((a) => domainOf(a.address) === name)) {
		return c.json({ error: `${name} still has mailboxes or extra addresses. Remove those first.` }, 409);
	}
	await saveDomainsFile(c.env.BUCKET, { domains: file.domains.filter((d) => d.name !== name) });
	return c.body(null, 204);
});

// Adds domains to the list. Only domains whose mail already reaches Cloudflare are accepted.
domains.post("/api/v1/domains", requireAdmin, async (c) => {
	const { domains: names } = z.object({ domains: z.array(z.string()).max(50) }).parse(await c.req.json());
	const { domains: all } = await installDomains(c.env);
	const wanted = [...new Set(names.map(cleanDomainName).filter((n): n is string => !!n && !all.includes(n)))];
	// Mail for it has to reach Cloudflare (and so Mail App) for it to be any use.
	const ready: string[] = [];
	for (const name of wanted) {
		const mx = (await checkDomain(name, undefined)).checks.find((ch) => ch.id === "mx");
		if (mx?.status !== "fix") ready.push(name);
	}
	const file = await loadDomainsFile(c.env.BUCKET);
	const now = new Date().toISOString();
	await saveDomainsFile(c.env.BUCKET, { domains: [...file.domains, ...ready.map((name) => ({ name, added: now }))] });
	return c.json({ added: ready, skipped: wanted.filter((n) => !ready.includes(n)) });
});
