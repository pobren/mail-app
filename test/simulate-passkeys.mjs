// Passkey sign-in end to end against a local Mail App (npm run dev:local), in a real browser with a
// virtual authenticator standing in for Touch ID. Needs .dev.vars with:
//   TEAM_DOMAIN=https://test.cloudflareaccess.com
//   PASSKEY_CLIENT_SECRET=local-test-secret
// Run: node test/simulate-passkeys.mjs [http://localhost:5173] [screenshot folder]
// (Passkeys need a proper hostname, so use localhost, not 127.0.0.1.)
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createRemoteJWKSet, jwtVerify } from "jose";

const require = createRequire(import.meta.url);
const { chromium } = require(`${execSync("npm root -g").toString().trim()}/playwright`);

const BASE = process.argv[2] ?? "http://localhost:5173";
const SHOTS = process.argv[3];
const CALLBACK = "https://test.cloudflareaccess.com/cdn-cgi/access/callback";
const SECRET = "local-test-secret";
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; };
const b64url = (buf) => Buffer.from(buf).toString("base64url");

await fetch(`${BASE}/api/v1/mailboxes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@example.com", name: "Owner" }) });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
	options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

// 1. Add a passkey in Settings > Account.
await page.goto(`${BASE}/mailbox/owner%40example.com/settings?tab=account`);
await page.getByText("Passkeys", { exact: true }).waitFor();
if (SHOTS) await page.getByText("Passkeys", { exact: true }).scrollIntoViewIfNeeded().then(() => page.screenshot({ path: `${SHOTS}/1-settings-empty.png` }));
await page.getByRole("textbox", { name: "Name this passkey" }).fill("Test Mac");
await page.getByRole("button", { name: "Add a passkey" }).click();
await page.getByText("Test Mac").waitFor();
check(true, "passkey added and listed in Settings");
if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-settings-added.png` });
const listed = await (await fetch(`${BASE}/api/v1/passkeys`)).json();
check(listed.passkeys.length === 1 && listed.passkeys[0].name === "Test Mac", "API lists one passkey");
check(!("publicKey" in listed.passkeys[0]), "the key itself is never sent to the app");

// 2. Cloudflare's "Passkey" button: our sign-in page, then back to Access with a code.
const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
const ask = new URLSearchParams({ client_id: "mail-app", redirect_uri: CALLBACK, response_type: "code", scope: "openid email", state: "st-1", nonce: "no-1", code_challenge: challenge, code_challenge_method: "S256" });
let landed = null;
await page.route("https://test.cloudflareaccess.com/**", (route) => { landed = route.request().url(); return route.fulfill({ status: 200, body: "Access" }); });
await page.goto(`${BASE}/passkey/authorize?${ask}`);
if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-sign-in-page.png` });
await page.getByRole("button", { name: "Use my passkey" }).click();
await page.waitForURL((u) => u.hostname === "test.cloudflareaccess.com");
const back = new URL(landed);
check(back.origin + back.pathname === CALLBACK && back.searchParams.get("state") === "st-1", "sent back to Access's callback with the state");
const code = back.searchParams.get("code");

// 3. Access swaps the code for an id token.
const tokenReq = (body, auth = `Basic ${Buffer.from(`mail-app:${SECRET}`).toString("base64")}`) =>
	fetch(`${BASE}/passkey/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: auth }, body: new URLSearchParams(body) });
let r = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: "wrong" });
check(r.status === 400, "a wrong PKCE verifier is refused");
r = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: verifier }, `Basic ${Buffer.from("mail-app:nope").toString("base64")}`);
check(r.status === 401, "a wrong client secret is refused");
r = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: verifier });
const tokens = await r.json();
check(r.ok && !!tokens.id_token, "code swapped for an id token");
const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(`${BASE}/passkey/keys`)), { issuer: `${BASE}/passkey`, audience: "mail-app" });
check(payload.email === "owner@example.com" && payload.nonce === "no-1" && payload.email_verified === true, "id token says owner@example.com, with the nonce");
const info = await (await fetch(`${BASE}/passkey/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json();
check(info.email === "owner@example.com", "userinfo answers too");
r = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: verifier });
check(r.status === 400, "a code works only once");

// 4. Bad requests never get a sign-in page.
r = await fetch(`${BASE}/passkey/authorize?${new URLSearchParams({ ...Object.fromEntries(ask), redirect_uri: "https://evil.example/cdn-cgi/access/callback" })}`);
check(r.status === 400, "a different callback address is refused");

// 5. After removing the passkey, it no longer signs in.
const used = await (await fetch(`${BASE}/api/v1/passkeys`)).json();
check(!!used.passkeys[0].lastUsed, "last used date noted");
r = await fetch(`${BASE}/api/v1/passkeys/${encodeURIComponent(used.passkeys[0].id)}`, { method: "DELETE" });
check(r.status === 204, "passkey removed");
await page.goto(`${BASE}/passkey/authorize?${ask}`);
await page.getByRole("button", { name: "Use my passkey" }).click();
await page.getByText(/doesn't know this passkey/).waitFor();
check(true, "a removed passkey is refused with a plain message");
if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-removed-passkey.png` });

// 6. Phone-sized pages.
if (SHOTS) {
	await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
	const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
	await phone.goto(`${BASE}/passkey/authorize?${ask}`);
	await phone.screenshot({ path: `${SHOTS}/5-sign-in-phone.png` });
	await phone.goto(`${BASE}/mailbox/owner%40example.com/settings?tab=account`);
	await phone.getByText("Passkeys", { exact: true }).scrollIntoViewIfNeeded();
	await phone.screenshot({ path: `${SHOTS}/6-settings-phone.png` });
}

await browser.close();
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
