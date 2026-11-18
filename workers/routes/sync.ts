// Mail App addition (not part of upstream Agentic Inbox).
// What an app needs to keep its own copy of a mailbox in step, such as the Outlook bridge (bridge/ in this
// repository), which lets classic Outlook on Windows use Mail App over IMAP, POP3 and SMTP:
//
//   GET  .../changes?since=N        what changed since change number N (see durableObject/sync.ts)
//   GET  .../index?folder=inbox     every email in a folder, oldest first, with read and starred
//   GET  .../emails/:id/raw         the email as a standard email file (message/rfc822)
//   POST .../append?folder=draft    adds an email file to a folder as it is (IMAP APPEND)
//
// Each is reachable through the API (shared/api.ts) with a key, the same as the rest of the mailbox.

import { Hono } from "hono";
import PostalMime from "postal-mime";
import { buildMessage, type StoredFile } from "../../shared/mbox";
import { cleanSenderName } from "../../shared/contacts";
import { rawKey } from "../durableObject/sync";
import type { MailboxContext } from "../lib/mailbox";

export const sync = new Hono<MailboxContext>();

const base = "/api/v1/mailboxes/:mailboxId";
/** The biggest email file the bridge can add: Workers read the whole request, so keep well inside their limit. */
export const MAX_APPEND_BYTES = 25 * 1024 * 1024;

const intOf = (v: string | undefined, fallback: number) => {
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

sync.get(`${base}/changes`, async (c) => {
	const stub = c.var.mailboxStub;
	const folders = await stub.getFolders();
	const since = c.req.query("since");
	c.executionCtx.waitUntil(stub.sweepRaw().catch(() => 0));
	// No starting point: just the number to start from, so an app can list folders and then ask for changes.
	if (since === undefined || since === "") return c.json({ cursor: await stub.syncCursor(), changes: [], more: false, folders });
	const answer = await stub.syncChanges(intOf(since, 0), intOf(c.req.query("limit"), 1000));
	if (answer === "gone") return c.json({ error: "That change number is too old. Read the folders again from the start (GET .../index) and carry on from the new cursor." }, 410);
	return c.json({ ...answer, folders });
});

sync.get(`${base}/index`, async (c) => {
	const folder = c.req.query("folder");
	if (!folder) return c.json({ error: "Say which folder, for example ?folder=inbox" }, 400);
	const stub = c.var.mailboxStub;
	// The cursor is read first, so nothing that changes while the list is read is missed.
	const cursor = await stub.syncCursor();
	const page = await stub.syncIndex(folder, intOf(c.req.query("offset"), 0), intOf(c.req.query("limit"), 5000));
	return c.json({ ...page, cursor });
});

sync.get(`${base}/emails/:id/raw`, async (c) => {
	const id = c.req.param("id")!;
	// Checked against this mailbox first: the original is kept by email id alone.
	const email = await c.var.mailboxStub.getEmail(id);
	if (!email) return c.json({ error: "Email not found" }, 404);
	const headers = { "Content-Type": "message/rfc822", "Cache-Control": "private, no-store" };
	const kept = await c.env.BUCKET.get(rawKey(id));
	if (kept) return new Response(kept.body, { headers: { ...headers, "Content-Length": String(kept.size), "Mail-App-Original": "yes" } });

	// Mail from before originals were kept (and mail sent from Mail App): rebuilt from what's stored.
	const files: StoredFile[] = [];
	for (const a of email.attachments ?? []) {
		const obj = await c.env.BUCKET.get(`attachments/${id}/${a.id}/${a.filename}`);
		if (!obj) continue;
		files.push({ filename: a.filename, mimetype: a.mimetype, content_id: a.content_id, disposition: a.disposition, bytes: new Uint8Array(await obj.arrayBuffer()) });
	}
	const body = new TextEncoder().encode(buildMessage(email, files));
	return new Response(body, { headers: { ...headers, "Content-Length": String(body.byteLength), "Mail-App-Original": "no" } });
});

sync.post(`${base}/append`, async (c) => {
	const folder = c.req.query("folder");
	if (!folder) return c.json({ error: "Say which folder, for example ?folder=draft" }, 400);
	const raw = new Uint8Array(await c.req.arrayBuffer());
	if (raw.byteLength === 0) return c.json({ error: "Send the email file as the request body." }, 400);
	if (raw.byteLength > MAX_APPEND_BYTES) return c.json({ error: "That email is too big to add (25 MB at most)." }, 413);
	let parsed: Awaited<ReturnType<PostalMime["parse"]>>;
	try { parsed = await new PostalMime().parse(raw); } catch { return c.json({ error: "That isn't an email file Mail App can read." }, 400); }

	const id = crypto.randomUUID();
	const attachments: { id: string; email_id: string; filename: string; mimetype: string; size: number; content_id: string | null; disposition: string }[] = [];
	for (const att of parsed.attachments ?? []) {
		const attId = crypto.randomUUID();
		const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
		await c.env.BUCKET.put(`attachments/${id}/${attId}/${filename}`, att.content);
		attachments.push({
			id: attId, email_id: id, filename, mimetype: att.mimeType || "application/octet-stream",
			size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
			content_id: att.contentId || null, disposition: att.disposition || "attachment",
		});
	}
	await c.env.BUCKET.put(rawKey(id), raw, { httpMetadata: { contentType: "message/rfc822" } });

	const msgId = (s?: string | null) => { if (!s) return null; const m = s.match(/<([^>]+)>/); return (m ? m[1] : s.trim().split(/\s+/)[0]) || null; };
	const list = (a?: { address?: string }[]) => (a ?? []).map((x) => x.address?.toLowerCase()).filter(Boolean) as string[];
	const to = list(parsed.to);
	const messageId = msgId(parsed.messageId);
	const inReplyTo = msgId(parsed.inReplyTo);
	const references = (parsed.references ?? "").split(/\s+/).map(msgId).filter((x): x is string => !!x);
	const date = parsed.date && !Number.isNaN(new Date(parsed.date).getTime()) ? new Date(parsed.date).toISOString() : new Date().toISOString();
	const read = c.req.query("read") !== "0";
	const added = await c.var.mailboxStub.appendEmail(folder, {
		id, subject: parsed.subject || "", sender: (parsed.from?.address || "").toLowerCase(),
		sender_name: cleanSenderName(parsed.from?.name || "") || null,
		recipient: (to.length ? to : [decodeURIComponent(c.req.param("mailboxId")!)]).join(", "),
		cc: list(parsed.cc).join(", ") || null, bcc: list(parsed.bcc).join(", ") || null,
		date, body: parsed.html || parsed.text || "", read, starred: c.req.query("starred") === "1",
		in_reply_to: inReplyTo, email_references: references.length ? JSON.stringify(references) : null,
		thread_id: references[0] || inReplyTo || messageId || id, message_id: messageId, raw_headers: JSON.stringify(parsed.headers),
	}, attachments);
	if (!added) {
		await c.env.BUCKET.delete([rawKey(id), ...attachments.map((a) => `attachments/${id}/${a.id}/${a.filename}`)]);
		return c.json({ error: "Folder not found" }, 404);
	}
	return c.json({ id }, 201);
});
