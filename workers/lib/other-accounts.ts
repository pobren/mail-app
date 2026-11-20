// Mail App addition (not part of upstream Agentic Inbox).
// Other accounts (shared/other-accounts.ts): the install's list in R2, the passwords (encrypted with
// AES-GCM before they're stored), checking that an account signs in, and sending as one through its
// provider's SMTP server. Checking for new mail runs in workers/durableObject/other-accounts.ts.

import { buildMessage } from "../../shared/mbox";
import {
	cleanFile, OTHER_ACCOUNTS_KEY, sendAsAddresses,
	type OtherAccount, type OtherAccountsFile, type ServerSettings,
} from "../../shared/other-accounts";
import type { SendEmailParams } from "../email-sender";
import type { Env } from "../types";
import { base64ToBytes } from "../email-sender";
import { openImap, type Imap } from "./mail-protocols/imap";
import { openPop3 } from "./mail-protocols/pop3";
import { openSmtp } from "./mail-protocols/smtp";

export type StoredAccount = OtherAccountsFile["accounts"][number];

/** Each other account's Durable Object (one per mailbox) checks its accounts for new mail. */
export interface OtherAccountsStub {
	refresh(mailbox: string, wake?: boolean): Promise<void>;
	checkNow(mailbox: string, accountId: string): Promise<void>;
	statuses(ids: string[]): Promise<Record<string, import("../../shared/other-accounts").AccountStatus>>;
	forget(accountId: string): Promise<void>;
	start(mailbox: string, accountId: string, catchUp: boolean): Promise<void>;
}

export function accountsStub(env: Env, mailbox: string): OtherAccountsStub {
	const ns = env.OTHER_ACCOUNTS;
	return ns.get(ns.idFromName(mailbox.toLowerCase())) as unknown as OtherAccountsStub;
}

// ── The list ───────────────────────────────────────────────────────

/** `strict`: a failed read throws rather than looking like an empty list (so nothing is forgotten by mistake). */
export async function loadOtherAccounts(bucket: R2Bucket, strict = false): Promise<OtherAccountsFile> {
	try {
		const obj = await bucket.get(OTHER_ACCOUNTS_KEY);
		return cleanFile(obj ? await obj.json() : null);
	} catch (e) {
		if (strict) throw e;
		return cleanFile(null);
	}
}

export async function saveOtherAccounts(bucket: R2Bucket, file: OtherAccountsFile): Promise<void> {
	await bucket.put(OTHER_ACCOUNTS_KEY, JSON.stringify(cleanFile(file)), { httpMetadata: { contentType: "application/json" } });
}

/** The other-account addresses a mailbox can send as. */
export async function otherSendable(bucket: R2Bucket, mailbox: string): Promise<string[]> {
	return sendAsAddresses(await loadOtherAccounts(bucket), mailbox);
}

// ── Passwords ──────────────────────────────────────────────────────

const KEY_FILE = "setup/other-accounts.key";
const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * The key passwords are encrypted with. An OTHER_ACCOUNTS_KEY secret on the Worker, if the owner has set
 * one; otherwise a random key made the first time, kept in R2 apart from the accounts list. Either way it
 * never leaves the owner's own Cloudflare account.
 */
async function passwordKey(env: Env, kind: "s" | "r"): Promise<CryptoKey> {
	let raw: Uint8Array<ArrayBuffer>;
	if (kind === "s") {
		const secret = (env as { OTHER_ACCOUNTS_KEY?: string }).OTHER_ACCOUNTS_KEY;
		if (!secret) throw new Error("The OTHER_ACCOUNTS_KEY secret has gone, so saved passwords can't be read. Add the accounts again.");
		raw = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(secret)));
	} else {
		const obj = await env.BUCKET.get(KEY_FILE);
		if (obj) raw = new Uint8Array(await obj.arrayBuffer());
		else {
			raw = crypto.getRandomValues(new Uint8Array(32));
			// Only written if nobody else made one at the same moment.
			await env.BUCKET.put(KEY_FILE, raw, { onlyIf: { etagDoesNotMatch: "*" } }).catch(() => null);
			const again = await env.BUCKET.get(KEY_FILE);
			if (again) raw = new Uint8Array(await again.arrayBuffer());
		}
	}
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const toB64 = (b: Uint8Array) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };

export async function sealPassword(env: Env, password: string): Promise<string> {
	const kind = (env as { OTHER_ACCOUNTS_KEY?: string }).OTHER_ACCOUNTS_KEY ? "s" : "r";
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await passwordKey(env, kind), enc.encode(password)));
	const both = new Uint8Array(iv.length + sealed.length);
	both.set(iv);
	both.set(sealed, iv.length);
	return `v1${kind}:${toB64(both)}`;
}

export async function openPassword(env: Env, secret: string): Promise<string> {
	const m = /^v1([sr]):(.+)$/.exec(secret);
	if (!m) throw new Error("A saved password couldn't be read. Add the account again.");
	const both = base64ToBytes(m[2]) as Uint8Array<ArrayBuffer>;
	try {
		const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: both.subarray(0, 12) }, await passwordKey(env, m[1] as "s" | "r"), both.subarray(12));
		return dec.decode(plain);
	} catch {
		throw new Error("The saved password couldn't be unlocked. Please add the account again.");
	}
}

// ── Connecting ─────────────────────────────────────────────────────

/** Locally, against a test server on this computer, connections can be unencrypted. Never in production. */
export function serverFor(s: ServerSettings, dev: boolean) {
	return { host: s.host, port: s.port, security: dev && s.host === "localhost" ? ("none" as const) : s.security };
}

