// Mail App addition (not part of upstream Agentic Inbox).
// Admin > Backups: how every mailbox's backups stand, on one page, and "Back up now" for one mailbox
// or all of them. Admins only. Starting a backup doesn't show anyone's mail; downloading or restoring
// one still needs the mailbox open (the mailbox routes in workers/index.ts check that).

import { Hono } from "hono";
import { canOpen } from "../../shared/people";
import { listMailboxes } from "../lib/email-helpers";
import { requireAdmin } from "../lib/people";
import type { MailboxContext } from "../lib/mailbox";

export const adminBackups = new Hono<MailboxContext>();

const stubFor = (env: Env, mailbox: string) => env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));

adminBackups.get("/api/v1/admin/backups", requireAdmin, async (c) => {
	const mailboxes = await listMailboxes(c.env.BUCKET);
	const rows = await Promise.all(mailboxes.map(async ({ id }) => {
		const stub = stubFor(c.env, id);
		try {
			// Books the nightly backup of a mailbox nobody has opened since it was made.
			await stub.rememberMailbox(id);
			const { backups, settings } = await stub.listBackups();
			const latest = backups.find((b) => b.status === "done") ?? null;
			const running = backups.find((b) => b.status === "running") ?? null;
			const failed = backups[0]?.status === "failed" ? backups[0] : null;
			return { mailbox: id, canOpen: canOpen(c.var.person, id), latest, running, failed, count: backups.filter((b) => b.status === "done").length, settings };
		} catch (e) {
			return { mailbox: id, canOpen: canOpen(c.var.person, id), latest: null, running: null, failed: null, count: 0, settings: null, error: e instanceof Error ? e.message : String(e) };
		}
	}));
	rows.sort((a, b) => a.mailbox.localeCompare(b.mailbox));
	return c.json({ mailboxes: rows });
});

// Back up every mailbox now (one already running carries on).
adminBackups.post("/api/v1/admin/backups", requireAdmin, async (c) => {
	const mailboxes = await listMailboxes(c.env.BUCKET);
	const started = await Promise.allSettled(mailboxes.map(({ id }) => stubFor(c.env, id).startBackup()));
	return c.json({ started: started.filter((s) => s.status === "fulfilled").length, of: mailboxes.length }, 202);
});

adminBackups.post("/api/v1/admin/backups/:mailbox", requireAdmin, async (c) => {
	const mailbox = decodeURIComponent(c.req.param("mailbox")).toLowerCase();
	const known = (await listMailboxes(c.env.BUCKET)).some((m) => m.id.toLowerCase() === mailbox);
	if (!known) return c.json({ error: "Not found" }, 404);
	return c.json(await stubFor(c.env, mailbox).startBackup(), 202);
});
