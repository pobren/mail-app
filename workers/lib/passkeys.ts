// Mail App addition (not part of upstream Agentic Inbox).
// Passkey sign-in (see shared/passkeys.ts for the idea and the rules).
//
// Two halves:
// - Adding a passkey, from Settings, while signed in (workers/routes/passkeys.ts calls the functions here).
// - A small OpenID Connect sign-in service at /passkey/, which Cloudflare Access offers as "Passkey" on
//   its sign-in page. a Cloudflare Access bypass rule lets /passkey/ through without signing in; it's added to Access with
//   a client secret it also gives this Worker (PASSKEY_CLIENT_SECRET), and only Access's own callback
//   address can receive a code, so it can't be used to sign in anywhere else.
//
// Access still decides who may sign in: it checks the address we vouch for against the People list.
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { SignJWT, importJWK, jwtVerify, type JWTPayload } from "jose";
import {
	PASSKEYS_KEY, PASSKEY_CLIENT_ID, PASSKEY_PATH, addPasskeyProblem, callbackWithCode, cleanPasskeyBook, cleanPasskeyName,
	clientCredentials, passkeysOf, readAuthorizeRequest, sameSecret, verifierMatches, type AuthorizeRequest, type PasskeyBook,
	type StoredPasskey,
} from "shared/passkeys";
import { PASSKEY_MARK_WHITE, markSrc } from "shared/passkey-mark";
import type { Env } from "../types";
import { allowedToSignIn, signingKey } from "./access-check";

const KEY_OBJECT = "passkey-key.json";
const CODES_KEY = "passkey-codes.json";
const RP_NAME = "Mail App";

/** True once the owner has added passkey sign-in to Cloudflare's sign-in page. */
export function passkeysSwitchedOn(env: Env, dev: boolean): boolean {
	return dev || !!env.PASSKEY_CLIENT_SECRET;
}

// -- The stored list -----------------------------------------------------------

export async function loadPasskeys(bucket: R2Bucket): Promise<{ book: PasskeyBook; etag: string | null }> {
	const obj = await bucket.get(PASSKEYS_KEY);
	if (!obj) return { book: cleanPasskeyBook(null), etag: null };
	return { book: cleanPasskeyBook(await obj.json().catch(() => null)), etag: obj.etag };
}

/** Changes the list, retrying if someone else changed it at the same moment. */
export async function updatePasskeys<T>(bucket: R2Bucket, change: (book: PasskeyBook) => T): Promise<T> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const { book, etag } = await loadPasskeys(bucket);
		const result = change(book);
		const put = await bucket.put(PASSKEYS_KEY, JSON.stringify(book), {
			onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
			httpMetadata: { contentType: "application/json" },
		});
		if (put) return result;
	}
	throw new Error("Couldn't save passkeys: too many changes at once");
}

// -- Short-lived signed tokens ---------------------------------------------------

async function sign(env: Env, claims: JWTPayload, lasts: string, audience?: string): Promise<string> {
	const key = await signingKey(env, KEY_OBJECT);
	const jwt = new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: key.kid }).setIssuedAt().setExpirationTime(lasts);
	if (audience) jwt.setAudience(audience);
	return jwt.sign(await importJWK(key.privateJwk, "RS256"));
}

/** Reads one of our own tokens, only if it's the kind expected. */
async function readOwn<T>(env: Env, token: string, typ: string, audience?: string): Promise<T | null> {
	try {
		const key = await signingKey(env, KEY_OBJECT);
		const { payload } = await jwtVerify(token, await importJWK(key.publicJwk, "RS256"), audience ? { audience } : {});
		return payload.typ === typ ? (payload as T) : null;
	} catch {
		return null;
	}
}

// -- Adding a passkey (signed in) ------------------------------------------------

export async function registrationOptions(env: Env, request: Request, email: string, name: string) {
	const { hostname } = new URL(request.url);
	const { book } = await loadPasskeys(env.BUCKET);
	const options = await generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: hostname,
		userName: email,
		userDisplayName: name || email,
		// The same id for every passkey someone adds, so a device that already has one replaces it.
		userID: new TextEncoder().encode(email),
		attestationType: "none",
		excludeCredentials: passkeysOf(book, email).map((p) => ({ id: p.id, transports: p.transports as never })),
		authenticatorSelection: { residentKey: "required", userVerification: "required" },
	});
	const state = await sign(env, { typ: "app-passkey-add", email, challenge: options.challenge }, "10m");
	return { options, state };
}