/**
 * Signs in to the incoming server (and the outgoing one, if there is one) to check the details work,
 * without fetching or sending anything. Returns a sentence saying what's wrong, or null.
 */
export async function tryAccount(account: Omit<OtherAccount, "id" | "mailbox" | "added">, password: string, dev: boolean, helloName: string): Promise<string | null> {
	try {
		if (account.protocol === "imap") {
			const imap = await openImap(serverFor(account.incoming, dev), account.username, password);
			try { await imap.examine("INBOX"); } finally { await imap.logout(); }
		} else {
			const pop = await openPop3(serverFor(account.incoming, dev), account.username, password);
			await pop.quit();
		}
	} catch (e) {
		return `Bringing mail in didn't work. ${(e as Error).message}`;
	}
	if (account.outgoing) {
		try {
			const smtp = await openSmtp(serverFor(account.outgoing, dev), account.username, password, helloName);
			await smtp.quit();
		} catch (e) {
			return `Signing in to send didn't work. ${(e as Error).message}`;
		}
	}
	return null;
}

// ── Sending ────────────────────────────────────────────────────────

/** The account (with an SMTP server) that sends as this address, if any. */
export async function sendingAccount(env: Env, from: string): Promise<StoredAccount | null> {
	const file = await loadOtherAccounts(env.BUCKET);
	if (file.off) return null;
	const f = from.toLowerCase();
	return file.accounts.find((a) => a.address === f && a.outgoing) ?? null;
}

const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
const bare = (v: string) => (v.match(/<([^>]+)>/)?.[1] ?? v).trim().toLowerCase();

/** The whole email, as the provider's server will get it. Bcc is left out of the headers, as it should be. */
export function outgoingMessage(params: SendEmailParams & { messageId?: string }, now = new Date()): Uint8Array {
	const from = typeof params.from === "string" ? params.from : params.from.name ? `"${params.from.name.replace(/["\\]/g, "")}" <${params.from.email}>` : params.from.email;
	const fromEmail = (typeof params.from === "string" ? bare(params.from) : params.from.email).toLowerCase();
	const replyTo = params.replyTo ? (typeof params.replyTo === "string" ? params.replyTo : `"${params.replyTo.name.replace(/["\\]/g, "")}" <${params.replyTo.email}>`) : null;
	const id = (params.messageId || `${crypto.randomUUID()}@${fromEmail.split("@")[1] || "mail-app.local"}`).replace(/^<|>$/g, "");
	const headers: { key: string; value: string }[] = [
		{ key: "from", value: from },
		{ key: "to", value: list(params.to).join(", ") },
		...(list(params.cc).length ? [{ key: "cc", value: list(params.cc).join(", ") }] : []),
		...(replyTo ? [{ key: "reply-to", value: replyTo }] : []),
		{ key: "subject", value: params.subject || "" },
		{ key: "date", value: now.toUTCString().replace(/GMT$/, "+0000") },
		{ key: "message-id", value: `<${id}>` },
		...Object.entries(params.headers ?? {}).map(([key, value]) => ({ key: key.toLowerCase(), value })),
	];
	const text = buildMessage(
		{ id, subject: params.subject, sender: fromEmail, body: params.html || params.text || "", raw_headers: JSON.stringify(headers) },
		(params.attachments ?? []).map((a) => ({ filename: a.filename, mimetype: a.type, disposition: a.disposition, content_id: a.contentId ?? null, bytes: base64ToBytes(a.content) })),
	);
	return enc.encode(text.endsWith("\r\n") ? text : `${text}\r\n`);
}

/** Everyone the email goes to, Bcc included, each once. */
export function envelopeRecipients(params: SendEmailParams): string[] {
	return [...new Set([...list(params.to), ...list(params.cc), ...list(params.bcc)].map(bare))];
}

/**
 * Sends through the account's own SMTP server. Then, for providers that don't keep a copy of what's sent
 * through SMTP (Gmail does), adds one to the account's Sent folder over IMAP, so it's there in its own
 * apps too. That part never fails the send.
 */
export async function sendThroughAccount(env: Env, account: StoredAccount, params: SendEmailParams & { messageId?: string }, dev: boolean, waitUntil?: (p: Promise<unknown>) => void): Promise<{ messageId: string }> {
	if (!account.outgoing) throw new Error("This account is set up to bring mail in only, so it can't send.");
	const password = await openPassword(env, account.secret);
	const message = outgoingMessage(params);
	const smtp = await openSmtp(serverFor(account.outgoing, dev), account.username, password, account.address.split("@")[1] || "localhost");
	try {
		await smtp.sendMail(account.address, envelopeRecipients(params), message);
	} finally {
		await smtp.quit();
	}
	if (account.protocol === "imap" && account.provider !== "gmail") {
		const copy = copyToSent(account, password, message, dev).catch((e) => console.log("Sent copy not kept at the other account:", (e as Error).message));
		if (waitUntil) waitUntil(copy); else await copy;
	}
	return { messageId: params.messageId ?? "" };
}

async function copyToSent(account: StoredAccount, password: string, message: Uint8Array, dev: boolean): Promise<void> {
	const imap: Imap = await openImap(serverFor(account.incoming, dev), account.username, password);
	try {
		const folders = await imap.list();
		const sent = folders.find((f) => f.flags.some((x) => x.toLowerCase() === "\\sent"))
			?? folders.find((f) => /^(inbox[./])?(sent|sent items|sent messages|sent mail)$/i.test(f.name));
		if (!sent) return;
		await imap.append(sent.name, message, ["\\Seen"], new Date());
	} finally {
		await imap.logout();
	}
}
