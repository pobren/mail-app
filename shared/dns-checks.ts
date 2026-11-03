// Copyright (c) 2026 Paul O'Brien. Licensed under the Apache 2.0 license.
// Added for Mail App: the DNS record rules, used by the app's setup wizard.

import type { DnsFix, SetupCheck } from "./setup";

// Email Routing's MX hosts are route1/2/3.mx.cloudflare.net, and its SPF include is
// _spf.mx.cloudflare.net. Its DKIM key is published at cf2024-1._domainkey.
const ROUTING_MX = /\.mx\.cloudflare\.net\.?$/i;
const ROUTING_SPF = "include:_spf.mx.cloudflare.net";
export const ROUTING_DKIM_SELECTOR = "cf2024-1";

/** DoH returns TXT data as one or more quoted strings; join them into the record's value. */
export function joinTxt(data: string): string {
	const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
	if (!parts) return data;
	return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}

export function checkMx(records: string[] | null): SetupCheck {
	if (records === null) return { id: "mx", status: "unknown" };
	const ok = records.length > 0 && records.every((r) => ROUTING_MX.test(r.split(/\s+/).pop() ?? ""));
	return { id: "mx", status: ok ? "ok" : "fix", found: records.join(", ") || undefined };
}

export function checkSpf(domain: string, records: string[] | null): SetupCheck {
	if (records === null) return { id: "spf", status: "unknown" };
	const spf = records.filter((r) => r.toLowerCase().startsWith("v=spf1"));
	const fix: DnsFix = { type: "TXT", name: domain, value: `v=spf1 ${ROUTING_SPF} ~all` };
	if (spf.length !== 1) return { id: "spf", status: "fix", found: spf.join(" | ") || undefined, fix };
	const ok = spf[0].toLowerCase().includes(ROUTING_SPF);
	return { id: "spf", status: ok ? "ok" : "fix", found: spf[0], fix: ok ? undefined : fix };
}

export function checkDkim(records: string[] | null): SetupCheck {
	if (records === null) return { id: "dkim", status: "unknown" };
	const ok = records.some((r) => /(^|;)\s*p=[A-Za-z0-9+/=]{20,}/.test(r));
	return { id: "dkim", status: ok ? "ok" : "fix" };
}

export function checkDmarc(domain: string, mailbox: string | undefined, records: string[] | null): SetupCheck {
	if (records === null) return { id: "dmarc", status: "unknown" };
	const dmarc = records.filter((r) => r.toUpperCase().startsWith("V=DMARC1"));
	if (dmarc.length === 1) return { id: "dmarc", status: "ok", found: dmarc[0] };
	const report = mailbox ?? `postmaster@${domain}`;
	return {
		id: "dmarc",
		status: "fix",
		found: dmarc.join(" | ") || undefined,
		fix: { type: "TXT", name: `_dmarc.${domain}`, value: `v=DMARC1; p=none; rua=mailto:${report}` },
	};
}
