// Mail App 2.8: the checks behind JMAP push subscriptions (workers/jmap/push.ts), kept here so they can be tested.

/** Longest a subscription lasts before the app must stretch it again (the same as Fastmail). */
export const MAX_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
/** Per API key, so one key can't fill the file. */
export const MAX_PER_KEY = 50;
/** The types Mail App can tell an app about. */
export const PUSH_TYPES = ["Email", "EmailDelivery", "Mailbox", "Thread"];

/** Checks an address an app gave us: https only, and never something on this network. */
export function pushUrlProblem(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length > 2000) return "url must be an https address.";
	let u: URL;
	try { u = new URL(raw); } catch { return "url must be an https address."; }
	if (u.protocol !== "https:") return "url must be an https address.";
	const host = u.hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")
		|| /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || !host.includes(".")) return "url must be a public https address.";
	return null;
}

/** RFC 8291 keys: p256dh is a 65 byte P-256 public key and auth 16 random bytes, both base64url. */
export function pushKeysProblem(raw: unknown): string | null {
	if (raw == null) return null;
	if (typeof raw !== "object") return "keys must have p256dh and auth.";
	const k = raw as Record<string, unknown>;
	const ok = (v: unknown, bytes: number) => typeof v === "string" && /^[A-Za-z0-9_-]+=*$/.test(v) && Math.floor(v.replace(/=+$/, "").length * 3 / 4) === bytes;
	if (!ok(k.p256dh, 65) || !ok(k.auth, 16)) return "keys must have p256dh (65 bytes) and auth (16 bytes), base64url.";
	return null;
}

/** The expiry a subscription gets: what the app asked for, but no later than 30 days from now. */
export function clampExpires(asked: unknown, now = Date.now()): string {
	const latest = now + MAX_LIFE_MS;
	const t = typeof asked === "string" ? Date.parse(asked) : NaN;
	return new Date(Number.isFinite(t) && t > now && t < latest ? t : latest).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function typesProblem(raw: unknown): string | null {
	if (raw == null) return null;
	if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) return "types must be a list of type names, or null.";
	return null;
}

/** Whether a subscription wants to hear that mail arrived. */
export function wantsDelivery(sub: { types: string[] | null }): boolean {
	return sub.types == null || sub.types.some((t) => t === "EmailDelivery" || t === "Email" || t === "Mailbox" || t === "Thread");
}
