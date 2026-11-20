// Mail App addition (not part of upstream Agentic Inbox).
// Settings > Other accounts (shared/other-accounts.ts): list, add, change, remove and "Check now" for a
// mailbox's outside accounts, and the admin's switch that turns the feature off for the whole install.
// Passwords come in once, are checked against the provider, then stored encrypted and never sent back.

import { Hono } from "hono";
import {
	MAX_OTHER_ACCOUNTS, cleanLabel, readNewAccount, withoutSecret,
	type NewAccountInput, type OtherAccountView,
} from "../../shared/other-accounts";
import { isAdmin } from "../../shared/people";
import type { MailboxContext } from "../lib/mailbox";
import { accountsStub, loadOtherAccounts, saveOtherAccounts, sealPassword, tryAccount } from "../lib/other-accounts";
import { requireAdmin } from "../lib/people";
import type { Env } from "../types";

export const otherAccounts = new Hono<MailboxContext>();

const base = "/api/v1/mailboxes/:mailboxId/other-accounts";
const mailboxOf = (raw: string | undefined) => decodeURIComponent(raw ?? "").toLowerCase();
const dev = () => !!import.meta.env?.DEV;

async function view(env: Env, mailbox: string): Promise<{ off: boolean; max: number; accounts: OtherAccountView[] }> {
	const file = await loadOtherAccounts(env.BUCKET);
	const mine = file.accounts.filter((a) => a.mailbox === mailbox);
	let statuses: Awaited<ReturnType<ReturnType<typeof accountsStub>["statuses"]>> = {};
	if (mine.length) {
		const stub = accountsStub(env, mailbox);
		statuses = await stub.statuses(mine.map((a) => a.id)).catch(() => ({}));
		// An account with no record yet (the install was restored, say) starts being checked now.
		for (const a of mine) if (!statuses[a.id]) await stub.start(mailbox, a.id, false).catch(() => {});
		await stub.refresh(mailbox).catch(() => {});
	}
	return {
		off: !!file.off,
		max: MAX_OTHER_ACCOUNTS,
		accounts: mine.map((a) => ({ ...withoutSecret(a), status: statuses[a.id] ?? { failures: 0, fetched: 0, tooBig: 0 } })),
	};
}

otherAccounts.get(base, async (c) => c.json(await view(c.env, mailboxOf(c.req.param("mailboxId")))));

otherAccounts.post(base, async (c) => {
	const mailbox = mailboxOf(c.req.param("mailboxId"));
	const body = (await c.req.json().catch(() => ({}))) as NewAccountInput;
	const file = await loadOtherAccounts(c.env.BUCKET);
	if (file.off) return c.json({ error: "Other accounts are switched off on this Mail App. Ask your admin." }, 403);
	if (file.accounts.filter((a) => a.mailbox === mailbox).length >= MAX_OTHER_ACCOUNTS) {
		return c.json({ error: `A mailbox can have up to ${MAX_OTHER_ACCOUNTS} other accounts. Remove one to add another.` }, 400);
	}
	const read = readNewAccount(body, { dev: dev() });
	if ("error" in read) return c.json({ error: read.error }, 400);
	const { account, password } = read;
	if (account.address === mailbox) return c.json({ error: "That's this mailbox's own address." }, 400);
	if (file.accounts.some((a) => a.mailbox === mailbox && a.address === account.address)) return c.json({ error: "That account is already added to this mailbox." }, 400);
	// Another mailbox sending as it would let one person send as someone else's account.
	if (account.outgoing && file.accounts.some((a) => a.address === account.address && a.outgoing)) {
		return c.json({ error: "Another mailbox already sends as that address. Remove it there first." }, 400);
	}
	const problem = await tryAccount(account, password, dev(), new URL(c.req.url).hostname);
	if (problem) return c.json({ error: problem }, 400);

	const id = crypto.randomUUID();
	const fresh = await loadOtherAccounts(c.env.BUCKET);
	fresh.accounts.push({ ...account, id, mailbox, added: new Date().toISOString(), secret: await sealPassword(c.env, password) });
	await saveOtherAccounts(c.env.BUCKET, fresh);
	await accountsStub(c.env, mailbox).start(mailbox, id, account.protocol === "imap" && body.catchUp === true);
	return c.json(await view(c.env, mailbox), 201);
});

