// Mail App, 2026: new-mail notifications for Mail App on your Dock or home screen, using the browser's
// own push service (Apple's for Safari, Google's for Chrome, Mozilla's for Firefox). Each device that
// switches notifications on gives us a subscription; when mail arrives we send each one a short,
// end-to-end encrypted message (RFC 8291 and RFC 8292), so the push service can't read it.
// The keys that identify this install to the push services are made on first use and kept in R2.

import type { Env } from "../types";

export interface PushSubscriptionRecord {
	endpoint: string;
	p256dh: string;
	auth: string;
	created: string;
	/** A name for the device, such as "Safari on Mac", so Settings can list them. */
	device: string;
}

export interface PushMessage {
	title: string;
	body: string;
	url: string;
	unread?: number;
}

const MAX_DEVICES = 20;
const VAPID_KEY = "push/vapid.json";
const subsKey = (mailboxId: string) => `push/subscriptions/${mailboxId}.json`;

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = "";
	for (const x of b) s += String.fromCharCode(x);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Bytes {
	const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
	return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Bytes {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}

// ── This install's identity (VAPID keys) ──────────────────────────

interface Vapid { publicKey: string; privateJwk: JsonWebKey }

async function vapid(env: Env): Promise<Vapid> {
	const stored = await env.BUCKET.get(VAPID_KEY);
	if (stored) return stored.json<Vapid>();
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const made: Vapid = {
		publicKey: b64url((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer),
		privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey,
	};
	// Only the first one written counts, so two requests at once can't end up with different keys.
	await env.BUCKET.put(VAPID_KEY, JSON.stringify(made), { onlyIf: { etagDoesNotMatch: "*" } });
	return (await env.BUCKET.get(VAPID_KEY))!.json<Vapid>();
}

export async function publicKey(env: Env): Promise<string> {
	return (await vapid(env)).publicKey;
}

async function vapidHeader(env: Env, endpoint: string, contact: string): Promise<string> {
	const keys = await vapid(env);
	const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = b64url(enc.encode(JSON.stringify({
		aud: new URL(endpoint).origin,
		exp: Math.floor(Date.now() / 1000) + 12 * 3600,
		sub: `mailto:${contact}`,
	})));
	// WebCrypto's ECDSA signature is already the raw r||s form that JWT wants.
	const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
	return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`;
}

// ── Encrypting a message for one device (RFC 8291, aes128gcm) ──────

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export async function encryptForDevice(sub: { p256dh: string; auth: string }, payload: Uint8Array): Promise<Bytes> {
	const deviceKey = fromB64url(sub.p256dh);
	const authSecret = fromB64url(sub.auth);
	const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
	const localPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
	const device = await crypto.subtle.importKey("raw", deviceKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: device }, local.privateKey, 256));

	const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), deviceKey, localPublic), 32);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

	const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	// One record: the message, then the 0x02 "last record" marker.
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
	const header = new Uint8Array(21);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, 4096);
	header[20] = localPublic.length;
	return concat(header, localPublic, sealed);
}

// ── Devices ────────────────────────────────────────────────────────

export async function listDevices(env: Env, mailboxId: string): Promise<PushSubscriptionRecord[]> {
	const obj = await env.BUCKET.get(subsKey(mailboxId));
	return obj ? obj.json<PushSubscriptionRecord[]>() : [];
}

async function saveDevices(env: Env, mailboxId: string, list: PushSubscriptionRecord[]) {
	if (list.length === 0) await env.BUCKET.delete(subsKey(mailboxId));
	else await env.BUCKET.put(subsKey(mailboxId), JSON.stringify(list));
}

export async function addDevice(env: Env, mailboxId: string, sub: Omit<PushSubscriptionRecord, "created">) {
	const list = (await listDevices(env, mailboxId)).filter((s) => s.endpoint !== sub.endpoint);
	list.unshift({ ...sub, created: new Date().toISOString() });
	await saveDevices(env, mailboxId, list.slice(0, MAX_DEVICES));
}

export async function removeDevice(env: Env, mailboxId: string, endpoint: string) {
	const list = await listDevices(env, mailboxId);
	await saveDevices(env, mailboxId, list.filter((s) => s.endpoint !== endpoint));
}

// ── Sending ────────────────────────────────────────────────────────

/** Sends to one device. Returns false when the device has gone (unsubscribed or uninstalled). */
async function sendOne(env: Env, mailboxId: string, sub: PushSubscriptionRecord, message: PushMessage): Promise<boolean> {
	const body = await encryptForDevice(sub, enc.encode(JSON.stringify(message)));
	const res = await fetch(sub.endpoint, {
		method: "POST",
		headers: {
			Authorization: await vapidHeader(env, sub.endpoint, mailboxId),
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
			TTL: String(24 * 3600),
			Urgency: "high",
		},
		body,
	});
	if (res.status === 404 || res.status === 410) return false;
	if (!res.ok) console.error(`Push to ${new URL(sub.endpoint).host} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
	return true;
}

/** Sends a message to every device that has notifications on for this mailbox, and forgets ones that have gone. */
export async function notifyDevices(env: Env, mailboxId: string, message: PushMessage): Promise<number> {
	const list = await listDevices(env, mailboxId);
	if (list.length === 0) return 0;
	const results = await Promise.all(list.map((s) => sendOne(env, mailboxId, s, message).catch((e) => {
		console.error("Push failed:", (e as Error).message);
		return true;
	})));
	const gone = list.filter((_, i) => !results[i]);
	for (const s of gone) await removeDevice(env, mailboxId, s.endpoint);
	return list.length - gone.length;
}
