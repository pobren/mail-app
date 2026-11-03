// Copyright (c) 2026 Paul O'Brien. Licensed under the Apache 2.0 license.
// Added for Mail App: checks behind the setup wizard (/setup).

import type { Env } from "../types";

import type { DomainChecks, SetupCheck, SetupStatus } from "../../shared/setup";

import { ROUTING_DKIM_SELECTOR, checkDkim, checkDmarc, checkMx, checkSpf, joinTxt } from "../../shared/dns-checks";
export { checkDkim, checkDmarc, checkMx, checkSpf, joinTxt };

// -- DNS over HTTPS ------------------------------------------------

type Resolver = (name: string, type: "MX" | "TXT") => Promise<string[] | null>;

/** Looks a record up with Cloudflare's public resolver. Returns null if the lookup itself failed. */
export const dohResolve: Resolver = async (name, type) => {
	try {
		const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
		const res = await fetch(url, { headers: { accept: "application/dns-json" } });
		if (!res.ok) return null;
		const body = (await res.json()) as { Status: number; Answer?: { type: number; data: string }[] };
		// 0 = NOERROR, 3 = NXDOMAIN (no such name, so no records)
		if (body.Status !== 0 && body.Status !== 3) return null;
		const wanted = type === "MX" ? 15 : 16;
		return (body.Answer ?? [])
			.filter((a) => a.type === wanted)
			.map((a) => (type === "TXT" ? joinTxt(a.data) : a.data));
	} catch {
		return null;
	}
};

// -- Checks against this Worker's own setup -------------------------

export function checkSignIn(env: Pick<Env, "POLICY_AUD" | "TEAM_DOMAIN">, isDev: boolean): SetupCheck {
	if (isDev) return { id: "signin", status: "unknown" };
	return { id: "signin", status: env.POLICY_AUD && env.TEAM_DOMAIN ? "ok" : "fix" };
}

async function checkStorage(bucket: R2Bucket): Promise<SetupCheck> {
	const key = "setup/storage-check.txt";
	try {
		await bucket.put(key, new Date().toISOString());
		const back = await bucket.get(key);
		await bucket.delete(key);
		return { id: "storage", status: back ? "ok" : "fix" };
	} catch {
		return { id: "storage", status: "fix" };
	}
}

function checkSending(env: Env): SetupCheck {
	return { id: "sending", status: env.EMAIL && typeof env.EMAIL.send === "function" ? "ok" : "fix" };
}

// -- Everything the wizard shows ------------------------------------

export function configuredDomains(env: Pick<Env, "DOMAINS">): string[] {
	return (env.DOMAINS || "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
}

export async function checkDomain(domain: string, mailbox: string | undefined, resolve: Resolver = dohResolve): Promise<DomainChecks> {
	const [mx, spf, dkim, dmarc] = await Promise.all([
		resolve(domain, "MX"),
		resolve(domain, "TXT"),
		resolve(`${ROUTING_DKIM_SELECTOR}._domainkey.${domain}`, "TXT"),
		resolve(`_dmarc.${domain}`, "TXT"),
	]);
	return {
		domain,
		checks: [checkMx(mx), checkSpf(domain, spf), checkDkim(dkim), checkDmarc(domain, mailbox, dmarc)],
	};
}

export async function setupStatus(env: Env, isDev: boolean, mailboxes: string[]): Promise<SetupStatus> {
	const domains = configuredDomains(env);
	const firstMailbox = (domain: string) => mailboxes.find((m) => m.endsWith(`@${domain}`));
	const [storage, ...domainChecks] = await Promise.all([
		checkStorage(env.BUCKET),
		...domains.map((d) => checkDomain(d, firstMailbox(d))),
	]);
	return {
		app: [checkSignIn(env, isDev), storage, checkSending(env)],
		domains: domainChecks,
	};
}
