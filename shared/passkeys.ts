// Mail App addition (not part of upstream Agentic Inbox).
// Passkeys: sign in with Face ID, Touch ID, Windows Hello or a phone instead of waiting for an emailed code.
//
// Cloudflare Access still guards Mail App. Each install becomes a small sign-in service of its own
// (OpenID Connect, at /passkey/), which the owner adds to Cloudflare's sign-in page as "Passkey".
// Someone signs in once with an emailed code, adds a passkey in Settings, and from then on picks Passkey
// on Cloudflare's sign-in page. The emailed code stays as the backup. Access keeps checking the People
// list, so nothing about who may sign in changes.
//
// Rules and the stored list live here so they can be tested; workers/lib/passkeys.ts does the work.

export const PASSKEY_PATH = "/passkey";
/** The client id Cloudflare Access uses with this install's passkey sign-in. */
export const PASSKEY_CLIENT_ID = "mail-app";
/** Where the list of passkeys is kept in the install's own R2. */
export const PASSKEYS_KEY = "passkeys.json";
/** Enough for a few devices each across a full team, and small enough to stay a tiny file. */
export const MAX_PASSKEYS_PER_PERSON = 10;
export const MAX_PASSKEY_NAME = 60;

export interface StoredPasskey {
	/** The credential id, base64url. */
	id: string;
	/** The public key (COSE), base64url. */
	publicKey: string;
	counter: number;
	transports?: string[];
	/** Whose passkey it is (lower case). */
	email: string;
	/** What the person called it, e.g. "Sam's iPhone". */
	name: string;
	created: string;
	lastUsed?: string;
}

export interface PasskeyBook { passkeys: StoredPasskey[] }

/** What the app shows: everything but the key itself. */
export type PasskeyView = Omit<StoredPasskey, "publicKey" | "counter" | "email">;

export function emptyPasskeyBook(): PasskeyBook {
	return { passkeys: [] };
}

/** A stored list, cleaned: anything malformed is dropped rather than trusted. */
export function cleanPasskeyBook(raw: unknown): PasskeyBook {
	const list = (raw as { passkeys?: unknown } | null)?.passkeys;
	if (!Array.isArray(list)) return emptyPasskeyBook();
	const seen = new Set<string>();
	const passkeys: StoredPasskey[] = [];
	for (const p of list as Partial<StoredPasskey>[]) {
		if (!p || typeof p.id !== "string" || typeof p.publicKey !== "string" || typeof p.email !== "string") continue;
		if (!p.id || !p.publicKey || !p.email || seen.has(p.id)) continue;
		seen.add(p.id);
		passkeys.push({
			id: p.id,
			publicKey: p.publicKey,
			counter: typeof p.counter === "number" && p.counter >= 0 ? p.counter : 0,
			...(Array.isArray(p.transports) ? { transports: p.transports.filter((t): t is string => typeof t === "string") } : {}),
			email: p.email.trim().toLowerCase(),
			name: cleanPasskeyName(p.name),
			created: typeof p.created === "string" ? p.created : new Date(0).toISOString(),
			...(typeof p.lastUsed === "string" ? { lastUsed: p.lastUsed } : {}),
		});
	}
	return { passkeys };
}

export function cleanPasskeyName(name: unknown): string {
	const n = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, MAX_PASSKEY_NAME) : "";
	return n || "Passkey";
}

/** A name for a new passkey from the browser it was made in, which the person can change. */
export function guessDeviceName(userAgent: string): string {
	const ua = userAgent || "";
	const device = /iPhone/.test(ua) ? "iPhone"
		: /iPad/.test(ua) ? "iPad"
		: /Android/.test(ua) ? "Android phone"
		: /Macintosh|Mac OS X/.test(ua) ? "Mac"
		: /Windows/.test(ua) ? "Windows PC"
		: /CrOS/.test(ua) ? "Chromebook"
		: /Linux/.test(ua) ? "Linux computer"
		: "";
	const browser = /Edg\//.test(ua) ? "Edge"
		: /Firefox\//.test(ua) ? "Firefox"
		: /Chrome\//.test(ua) ? "Chrome"
		: /Safari\//.test(ua) ? "Safari"
		: "";
	if (device && browser) return `${device} (${browser})`;
	return device || browser || "Passkey";
}

