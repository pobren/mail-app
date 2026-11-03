// Mail App addition (not part of upstream Agentic Inbox).
// Which addresses an incoming email could be for, best first. The delivery address Cloudflare
// hands us (the envelope) is the truth: it's set even when you're only in CC or BCC, or the
// mail came through a mailing list. The visible To and CC lines are a fallback.

export function recipientCandidates(
	envelopeTo: string | undefined,
	to: (string | undefined)[],
	cc: (string | undefined)[],
	allowed: string[] = [],
): string[] {
	const allow = allowed.map((a) => a.toLowerCase());
	const seen = new Set<string>();
	for (const a of [envelopeTo, ...to, ...cc]) {
		const addr = (a ?? "").trim().toLowerCase();
		if (!addr || !addr.includes("@")) continue;
		if (allow.length && !allow.includes(addr)) continue;
		seen.add(addr);
	}
	return [...seen];
}
