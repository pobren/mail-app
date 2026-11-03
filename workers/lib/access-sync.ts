// Mail App addition (not part of upstream Agentic Inbox).
// Keeps the Cloudflare Access sign-in list in step with the people list, so an admin never has to
// open the Cloudflare dashboard. Uses a token made for this one account, which can
// only change Access settings (see the README). Nothing goes anywhere else.
//
// Cloudflare docs:
//   Reusable policies  https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/policies/
//   Revoke a user      https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/revoke_users/
import type { Env } from "../types";

const API = "https://api.cloudflare.com/client/v4";

/** Where a key the admin pasted on the People page is kept (the installer's own goes in a Worker secret). */
export const ACCESS_TOKEN_KEY = "access-token.json";

/** The sign-in key: the installer's Worker secret, or one the admin pasted in once. */
export async function accessToken(env: Env): Promise<string | null> {
	if (env.ACCESS_API_TOKEN) return env.ACCESS_API_TOKEN;
	try {
		const obj = await env.BUCKET.get(ACCESS_TOKEN_KEY);
		return obj ? (((await obj.json()) as { token?: string }).token ?? null) : null;
	} catch {
		return null;
	}
}

/** Can a sign-in key work here at all? Needs the account and sign-in rule the installer records. */
export const accessSetUp = (env: Env): boolean => !!(env.ACCESS_POLICY_ID && env.CF_ACCOUNT_ID);

/** Cloudflare asks this install who may sign in, so the People list is the sign-in list already. */
export const signInChecksPeopleList = (env: Env): boolean => env.ACCESS_CHECK === "on";

export async function accessSyncAvailable(env: Env): Promise<boolean> {
	return accessSetUp(env) && !!(await accessToken(env));
}

async function call<T>(env: Env, method: string, path: string, body?: unknown, token?: string): Promise<{ ok: boolean; result?: T; error?: string }> {
	try {
		const res = await fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}${path}`, {
			method,
			headers: { authorization: `Bearer ${token ?? (await accessToken(env))}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		const json = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message?: string }[] };
		if (res.ok && json.success !== false) return { ok: true, result: json.result };
		return { ok: false, error: json.errors?.[0]?.message || `Cloudflare said ${res.status}` };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

export type SyncResult = { ok: true } | { ok: false; manual: boolean; error?: string };

/**
 * Sets who Cloudflare Access lets in to exactly these addresses. The policy's other settings
 * (its name, how long a sign-in lasts) are kept as the installer left them.
 */
export async function syncSignInList(env: Env, emails: string[]): Promise<SyncResult> {
	// Nothing to copy: Cloudflare already asks Mail App (and overwriting the rule would remove that).
	if (signInChecksPeopleList(env)) return { ok: true };
	if (!(await accessSyncAvailable(env))) return { ok: false, manual: true };
	if (emails.length === 0) return { ok: false, manual: false, error: "Refusing to lock everyone out." };
	const path = `/access/policies/${env.ACCESS_POLICY_ID}`;
	const current = await call<{ name: string; decision: string; session_duration?: string }>(env, "GET", path);
	if (!current.ok || !current.result) return { ok: false, manual: false, error: current.error };
	const { name, decision, session_duration } = current.result;
	const saved = await call(env, "PUT", path, {
		name,
		decision,
		...(session_duration ? { session_duration } : {}),
		include: emails.map((email) => ({ email: { email } })),
	});
	return saved.ok ? { ok: true } : { ok: false, manual: false, error: saved.error };
}

/** Signs someone out everywhere, straight away. Best effort: the app shuts them out anyway. */
export async function signOutEverywhere(env: Env, email: string): Promise<boolean> {
	if (!(await accessSyncAvailable(env))) return false;
	return (await call(env, "POST", "/access/organizations/revoke_user", { email })).ok;
}

/** Checks a pasted key can read and change this install's sign-in rule, before it's saved. */
export async function checkAccessToken(env: Env, token: string): Promise<string | null> {
	if (!accessSetUp(env)) return "Set ACCESS_POLICY_ID and CF_ACCOUNT_ID first (see the README), so Mail App knows which Cloudflare sign-in rule is yours.";
	const got = await call<{ include?: unknown[] }>(env, "GET", `/access/policies/${env.ACCESS_POLICY_ID}`, undefined, token);
	return got.ok ? null : `Cloudflare didn't accept that key: ${got.error}. Check it has Access: Apps and Policies, Edit, for this account.`;
}