export async function finishRegistration(
	env: Env,
	request: Request,
	email: string,
	input: { state: string; response: RegistrationResponseJSON; name?: string },
): Promise<{ ok: true; passkey: StoredPasskey } | { ok: false; error: string }> {
	const state = await readOwn<{ email: string; challenge: string }>(env, input.state, "app-passkey-add");
	if (!state || state.email !== email) return { ok: false, error: "That took too long. Please try adding the passkey again." };
	const { origin, hostname } = new URL(request.url);
	let verified;
	try {
		verified = await verifyRegistrationResponse({
			response: input.response,
			expectedChallenge: state.challenge,
			expectedOrigin: origin,
			expectedRPID: hostname,
			requireUserVerification: true,
		});
	} catch (e) {
		console.warn("Passkey not added:", (e as Error).message);
		return { ok: false, error: "Your device didn't confirm the passkey. Please try again." };
	}
	if (!verified.verified || !verified.registrationInfo) return { ok: false, error: "Your device didn't confirm the passkey. Please try again." };
	const { credential } = verified.registrationInfo;
	const passkey: StoredPasskey = {
		id: credential.id,
		publicKey: isoBase64URL.fromBuffer(credential.publicKey),
		counter: credential.counter,
		...(credential.transports?.length ? { transports: credential.transports } : {}),
		email,
		name: cleanPasskeyName(input.name),
		created: new Date().toISOString(),
	};
	const problem = await updatePasskeys(env.BUCKET, (book) => {
		const why = addPasskeyProblem(book, email, passkey.id);
		if (!why) book.passkeys.push(passkey);
		return why;
	});
	return problem ? { ok: false, error: problem } : { ok: true, passkey };
}

// -- The sign-in service Cloudflare Access uses ------------------------------------

export async function handlePasskey(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.slice(PASSKEY_PATH.length) || "/";
	const issuer = `${url.origin}${PASSKEY_PATH}`;

	if (request.method === "GET" && path === "/.well-known/openid-configuration") {
		return Response.json({
			issuer,
			authorization_endpoint: `${issuer}/authorize`,
			token_endpoint: `${issuer}/token`,
			userinfo_endpoint: `${issuer}/userinfo`,
			jwks_uri: `${issuer}/keys`,
			response_types_supported: ["code"],
			subject_types_supported: ["public"],
			id_token_signing_alg_values_supported: ["RS256"],
			scopes_supported: ["openid", "email", "profile"],
			token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
			code_challenge_methods_supported: ["S256"],
			claims_supported: ["sub", "email", "email_verified", "name"],
		});
	}
	if (request.method === "GET" && path === "/keys") {
		const key = await signingKey(env, KEY_OBJECT);
		return Response.json({ keys: [key.publicJwk] }, { headers: { "cache-control": "public, max-age=300" } });
	}
	if (!env.PASSKEY_CLIENT_SECRET || !env.TEAM_DOMAIN) return page("Passkeys aren't switched on yet", "Please sign in with an email code for now.", url.origin, 503);
	if (request.method === "GET" && path === "/authorize") return startSignIn(request, env);
	if (request.method === "POST" && path === "/authorize") return finishSignIn(request, env);
	if (request.method === "POST" && path === "/token") return token(request, env, issuer);
	if (path === "/userinfo") return userinfo(request, env);
	return new Response("Not found", { status: 404 });
}

async function startSignIn(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const ask = readAuthorizeRequest(url.searchParams, env.TEAM_DOMAIN);
	if ("error" in ask) return page("Something's not right", ask.error, url.origin, 400);
	const options = await generateAuthenticationOptions({ rpID: url.hostname, userVerification: "required", allowCredentials: [] });
	const state = await sign(env, { typ: "app-passkey-sign-in", challenge: options.challenge, ask }, "10m");
	return signInPage(options, state, url.origin);
}

