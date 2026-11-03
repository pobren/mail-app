import { test } from "node:test";
import assert from "node:assert/strict";
import { b64url, encryptForDevice, fromB64url } from "../workers/lib/push.ts";

const enc = new TextEncoder();
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

// Decrypts the way a browser does (RFC 8291), to prove what we send can be read by the device.
test("a device can decrypt what we send", async () => {
	const device = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
	const devicePublic = new Uint8Array((await crypto.subtle.exportKey("raw", device.publicKey)) as ArrayBuffer);
	const auth = crypto.getRandomValues(new Uint8Array(16));
	const message = JSON.stringify({ title: "Hannah Clarke", body: "September invoice £84", url: "/" });

	const body = await encryptForDevice({ p256dh: b64url(devicePublic), auth: b64url(auth) }, enc.encode(message));

	const salt = body.slice(0, 16);
	assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16), 4096);
	const idlen = body[20];
	const senderPublic = body.slice(21, 21 + idlen);
	const sealed = body.slice(21 + idlen);
	const sender = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, device.privateKey, 256));
	const ikm = await hkdf(auth, shared, cat(enc.encode("WebPush: info\0"), devicePublic, senderPublic), 32);
	const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
	const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
	const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed));
	assert.equal(plain[plain.length - 1], 2);
	assert.equal(new TextDecoder().decode(plain.slice(0, -1)), message);
});

test("base64url round trip", () => {
	const bytes = crypto.getRandomValues(new Uint8Array(65));
	assert.deepEqual(fromB64url(b64url(bytes)), bytes);
});

// A pretend R2 bucket, enough for the push code.
function memoryBucket() {
	const store = new Map<string, string>();
	return {
		async get(key: string) { const v = store.get(key); return v === undefined ? null : { json: async () => JSON.parse(v) }; },
		async put(key: string, value: string, opts?: { onlyIf?: { etagDoesNotMatch?: string } }) {
			if (opts?.onlyIf?.etagDoesNotMatch === "*" && store.has(key)) return null;
			store.set(key, value);
			return {};
		},
		async delete(key: string) { store.delete(key); },
	};
}

test("sends a signed, encrypted push and forgets devices that have gone", async () => {
	const { addDevice, listDevices, notifyDevices, publicKey } = await import("../workers/lib/push.ts");
	const env = { BUCKET: memoryBucket() } as never;
	const device = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
	const p256dh = b64url(new Uint8Array((await crypto.subtle.exportKey("raw", device.publicKey)) as ArrayBuffer));
	const auth = b64url(crypto.getRandomValues(new Uint8Array(16)));
	await addDevice(env, "me@example.com", { endpoint: "https://web.push.apple.com/abc", p256dh, auth, device: "Safari on Mac" });
	await addDevice(env, "me@example.com", { endpoint: "https://fcm.googleapis.com/gone", p256dh, auth, device: "Old laptop" });

	const seen: { url: string; headers: Record<string, string> }[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		seen.push({ url, headers: init.headers as Record<string, string> });
		return new Response(null, { status: url.endsWith("/gone") ? 410 : 201 });
	}) as typeof fetch;
	try {
		const sent = await notifyDevices(env, "me@example.com", { title: "Hannah", body: "Invoice", url: "/" });
		assert.equal(sent, 1);
	} finally {
		globalThis.fetch = realFetch;
	}
	assert.deepEqual((await listDevices(env, "me@example.com")).map((d) => d.device), ["Safari on Mac"]);

	// The VAPID token is signed by this install's key and addressed to the push service.
	const apple = seen.find((s) => s.url.includes("apple"))!;
	assert.equal(apple.headers["Content-Encoding"], "aes128gcm");
	const m = apple.headers.Authorization.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)!;
	assert.equal(m[4], await publicKey(env));
	const claims = JSON.parse(new TextDecoder().decode(fromB64url(m[2])));
	assert.equal(claims.aud, "https://web.push.apple.com");
	assert.equal(claims.sub, "mailto:me@example.com");
	const key = await crypto.subtle.importKey("raw", fromB64url(m[4]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
	assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64url(m[3]), enc.encode(`${m[1]}.${m[2]}`)));
});
