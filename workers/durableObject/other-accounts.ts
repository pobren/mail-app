// Mail App addition (not part of upstream Agentic Inbox).
// Other accounts, checking for new mail (shared/other-accounts.ts). One of these per mailbox, apart from
// the mailbox itself, so a slow mail server never holds the mailbox up. Its alarm checks each account
// every 5 minutes (hourly once it keeps failing), and "Check now" runs one straight away.
//
// IMAP: the Inbox is opened read-only and anything with a UID above the last one seen is fetched with
// BODY.PEEK[], so nothing at the other end is marked as read, moved or deleted. POP3: each message's
// UIDL is remembered and only new ones are fetched; nothing is deleted there either. New mail goes
// through the same steps as mail that arrives the normal way (spam checks, rules, notifications).
// Bringing in the last 30 days (IMAP only) files it quietly: no notifications for old mail.

import { DurableObject } from "cloudflare:workers";
import {
	CATCH_UP_DAYS, FETCH_BATCH, MAX_FETCH_BYTES, nextCheckAt, searchDate,
	type AccountStatus,
} from "../../shared/other-accounts";
import { importMessages } from "../lib/import";
import { openImap } from "../lib/mail-protocols/imap";
import { openPop3 } from "../lib/mail-protocols/pop3";
import { loadOtherAccounts, openPassword, serverFor, type StoredAccount } from "../lib/other-accounts";
import type { Env } from "../types";

interface AccountState {
	mailbox: string;
	/** When the next check is due (ms). */
	due: number;
	/** IMAP: the Inbox's UIDVALIDITY and the highest UID already brought in. */
	uidValidity?: number;
	lastUid?: number;
	/** IMAP: older messages still to bring in (catching up on the last 30 days). */
	backlog?: number[];
	/** Asked to catch up, not started yet. */
	catchUp?: boolean;
	/** POP3: set once the messages already there have been noted (and skipped). */
	popReady?: boolean;
	/** POP3: the last UIDL in the list last time, to find where new mail starts. */
	popLast?: string;
	status: AccountStatus;
}

const MAX_UID = 4294967295;
const SOON_MS = 60_000;
/** One check (sign in, fetch up to FETCH_BATCH, sign out) gives up after this. */
const CHECK_LIMIT_MS = 4 * 60_000;