async function finishSignIn(request: Request, env: Env): Promise<Response> {
	const fail = (error: string, status = 400) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
	let input: { state?: string; response?: AuthenticationResponseJSON };
	try {
		input = await request.json();
	} catch {
		return fail("Something went wrong. Please try again.");
	}
	const state = input.state ? await readOwn<{ challenge: string; ask: AuthorizeRequest }>(env, input.state, "app-passkey-sign-in") : null;
	if (!state) return fail("That took too long. Please go back to Mail App and try again.");
	const response = input.response;
	if (!response || typeof response.id !== "string") return fail("Something went wrong. Please try again.");

	const { book } = await loadPasskeys(env.BUCKET);
	const passkey = book.passkeys.find((p) => p.id === response.id);
	if (!passkey) return fail("Mail App doesn't know this passkey. It may have been removed. Please sign in with an email code, then add it again in Settings.");

	const { origin, hostname } = new URL(request.url);
	let newCounter: number;
	try {
		const result = await verifyAuthenticationResponse({
			response,
			expectedChallenge: state.challenge,
			expectedOrigin: origin,
			expectedRPID: hostname,
			credential: { id: passkey.id, publicKey: isoBase64URL.toBuffer(passkey.publicKey), counter: passkey.counter, transports: passkey.transports as never },
			requireUserVerification: true,
		});
		if (!result.verified) return fail("Your device didn't confirm it's you. Please try again.");
		newCounter = result.authenticationInfo.newCounter;
	} catch (e) {
		console.warn("Passkey sign-in refused:", (e as Error).message);
		return fail("Your device didn't confirm it's you. Please try again.");
	}
	if (!(await allowedToSignIn(env, passkey.email))) {
		return fail("This Mail App hasn't been shared with that address, or its access is paused. Please ask the person who runs it.", 403);
	}

	await updatePasskeys(env.BUCKET, (b) => {
		const p = b.passkeys.find((x) => x.id === passkey.id);
		if (p) {
			p.counter = Math.max(p.counter, newCounter);
			p.lastUsed = new Date().toISOString();
		}
	}).catch((e) => console.warn("Couldn't note the passkey was used:", e));

	const code = await sign(env, {
		typ: "app-passkey-code",
		jti: crypto.randomUUID(),
		email: passkey.email,
		nonce: state.ask.nonce,
		redirect_uri: state.ask.redirectUri,
		code_challenge: state.ask.codeChallenge,
	}, "2m", state.ask.clientId);
	return Response.json({ redirect: callbackWithCode(state.ask.redirectUri, code, state.ask.state) }, { headers: { "cache-control": "no-store" } });
}

/** Each code works once. Codes last two minutes, so only the last few minutes' are remembered. */
async function useCodeOnce(bucket: R2Bucket, jti: string, expires: number): Promise<boolean> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const obj = await bucket.get(CODES_KEY);
		const now = Math.floor(Date.now() / 1000);
		const raw = obj ? ((await obj.json().catch(() => [])) as { jti: string; exp: number }[]) : [];
		const used = (Array.isArray(raw) ? raw : []).filter((u) => u && u.exp > now);
		if (used.some((u) => u.jti === jti)) return false;
		used.push({ jti, exp: expires });
		const put = await bucket.put(CODES_KEY, JSON.stringify(used), { onlyIf: obj ? { etagMatches: obj.etag } : { etagDoesNotMatch: "*" } });
		if (put) return true;
	}
	return false;
}

async function token(request: Request, env: Env, issuer: string): Promise<Response> {
	const oauthError = (error: string, status = 400) => Response.json({ error }, { status, headers: { "cache-control": "no-store", pragma: "no-cache" } });
	const form = new URLSearchParams(await request.text());
	const client = clientCredentials(request.headers.get("authorization"), form);
	if (!client || client.id !== PASSKEY_CLIENT_ID || !sameSecret(client.secret, env.PASSKEY_CLIENT_SECRET ?? "")) return oauthError("invalid_client", 401);
	if (form.get("grant_type") !== "authorization_code") return oauthError("unsupported_grant_type");

	const code = await readOwn<{ jti: string; exp: number; email: string; nonce: string; redirect_uri: string; code_challenge: string }>(
		env, form.get("code") ?? "", "app-passkey-code", PASSKEY_CLIENT_ID,
	);
	if (!code || code.redirect_uri !== form.get("redirect_uri")) return oauthError("invalid_grant");
	if (!(await verifierMatches(form.get("code_verifier") ?? "", code.code_challenge))) return oauthError("invalid_grant");
	if (!(await useCodeOnce(env.BUCKET, code.jti, code.exp))) return oauthError("invalid_grant");

	const who = { sub: code.email, email: code.email, email_verified: true };
	const idToken = await sign(env, { ...who, iss: issuer, ...(code.nonce ? { nonce: code.nonce } : {}) }, "5m", PASSKEY_CLIENT_ID);
	const accessToken = await sign(env, { typ: "app-passkey-access", ...who }, "5m", `${issuer}/userinfo`);
	return Response.json(
		{ access_token: accessToken, token_type: "Bearer", expires_in: 300, id_token: idToken, scope: "openid email" },
		{ headers: { "cache-control": "no-store", pragma: "no-cache" } },
	);
}