export function passkeysOf(book: PasskeyBook, email: string): StoredPasskey[] {
	const e = email.trim().toLowerCase();
	return book.passkeys.filter((p) => p.email === e);
}

export function toView(p: StoredPasskey): PasskeyView {
	const { publicKey: _k, counter: _c, email: _e, ...view } = p;
	return view;
}

/** Why someone can't add another passkey, or null if they can. */
export function addPasskeyProblem(book: PasskeyBook, email: string, id: string): string | null {
	if (book.passkeys.some((p) => p.id === id)) return "That passkey is already added.";
	if (passkeysOf(book, email).length >= MAX_PASSKEYS_PER_PERSON) return `You can have up to ${MAX_PASSKEYS_PER_PERSON} passkeys. Remove one you no longer use first.`;
	return null;
}

/** Where Cloudflare Access sends people back to after signing in: the only place we'll send a code. */
export function accessCallbackUrl(teamDomain: string): string | null {
	try {
		return `${new URL(teamDomain).origin}/cdn-cgi/access/callback`;
	} catch {
		return null;
	}
}

export interface AuthorizeRequest {
	clientId: string;
	redirectUri: string;
	state: string;
	nonce: string;
	codeChallenge: string;
}

/**
 * Checks the sign-in request Cloudflare Access sends people to /passkey/authorize with. Only Access
 * (our client id, its own callback address) may use it, so a code can never be sent anywhere else.
 */
export function readAuthorizeRequest(params: URLSearchParams, teamDomain: string): AuthorizeRequest | { error: string } {
	const clientId = params.get("client_id") ?? "";
	const redirectUri = params.get("redirect_uri") ?? "";
	const callback = accessCallbackUrl(teamDomain);
	if (!callback) return { error: "Passkey sign-in isn't set up on this Mail App yet." };
	if (clientId !== PASSKEY_CLIENT_ID || redirectUri !== callback) return { error: "This sign-in link isn't one Mail App recognises." };
	if ((params.get("response_type") ?? "") !== "code") return { error: "This sign-in link isn't one Mail App recognises." };
	const method = params.get("code_challenge_method");
	const codeChallenge = params.get("code_challenge") ?? "";
	if (codeChallenge && method !== "S256") return { error: "This sign-in link isn't one Mail App recognises." };
	return {
		clientId,
		redirectUri,
		state: (params.get("state") ?? "").slice(0, 2048),
		nonce: (params.get("nonce") ?? "").slice(0, 512),
		codeChallenge: codeChallenge.slice(0, 128),
	};
}

/** The address Access is sent back to with a code. */
export function callbackWithCode(redirectUri: string, code: string, state: string): string {
	const url = new URL(redirectUri);
	url.searchParams.set("code", code);
	if (state) url.searchParams.set("state", state);
	return url.toString();
}

/** Who is asking for a token: the client id and secret, from a Basic header or the form. */
export function clientCredentials(authorization: string | null, form: URLSearchParams): { id: string; secret: string } | null {
	if (authorization?.startsWith("Basic ")) {
		try {
			const decoded = atob(authorization.slice(6).trim());
			const at = decoded.indexOf(":");
			if (at < 0) return null;
			return { id: decodeURIComponent(decoded.slice(0, at)), secret: decodeURIComponent(decoded.slice(at + 1)) };
		} catch {
			return null;
		}
	}
	const id = form.get("client_id");
	const secret = form.get("client_secret");
	return id && secret ? { id, secret } : null;
}

/** Compares two secrets in time that doesn't depend on where they differ. */
export function sameSecret(a: string, b: string): boolean {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	let diff = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0 && a.length > 0;
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = "";
	for (const x of b) s += String.fromCharCode(x);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE: the code_challenge Access sent at the start must be the SHA-256 of the verifier it sends now. */
export async function verifierMatches(verifier: string, challenge: string): Promise<boolean> {
	if (!challenge) return true;
	if (!verifier) return false;
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return sameSecret(base64url(hash), challenge);
}
