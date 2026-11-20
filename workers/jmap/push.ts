// Mail App 2.8: JMAP push subscriptions (RFC 8620 section 7.2), so a mail app on a phone can show new mail the moment
// it arrives instead of checking every so often. The app gives an https address and its own encryption keys. Mail App
// posts a code there to prove the address is the app's, the app sends the code back, and from then on each new
// email (never spam) posts a short, encrypted "something changed" notice. The notice says nothing about the email;
// the app asks Mail App for that itself, with its own key.
//
// Subscriptions belong to the API key that made them. Deleting the key, or taking a mailbox off it, stops them.

import { loadApiBook } from "../lib/api";
import { listMailboxes } from "../lib/email-helpers";
import { keyMailboxes } from "../../shared/api";
import { postEncrypted } from "../lib/push";
import { toJmapId } from "../../shared/jmap";
import type { Env } from "../types";
import { MAX_LIFE_MS, MAX_PER_KEY, PUSH_TYPES, clampExpires, pushKeysProblem, pushUrlProblem, typesProblem, wantsDelivery } from "../../shared/jmap-push";

export { MAX_LIFE_MS, MAX_PER_KEY, PUSH_TYPES, clampExpires, pushKeysProblem, pushUrlProblem, typesProblem, wantsDelivery };

export interface JmapPushSub {
	id: string;
	/** The API key that made it. */
	keyId: string;
	deviceClientId: string;
	url: string;
	keys: { p256dh: string; auth: string } | null;
	verificationCode: string;
	verified: boolean;
	/** ISO date; Mail App stops posting after it. */
	expires: string;
	/** Data types the app wants to hear about, or null for all. */
	types: string[] | null;
	created: string;
}

export const PUSH_FILE = "jmap/push-subscriptions.json";

export async function loadPushSubs(bucket: R2Bucket): Promise<JmapPushSub[]> {
	const obj = await bucket.get(PUSH_FILE);
	if (!obj) return [];
	try { return await obj.json<JmapPushSub[]>(); } catch { return []; }
}

/** Changes the file and saves it, trying again if two requests change it at once. */
export async function updatePushSubs<T>(bucket: R2Bucket, change: (list: JmapPushSub[]) => T): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		const obj = await bucket.get(PUSH_FILE);
		let list: JmapPushSub[] = [];
		if (obj) { try { list = await obj.json<JmapPushSub[]>(); } catch { list = []; } }
		const out = change(list);
		const now = Date.now();
		const kept = list.filter((s) => Date.parse(s.expires) > now);
		const put = await bucket.put(PUSH_FILE, JSON.stringify(kept), obj ? { onlyIf: { etagMatches: obj.etag } } : { onlyIf: { etagDoesNotMatch: "*" } });
		if (put || attempt >= 4) return out;
	}
}

/** The notice for new mail in one mailbox, only naming the types the app asked for. */
export function stateChange(mailbox: string, types: string[] | null, state: string) {
	const changed: Record<string, string> = {};
	for (const t of ["Email", "EmailDelivery", "Mailbox", "Thread"]) if (types == null || types.includes(t)) changed[t] = state;
	return { "@type": "StateChange", changed: { [toJmapId(mailbox)]: changed } };
}

export function newCode(): string {
	const b = crypto.getRandomValues(new Uint8Array(16));
	return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Posts the code that proves the address belongs to the app. */
export async function sendVerification(env: Env, sub: JmapPushSub, contact: string): Promise<void> {
	const res = await postEncrypted(env, sub.url, sub.keys, { "@type": "PushVerification", pushSubscriptionId: sub.id, verificationCode: sub.verificationCode }, contact);
	if (res === "gone") await updatePushSubs(env.BUCKET, (list) => { const i = list.findIndex((s) => s.id === sub.id); if (i >= 0) list.splice(i, 1); });
}

/** New mail arrived in a mailbox: tell every app that subscribed for it. Never called for spam. */
export async function notifyJmapApps(env: Env, mailbox: string): Promise<number> {
	const now = Date.now();
	const subs = (await loadPushSubs(env.BUCKET)).filter((s) => s.verified && Date.parse(s.expires) > now && wantsDelivery(s));
	if (subs.length === 0) return 0;
	// Only keys that still exist and still reach this mailbox.
	const book = await loadApiBook(env.BUCKET);
	let all: string[] | null = null;
	const reaches = async (keyId: string) => {
		const key = book.keys.find((k) => k.id === keyId);
		if (!key) return false;
		if (key.allMailboxes) {
			all ??= (await listMailboxes(env.BUCKET)).map((m) => m.email.toLowerCase());
			return keyMailboxes(key, all).map((m) => m.toLowerCase()).includes(mailbox.toLowerCase());
		}
		return key.mailboxes.map((m) => m.toLowerCase()).includes(mailbox.toLowerCase());
	};
	const state = now.toString(36);
	const gone: string[] = [];
	let sent = 0;
	await Promise.all(subs.map(async (s) => {
		if (!(await reaches(s.keyId))) return;
		const r = await postEncrypted(env, s.url, s.keys, stateChange(mailbox, s.types, state), mailbox).catch((e) => {
			console.error("JMAP push failed:", (e as Error).message);
			return "failed" as const;
		});
		if (r === "gone") gone.push(s.id);
		else if (r === "sent") sent++;
	}));
	if (gone.length) await updatePushSubs(env.BUCKET, (list) => { for (const id of gone) { const i = list.findIndex((s) => s.id === id); if (i >= 0) list.splice(i, 1); } });
	return sent;
}