async function userinfo(request: Request, env: Env): Promise<Response> {
	const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
	const issuer = `${new URL(request.url).origin}${PASSKEY_PATH}`;
	const who = await readOwn<{ email: string }>(env, bearer, "app-passkey-access", `${issuer}/userinfo`);
	if (!who) return Response.json({ error: "invalid_token" }, { status: 401 });
	return Response.json({ sub: who.email, email: who.email, email_verified: true });
}

// -- Pages -----------------------------------------------------------------------

const LOGO = `<svg width="44" height="44" viewBox="0 0 30 30" aria-hidden="true"><rect x="1" y="5" width="28" height="20" rx="4" fill="#c8102e"/><path d="M5 10l10 7 10-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const STYLE = `body{margin:0;font:18px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:#eef1f1;color:#12262b}main{max-width:36rem;margin:10vh auto;padding:0 20px}h1{font-size:2.4rem;line-height:1.15;letter-spacing:-.02em;margin:20px 0 12px}p{color:#33474d}a{color:#c8102e;font-weight:600}button{font:inherit;font-weight:700;font-size:1.15rem;background:#c8102e;color:#fff;border:0;border-radius:12px;padding:12px 28px;cursor:pointer;width:100%;max-width:22rem;display:inline-flex;align-items:center;justify-content:center;gap:10px}button:disabled{opacity:.6;cursor:default}#msg{min-height:1.6em;color:#a30d26;font-weight:600}.small{font-size:1rem}@media (prefers-color-scheme:dark){body{background:#0f1a1d;color:#e8eef0}p{color:#b8c6ca}a{color:#ff6b7f}#msg{color:#ff8a99}}`;
const escape = (s: string) => s.replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[ch]!);

function page(title: string, text: string, origin: string, status: number): Response {
	const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mail App: ${escape(title)}</title><style>${STYLE}</style></head>
<body><main>${LOGO}<h1>${escape(title)}</h1><p>${escape(text)}</p><p><a href="${escape(origin)}/">Back to Mail App</a></p></main></body></html>`;
	return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
}

/** Cloudflare's "Passkey" button lands here: one big button, and the browser asks for the passkey. */
function signInPage(options: unknown, state: string, origin: string): Response {
	// Inside <script type="application/json">, so only "<" needs escaping to keep it from ending the tag.
	const data = JSON.stringify({ options, state }).replace(/</g, "\\u003c");
	const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mail App: sign in with your passkey</title><style>${STYLE}</style></head>
<body><main>${LOGO}
<h1>Sign in with your passkey</h1>
<p>Use Face ID, Touch ID, Windows Hello or your phone, just as you do to unlock your device.</p>
<p><button id="go" type="button"><img src="${markSrc(PASSKEY_MARK_WHITE)}" alt="" width="34" height="34">Use my passkey</button></p>
<p id="msg" role="status" aria-live="polite"></p>
<p class="small">No passkey on this device yet? <a href="${escape(origin)}/">Sign in with an email code</a>, then add one in Settings, under Account.</p>
</main>
<script type="application/json" id="data">${data}</script>
<script>
(function () {
	var data = JSON.parse(document.getElementById("data").textContent);
	var go = document.getElementById("go"), msg = document.getElementById("msg");
	function toBytes(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
	function toText(buf) { var a = new Uint8Array(buf), s = ""; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); }
	async function signIn() {
		if (!window.PublicKeyCredential) { msg.textContent = "This browser can't use passkeys. Please sign in with an email code."; return; }
		go.disabled = true; msg.textContent = "";
		try {
			var o = data.options;
			var cred = await navigator.credentials.get({ publicKey: { challenge: toBytes(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification, allowCredentials: [] } });
			var r = cred.response;
			var body = { state: data.state, response: { id: cred.id, rawId: toText(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
				authenticatorAttachment: cred.authenticatorAttachment || undefined,
				response: { clientDataJSON: toText(r.clientDataJSON), authenticatorData: toText(r.authenticatorData), signature: toText(r.signature), userHandle: r.userHandle ? toText(r.userHandle) : undefined } } };
			msg.textContent = "Signing you in\\u2026";
			var res = await fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			var out = await res.json().catch(function () { return {}; });
			if (res.ok && out.redirect) { location.href = out.redirect; return; }
			msg.textContent = out.error || "Something went wrong. Please try again.";
		} catch (e) {
			msg.textContent = e && e.name === "NotAllowedError" ? "No passkey was used. Press the button to try again." : "Something went wrong. Please try again.";
		}
		go.disabled = false;
	}
	go.addEventListener("click", signIn);
})();
</script></body></html>`;
	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-frame-options": "DENY",
			"referrer-policy": "no-referrer",
		},
	});
}
