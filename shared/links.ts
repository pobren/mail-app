// Mail App addition (not part of upstream Agentic Inbox).
// Download links for files too big to attach. Each file is encrypted in the sender's browser before it is
// uploaded, so the person's own Cloudflare storage only ever holds scrambled data.
//
// - Without a password, the key is random and travels in the link after the "#", which browsers never send
//   to a server. Only someone with the full link can open the file.
// - With a password, the key comes from the password (PBKDF2), and the link carries no key at all.
//
// Two keys come out of that secret (HKDF): one encrypts the file (AES-GCM), the other proves to the server
// that the visitor knows the secret. The server stores only a hash of the second, refuses to hand over the
// encrypted file without it, and locks the link after repeated wrong passwords, so a password can't be
// guessed offline from the stored data. The download page (workers/lib/link-page.ts) repeats deriveKeys in
// plain JavaScript; the two must stay the same.

export const LINK_DAYS = 30;
/** Cloudflare refuses uploads over 100 MB on most plans; this leaves room for the encryption overhead. */
export const MAX_LINK_BYTES = 95 * 1024 * 1024;
export const PBKDF2_ITERATIONS = 600_000;
export const MAX_WRONG_PASSWORDS = 5;
export const LOCK_MINUTES = 15;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();

export function toB64url(bytes: Bytes): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Bytes {
	const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
	return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export function randomBytes(n: number): Bytes {
	return crypto.getRandomValues(new Uint8Array(n));
}

/** A link's id: 128 random bits, 22 characters. */
export function newToken(): string {
	return toB64url(randomBytes(16));
}

export async function sha256(bytes: Bytes): Promise<Bytes> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** The secret behind a password: PBKDF2-SHA-256. */
export async function passwordSecret(password: string, salt: Bytes, iterations = PBKDF2_ITERATIONS): Promise<Bytes> {
	const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256));
}

/** The file key and the proof-of-knowledge value, both from one secret. */
export async function deriveKeys(secret: Bytes, salt: Bytes): Promise<{ fileKey: CryptoKey; auth: Bytes }> {
	const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits", "deriveKey"]);
	const fileKey = await crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("mail-app link file") },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
	const auth = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("mail-app link auth") }, base, 256));
	return { fileKey, auth };
}

/** What the server keeps about a link besides the encrypted file. Nothing here can open the file. */
export interface LinkSeal {
	iv: string;
	salt: string;
	iterations: number;
	protected: boolean;
	authHash: string;
}

/** Encrypts a file for a download link. `key` is what goes after the "#" (empty with a password). */
export async function sealFile(bytes: Bytes, password?: string): Promise<{ ciphertext: Bytes; seal: LinkSeal; key: string }> {
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const usePassword = !!password;
	const random = usePassword ? null : randomBytes(32);
	const secret = usePassword ? await passwordSecret(password!, salt) : random!;
	const { fileKey, auth } = await deriveKeys(secret, salt);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, fileKey, bytes));
	return {
		ciphertext,
		seal: {
			iv: toB64url(iv),
			salt: toB64url(salt),
			iterations: usePassword ? PBKDF2_ITERATIONS : 0,
			protected: usePassword,
			authHash: toB64url(await sha256(auth)),
		},
		key: random ? toB64url(random) : "",
	};
}

/** The reverse of sealFile, for tests and the download page's logic. */
export async function openFile(ciphertext: Bytes, seal: Pick<LinkSeal, "iv" | "salt" | "iterations">, secretOrPassword: { key: string } | { password: string }): Promise<Bytes> {
	const salt = fromB64url(seal.salt);
	const secret = "key" in secretOrPassword ? fromB64url(secretOrPassword.key) : await passwordSecret(secretOrPassword.password, salt, seal.iterations);
	const { fileKey } = await deriveKeys(secret, salt);
	return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(seal.iv) }, fileKey, ciphertext));
}

export function linkUrl(origin: string, token: string, key: string): string {
	return `${origin.replace(/\/+$/, "")}/f/${token}${key ? `#${key}` : ""}`;
}

export function expiryFrom(now: Date, days = LINK_DAYS): Date {
	return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/** "9 November 2026" */
export function formatExpiry(date: Date): string {
	return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** Constant-time comparison of two equal-length strings. */
export function sameText(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
