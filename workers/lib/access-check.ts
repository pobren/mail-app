// Mail App addition (not part of upstream Agentic Inbox).
// Lets Cloudflare Access ask this install "is this person allowed in?" each time someone signs in
// (Access calls it an External Evaluation rule), so the People list is the sign-in list and inviting
// someone works straight away, with no token and no re-run of the installer.
//
// Access posts { token } here: a JWT signed with the account's Access keys, carrying the person's
// identity and a nonce. We answer { token } signed with this install's own key, saying
// { success, nonce }. Access fetches our public key from /access-check/keys.
// A Cloudflare Access bypass rule lets /access-check/ through without sign-in, and the sign-in rule points here.
//
// Cloudflare docs: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/external-evaluation/
import { SignJWT, createRemoteJWKSet, exportJWK, generateKeyPair, importJWK, jwtVerify, type JWK } from "jose";
import { normaliseAddress } from "shared/addresses";
import { signInList } from "shared/people";
import type { Env } from "../types";
import { isOwner, loadPeople } from "./people";

export const ACCESS_CHECK_PATH = "/access-check";
const KEY_OBJECT = "access-check-key.json";

export interface StoredKey { kid: string; privateJwk: JWK; publicJwk: JWK }
const cached = new Map<string, StoredKey>();

/**
 * This install's signing key, made the first time it's needed and kept in its own R2. Each use has its
 * own key (passkey sign-in keeps one at passkey-key.json), so a token made for one can't pass as another.
 */
export async function signingKey(env: Env, object: string = KEY_OBJECT): Promise<StoredKey> {
	const known = cached.get(object);
	if (known) return known;
	const obj = await env.BUCKET.get(object);
	if (obj) {
		const stored = (await obj.json()) as StoredKey;
		cached.set(object, stored);
		return stored;
	}
	const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
	const kid = crypto.randomUUID();
	const made: StoredKey = {
		kid,
		privateJwk: await exportJWK(privateKey),
		publicJwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
	};
	// Only the first writer wins, so two sign-ins at once can't end up with different keys.
	const put = await env.BUCKET.put(object, JSON.stringify(made), { onlyIf: { etagDoesNotMatch: "*" } });
	if (!put) return signingKey(env, object);
	cached.set(object, made);
	return made;
}

/** Is this address someone Access should let in? Everyone on the People list who isn't paused, and the owner. */
export async function allowedToSignIn(env: Env, email: string): Promise<boolean> {
	const e = normaliseAddress(email);
	if (!e) return false;
	const { book } = await loadPeople(env.BUCKET);
	if (signInList(book).includes(e)) return true;
	return isOwner(env, e, book);
}

export async function handleAccessCheck(request: Request, env: Env): Promise<Response> {
	const path = new URL(request.url).pathname;
	if (request.method === "GET" && path === `${ACCESS_CHECK_PATH}/keys`) {
		const key = await signingKey(env);
		return Response.json({ keys: [key.publicJwk] }, { headers: { "cache-control": "public, max-age=300" } });
	}
	if (request.method !== "POST" || path !== `${ACCESS_CHECK_PATH}/evaluate`) return new Response("Not found", { status: 404 });
	if (!env.TEAM_DOMAIN) return new Response("Sign-in isn't set up", { status: 503 });

	let claims: { nonce?: unknown; identity?: { email?: unknown }; email?: unknown };
	try {
		const { token } = (await request.json()) as { token?: string };
		if (!token) return new Response("Missing token", { status: 400 });
		const team = new URL(env.TEAM_DOMAIN).origin;
		// TODO(confirm): Cloudflare's example checks the signature against the team's certs only, so no
		// issuer or audience is required here.
		const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL("/cdn-cgi/access/certs", team)));
		claims = payload as typeof claims;
	} catch {
		return new Response("Invalid token", { status: 401 });
	}
	const email = typeof claims.identity?.email === "string" ? claims.identity.email : typeof claims.email === "string" ? claims.email : "";
	const success = await allowedToSignIn(env, email);
	const key = await signingKey(env);
	const signed = await new SignJWT({ success, nonce: claims.nonce })
		.setProtectedHeader({ alg: "RS256", kid: key.kid })
		.setIssuedAt()
		.setExpirationTime("60s")
		.sign(await importJWK(key.privateJwk, "RS256"));
	return Response.json({ token: signed });
}