/** Change the name, the label, or the password (checked first). */
otherAccounts.patch(`${base}/:id`, async (c) => {
	const mailbox = mailboxOf(c.req.param("mailboxId"));
	const id = c.req.param("id");
	const body = (await c.req.json().catch(() => ({}))) as { name?: string; label?: string; password?: string };
	const file = await loadOtherAccounts(c.env.BUCKET);
	const account = file.accounts.find((a) => a.id === id && a.mailbox === mailbox);
	if (!account) return c.json({ error: "Not found" }, 404);
	if (typeof body.name === "string") {
		const name = body.name.replace(/[\r\n"<>]/g, "").trim().slice(0, 80);
		if (name) account.name = name; else delete account.name;
	}
	if (typeof body.label === "string") account.label = cleanLabel(body.label);
	if (typeof body.password === "string" && body.password) {
		const problem = await tryAccount(account, body.password, dev(), new URL(c.req.url).hostname);
		if (problem) return c.json({ error: problem }, 400);
		account.secret = await sealPassword(c.env, body.password);
	}
	await saveOtherAccounts(c.env.BUCKET, file);
	// A new password: check straight away, rather than waiting for the hourly retry.
	if (body.password) await accountsStub(c.env, mailbox).checkNow(mailbox, id).catch(() => {});
	return c.json(await view(c.env, mailbox));
});

otherAccounts.delete(`${base}/:id`, async (c) => {
	const mailbox = mailboxOf(c.req.param("mailboxId"));
	const id = c.req.param("id");
	const file = await loadOtherAccounts(c.env.BUCKET);
	const kept = file.accounts.filter((a) => !(a.id === id && a.mailbox === mailbox));
	if (kept.length === file.accounts.length) return c.json({ error: "Not found" }, 404);
	await saveOtherAccounts(c.env.BUCKET, { ...file, accounts: kept });
	await accountsStub(c.env, mailbox).forget(id).catch(() => {});
	return c.json(await view(c.env, mailbox));
});

otherAccounts.post(`${base}/:id/check`, async (c) => {
	const mailbox = mailboxOf(c.req.param("mailboxId"));
	const id = c.req.param("id");
	const file = await loadOtherAccounts(c.env.BUCKET);
	if (!file.accounts.some((a) => a.id === id && a.mailbox === mailbox)) return c.json({ error: "Not found" }, 404);
	if (file.off) return c.json({ error: "Other accounts are switched off on this Mail App." }, 403);
	await accountsStub(c.env, mailbox).checkNow(mailbox, id);
	return c.json(await view(c.env, mailbox));
});

// Admin: switch the feature off (or on) for the whole install. Accounts stay listed while it's off.
otherAccounts.get("/api/v1/other-accounts/switch", async (c) => {
	const file = await loadOtherAccounts(c.env.BUCKET);
	return c.json({ off: !!file.off, admin: isAdmin(c.var.person), total: file.accounts.length });
});

otherAccounts.put("/api/v1/other-accounts/switch", requireAdmin, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { off?: boolean };
	const file = await loadOtherAccounts(c.env.BUCKET);
	const off = body.off === true;
	await saveOtherAccounts(c.env.BUCKET, { ...file, off });
	// Back on: every mailbox with accounts starts checking again.
	if (!off) for (const m of new Set(file.accounts.map((a) => a.mailbox))) await accountsStub(c.env, m).refresh(m, true).catch(() => {});
	return c.json({ off, admin: true, total: file.accounts.length });
});

