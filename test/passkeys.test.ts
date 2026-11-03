import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_PASSKEYS_PER_PERSON, PASSKEY_CLIENT_ID, accessCallbackUrl, addPasskeyProblem, base64url, callbackWithCode, cleanPasskeyBook,
	cleanPasskeyName, clientCredentials, guessDeviceName, passkeysOf, readAuthorizeRequest, sameSecret, toView, verifierMatches,
} from "../shared/passkeys.ts";

const team = "https://myteam.cloudflareaccess.com";
const callback = `${team}/cdn-cgi/access/callback`;
const ask = (extra: Record<string, string> = {}) =>
	new URLSearchParams({ client_id: PASSKEY_CLIENT_ID, redirect_uri: callback, response_type: "code", state: "s1", nonce: "n1", ...extra });

test("only Cloudflare Access's own callback can receive a code", () => {
	assert.deepEqual(readAuthorizeRequest(ask(), team), { clientId: PASSKEY_CLIENT_ID, redirectUri: callback, state: "s1", nonce: "n1", codeChallenge: "" });
	assert.ok("error" in readAuthorizeRequest(ask({ redirect_uri: "https://evil.example/cdn-cgi/access/callback" }), team));
	assert.ok("error" in readAuthorizeRequest(ask({ redirect_uri: `${callback}?x=1` }), team));
	assert.ok("error" in readAuthorizeRequest(ask({ client_id: "someone-else" }), team));
	assert.ok("error" in readAuthorizeRequest(ask({ response_type: "token" }), team));
	assert.ok("error" in readAuthorizeRequest(ask({ code_challenge: "abc", code_challenge_method: "plain" }), team));
	assert.ok("error" in readAuthorizeRequest(ask(), ""));
	// TEAM_DOMAIN may be stored as the certs URL.
	assert.equal(accessCallbackUrl(`${team}/cdn-cgi/access/certs`), callback);
});

test("the code goes back with the state", () => {
	const url = new URL(callbackWithCode(callback, "c0de", "st&ate"));
	assert.equal(url.origin + url.pathname, callback);
	assert.equal(url.searchParams.get("code"), "c0de");
	assert.equal(url.searchParams.get("state"), "st&ate");
});

test("client id and secret from a Basic header or the form", () => {
	const basic = `Basic ${btoa("mail-app:s3cret")}`;
	assert.deepEqual(clientCredentials(basic, new URLSearchParams()), { id: "mail-app", secret: "s3cret" });
	assert.deepEqual(clientCredentials(null, new URLSearchParams({ client_id: "mail-app", client_secret: "x" })), { id: "mail-app", secret: "x" });
	assert.equal(clientCredentials(null, new URLSearchParams({ client_id: "mail-app" })), null);
	assert.equal(clientCredentials("Basic !!!", new URLSearchParams()), null);
	assert.ok(sameSecret("abc", "abc"));
	assert.ok(!sameSecret("abc", "abd"));
	assert.ok(!sameSecret("abc", "abcd"));
	assert.ok(!sameSecret("", ""));
});

test("PKCE: the verifier must hash to the challenge", async () => {
	const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
	const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	assert.ok(await verifierMatches(verifier, challenge));
	assert.ok(!(await verifierMatches("wrong", challenge)));
	assert.ok(!(await verifierMatches("", challenge)));
	assert.ok(await verifierMatches("", ""));
});

test("the stored list is cleaned, and people only see their own", () => {
	const book = cleanPasskeyBook({ passkeys: [
		{ id: "a", publicKey: "pk", counter: 3, email: " Paul@Example.com ", name: "  Mac   (Safari) ", created: "2026-10-16T10:00:00Z", transports: ["internal", 7] },
		{ id: "a", publicKey: "dup", email: "x@example.com" },
		{ id: "b", publicKey: "pk2", email: "sam@example.com", counter: -1 },
		{ id: "", publicKey: "pk", email: "x@example.com" },
		"junk",
	] });
	assert.equal(book.passkeys.length, 2);
	assert.equal(book.passkeys[0].email, "paul@example.com");
	assert.equal(book.passkeys[0].name, "Mac (Safari)");
	assert.deepEqual(book.passkeys[0].transports, ["internal"]);
	assert.equal(book.passkeys[1].counter, 0);
	assert.equal(book.passkeys[1].name, "Passkey");
	assert.deepEqual(passkeysOf(book, "PAUL@example.com").map((p) => p.id), ["a"]);
	assert.deepEqual(Object.keys(toView(book.passkeys[0])).sort(), ["created", "id", "name", "transports"]);
	assert.deepEqual(cleanPasskeyBook(null), { passkeys: [] });
	assert.equal(cleanPasskeyName("x".repeat(100)).length, 60);
});

test("one passkey once, and a limit per person", () => {
	const book = cleanPasskeyBook({ passkeys: Array.from({ length: MAX_PASSKEYS_PER_PERSON }, (_, i) => ({ id: `k${i}`, publicKey: "p", email: "a@example.com" })) });
	assert.match(addPasskeyProblem(book, "a@example.com", "new") ?? "", /up to/);
	assert.match(addPasskeyProblem(book, "b@example.com", "k1") ?? "", /already/);
	assert.equal(addPasskeyProblem(book, "b@example.com", "new"), null);
});

test("a friendly name for the device", () => {
	assert.equal(guessDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "iPhone (Safari)");
	assert.equal(guessDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"), "Mac (Chrome)");
	assert.equal(guessDeviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0"), "Windows PC (Edge)");
	assert.equal(guessDeviceName(""), "Passkey");
});