export class OtherAccountsDO extends DurableObject<Env> {
	private running = new Set<string>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, state TEXT NOT NULL)");
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pop_seen (account TEXT NOT NULL, uidl TEXT NOT NULL, PRIMARY KEY (account, uidl))");
		});
	}

	private get dev(): boolean {
		return !!import.meta.env?.DEV;
	}

	private state(id: string): AccountState | null {
		const row = this.ctx.storage.sql.exec<{ state: string }>("SELECT state FROM accounts WHERE id = ?", id).toArray()[0];
		return row ? (JSON.parse(row.state) as AccountState) : null;
	}

	private save(id: string, s: AccountState): void {
		this.ctx.storage.sql.exec("INSERT INTO accounts (id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state", id, JSON.stringify(s));
	}

	private async book(): Promise<void> {
		const rows = this.ctx.storage.sql.exec<{ state: string }>("SELECT state FROM accounts").toArray();
		if (!rows.length) { await this.ctx.storage.deleteAlarm(); return; }
		const next = Math.min(...rows.map((r) => (JSON.parse(r.state) as AccountState).due));
		await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
	}

	/** A newly added account: first check straight away. */
	async start(mailbox: string, accountId: string, catchUp: boolean): Promise<void> {
		this.save(accountId, { mailbox: mailbox.toLowerCase(), due: Date.now(), catchUp, status: { failures: 0, fetched: 0, tooBig: 0, ...(catchUp ? { catchingUp: true } : {}) } });
		await this.book();
	}

	async forget(accountId: string): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM accounts WHERE id = ?", accountId);
		this.ctx.storage.sql.exec("DELETE FROM pop_seen WHERE account = ?", accountId);
		await this.book();
	}

	async statuses(ids: string[]): Promise<Record<string, AccountStatus>> {
		const out: Record<string, AccountStatus> = {};
		for (const id of ids) {
			const s = this.state(id);
			if (s) out[id] = { ...s.status, nextAt: s.due, ...(s.backlog?.length || s.catchUp ? { catchingUp: true } : {}) };
		}
		return out;
	}

	/** Makes sure an alarm is booked (after an update, say). `wake`: check everything now (switched back on). */
	async refresh(_mailbox: string, wake = false): Promise<void> {
		if (wake) {
			for (const row of this.ctx.storage.sql.exec<{ id: string; state: string }>("SELECT id, state FROM accounts").toArray()) {
				const s = JSON.parse(row.state) as AccountState;
				s.due = Date.now();
				this.save(row.id, s);
			}
		}
		if (wake || (await this.ctx.storage.getAlarm()) === null) await this.book();
	}

	/** "Check now": checks one account and returns when it's done. */
	async checkNow(_mailbox: string, accountId: string): Promise<void> {
		const account = (await loadOtherAccounts(this.env.BUCKET)).accounts.find((a) => a.id === accountId);
		if (!account) return;
		await this.check(account);
		await this.book();
	}

	async alarm(): Promise<void> {
		let file;
		try {
			file = await loadOtherAccounts(this.env.BUCKET, true);
		} catch {
			// R2 didn't answer: try again in a few minutes rather than forget anything.
			await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
			return;
		}
		const rows = this.ctx.storage.sql.exec<{ id: string; state: string }>("SELECT id, state FROM accounts").toArray();
		const now = Date.now();
		for (const row of rows) {
			const account = file.accounts.find((a) => a.id === row.id);
			// Removed from the list (or the whole install switched it off): stop checking it.
			if (!account) { this.ctx.storage.sql.exec("DELETE FROM accounts WHERE id = ?", row.id); this.ctx.storage.sql.exec("DELETE FROM pop_seen WHERE account = ?", row.id); continue; }
			if (file.off) { const s = JSON.parse(row.state) as AccountState; s.due = now + 60 * 60_000; this.save(row.id, s); continue; }
			if ((JSON.parse(row.state) as AccountState).due <= now + 1000) await this.check(account);
		}
		await this.book();
	}

	/** One check of one account. Never throws: what went wrong goes in its status. */
	private async check(account: StoredAccount): Promise<void> {
		if (this.running.has(account.id)) return;
		const s = this.state(account.id);
		if (!s) return;
		this.running.add(account.id);
		const started = Date.now();
		let more = false;
		try {
			const password = await openPassword(this.env, account.secret);
			const work = account.protocol === "imap" ? this.checkImap(account, s, password) : this.checkPop3(account, s, password);
			let timer: ReturnType<typeof setTimeout> | null = null;
			more = await Promise.race([work, new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error("The check took too long, so it stopped. It will carry on next time.")), CHECK_LIMIT_MS); })])
				.finally(() => { if (timer !== null) clearTimeout(timer); });
			s.status.failures = 0;
			delete s.status.error;
			s.status.okAt = new Date().toISOString();
		} catch (e) {
			s.status.failures += 1;
			s.status.error = (e as Error).message || "The check didn't work.";
			console.log(`Other account ${account.address}: ${s.status.error}`);
		} finally {
			this.running.delete(account.id);
		}
		s.status.checkedAt = new Date().toISOString();
		s.due = more && !s.status.error ? Date.now() + SOON_MS : nextCheckAt(started, s.status.failures);
		if (!s.backlog?.length && !s.catchUp) delete s.status.catchingUp;
		this.save(account.id, s);
	}

	/** Returns true when there's more waiting (it comes in a minute later). */
	private async checkImap(account: StoredAccount, s: AccountState, password: string): Promise<boolean> {
		const imap = await openImap(serverFor(account.incoming, this.dev), account.username, password);
		try {
			const box = await imap.examine("INBOX");
			let top = box.uidNext ? box.uidNext - 1 : 0;
			if (!box.uidNext && box.exists) {
				const all = await imap.uids(1, MAX_UID);
				top = all[all.length - 1] ?? 0;
			}
			if (s.uidValidity !== box.uidValidity || s.lastUid === undefined) {
				const first = s.uidValidity === undefined;
				s.uidValidity = box.uidValidity;
				// Only mail from now on. On a first check, the last 30 days too if asked for.
				s.lastUid = top;
				if (first && s.catchUp) {
					const since = new Date(Date.now() - CATCH_UP_DAYS * 86_400_000);
					s.backlog = (await imap.since(searchDate(since))).filter((u) => u <= top);
				}
				delete s.catchUp;
				this.save(account.id, s);
			}
			const fresh = top > (s.lastUid ?? 0) ? await imap.uids((s.lastUid ?? 0) + 1, MAX_UID) : [];
			// New mail first, then the backlog, newest first.
			const backlog = [...(s.backlog ?? [])].reverse();
			const batch = [...fresh.map((uid) => ({ uid, old: false })), ...backlog.map((uid) => ({ uid, old: true }))].slice(0, FETCH_BATCH);
			if (batch.length) {
				const info = new Map((await imap.fetch(batch.map((b) => b.uid).join(","), "(UID RFC822.SIZE FLAGS)")).map((m) => [m.uid, m]));
				for (const item of batch) {
					const meta = info.get(item.uid);
					if (meta && (meta.size ?? 0) <= MAX_FETCH_BYTES) {
						const [msg] = await imap.fetch(String(item.uid), "(UID FLAGS BODY.PEEK[])", MAX_FETCH_BYTES + 100_000);
						if (msg?.body?.length) {
							await this.deliver(account, msg.body, item.old ? { read: msg.flags.some((f) => f.toLowerCase() === "\\seen") } : null);
							s.status.fetched += 1;
						}
					} else if (meta) {
						s.status.tooBig += 1;
					}
					if (item.old) s.backlog = (s.backlog ?? []).filter((u) => u !== item.uid);
					else s.lastUid = Math.max(s.lastUid ?? 0, item.uid);
					this.save(account.id, s);
				}
			}
			const remaining = fresh.length + backlog.length - batch.length;
			return remaining > 0;
		} finally {
			await imap.logout();
		}
	}

	private async checkPop3(account: StoredAccount, s: AccountState, password: string): Promise<boolean> {
		const pop = await openPop3(serverFor(account.incoming, this.dev), account.username, password);
		try {
			const list = await pop.list();
			const sql = this.ctx.storage.sql;
			if (!s.popReady) {
				// The first time, what's already there is noted and left: only new mail comes in.
				for (const m of list) sql.exec("INSERT OR IGNORE INTO pop_seen (account, uidl) VALUES (?, ?)", account.id, m.uidl);
				s.popReady = true;
				s.popLast = list[list.length - 1]?.uidl;
				delete s.catchUp;
				this.save(account.id, s);
				return false;
			}
			const from = s.popLast ? list.findIndex((m) => m.uidl === s.popLast) + 1 : 0;
			const candidates = list.slice(from);
			const seen = new Set<string>();
			for (let i = 0; i < candidates.length; i += 90) {
				const part = candidates.slice(i, i + 90).map((m) => m.uidl);
				for (const r of sql.exec<{ uidl: string }>(`SELECT uidl FROM pop_seen WHERE account = ? AND uidl IN (${part.map(() => "?").join(",")})`, account.id, ...part)) seen.add(r.uidl);
			}
			const fresh = candidates.filter((m) => !seen.has(m.uidl));
			const batch = fresh.slice(0, FETCH_BATCH);
			for (const m of batch) {
				if (m.size <= MAX_FETCH_BYTES) {
					const raw = await pop.retr(m.n, MAX_FETCH_BYTES + 100_000);
					await this.deliver(account, raw, null);
					s.status.fetched += 1;
				} else {
					s.status.tooBig += 1;
				}
				sql.exec("INSERT OR IGNORE INTO pop_seen (account, uidl) VALUES (?, ?)", account.id, m.uidl);
				this.save(account.id, s);
			}
			if (fresh.length <= FETCH_BATCH) s.popLast = list[list.length - 1]?.uidl;
			return fresh.length > batch.length;
		} finally {
			await pop.quit();
		}
	}

	/**
	 * New mail goes through the normal incoming steps. Old mail (catching up) is filed quietly in the
	 * Inbox with its read state, with no notifications. Either way, mail that's already in the mailbox
	 * (the same Message-ID) is skipped.
	 */
	private async deliver(account: StoredAccount, raw: Uint8Array, old: { read: boolean } | null): Promise<void> {
		const ctx = { waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
		if (old) {
			const stub = this.env.MAILBOX.get(this.env.MAILBOX.idFromName(account.mailbox));
			const extra = [
				"X-Mail-App-Folder: Inbox",
				...(account.label ? [`X-Mail-App-Labels: ${account.label.replace(/[\r\n,]/g, " ")}`] : []),
				`Status: ${old.read ? "RO" : "O"}`,
				`X-Mail-App-Delivered-To: ${account.address}`,
				"",
			].join("\r\n");
			const head = new TextEncoder().encode(extra);
			const whole = new Uint8Array(head.length + raw.length);
			whole.set(head);
			whole.set(raw, head.length);
			await importMessages(this.env, stub as never, account.mailbox, [whole], { system: "inbox" });
			return;
		}
		const { receiveEmail } = await import("../index");
		await receiveEmail({
			raw: new Response(raw as Uint8Array<ArrayBuffer>).body!, rawSize: raw.length,
			fetched: { mailbox: account.mailbox, address: account.address, label: account.label },
		}, this.env, ctx);
	}
}
