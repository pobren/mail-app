// Mail App addition (not part of upstream Agentic Inbox).
// Files' API. The files are kept in R2 at files/<mailbox>/<id>; their names and folders are in the mailbox's
// own database (workers/durableObject/files.ts). requireMailbox has already checked the person can open
// the mailbox, so everyone who can open it shares its files.
// Small files go up in one request; big ones in parts of PART_BYTES (R2 multipart uploads), as Cloudflare
// refuses requests over 100 MB.

import { Hono, type Context } from "hono";
import {
	EMAIL_ATTACHMENTS_FOLDER, MAX_FILE_BYTES, PART_BYTES, cleanFileName, cleanType, partCount, previewKind, servedType,
} from "../../shared/files";
import type { RemovedFile } from "../durableObject/files";
import type { MailboxContext } from "../lib/mailbox";
import type { Env } from "../types";

export const files = new Hono<MailboxContext>();

const base = "/api/v1/mailboxes/:mailboxId/files";
const mailboxOf = (c: Context<MailboxContext>) => decodeURIComponent(c.req.param("mailboxId") ?? "").toLowerCase();
const keyOf = (mailbox: string, id: string) => `files/${mailbox}/${id}`;
const viewerOf = (c: Context<MailboxContext>) => ({ email: c.var.person?.email ?? "", name: c.var.person?.name ?? "" });
const ID = /^[0-9a-f-]{36}$/;
const folderParam = (v: unknown): string | null => (typeof v === "string" && ID.test(v) ? v : null);
const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && ID.test(x)).slice(0, 1000) : []);
const GONE_FOLDER = "That folder isn't there any more. It may have been moved to the Bin.";

/** Deletes what's been removed for good from R2: finished files, and the parts of unfinished uploads. */
async function forget(env: Env, mailbox: string, removed: RemovedFile[]): Promise<void> {
	if (!removed.length) return;
	for (let i = 0; i < removed.length; i += 1000) {
		await env.BUCKET.delete(removed.slice(i, i + 1000).map((r) => keyOf(mailbox, r.id)));
	}
	await Promise.all(removed.filter((r) => r.uploadId).map((r) => env.BUCKET.resumeMultipartUpload(keyOf(mailbox, r.id), r.uploadId!).abort().catch(() => {})));
}

/** Deletes every file a mailbox has, when the mailbox itself is deleted. */
export async function deleteMailboxFiles(env: Env, mailbox: string): Promise<void> {
	const prefix = `files/${mailbox.toLowerCase()}/`;
	let cursor: string | undefined;
	do {
		const page = await env.BUCKET.list({ prefix, cursor });
		if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

files.get(base, async (c) => {
	const stub = c.var.mailboxStub;
	// Housekeeping first: the Bin's old items and uploads that never finished.
	await forget(c.env, mailboxOf(c), await stub.tidyFiles());
	const listing = await stub.listFiles(folderParam(c.req.query("folder")));
	if (!listing) return c.json({ error: GONE_FOLDER }, 404);
	return c.json({ ...listing, usage: await stub.fileUsage() });
});

files.get(`${base}/bin`, async (c) => c.json({ items: await c.var.mailboxStub.fileBin(), usage: await c.var.mailboxStub.fileUsage() }));

files.get(`${base}/search`, async (c) => c.json(await c.var.mailboxStub.searchFiles((c.req.query("q") ?? "").slice(0, 200))));

files.post(`${base}/folders`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { parentId?: unknown; name?: unknown };
	const name = cleanFileName(body.name);
	if (!name) return c.json({ error: "Please give the folder a name." }, 400);
	const made = await c.var.mailboxStub.createFileFolder(folderParam(body.parentId), name, viewerOf(c));
	if (made === "missing") return c.json({ error: GONE_FOLDER }, 404);
	return c.json(made, 201);
});

/** The header the app sends with an upload: the file's name, type, size and folder. */
function uploadHeader(c: Context<MailboxContext>): { name: string; type: string; size: number; parentId: string | null } | null {
	try {
		const raw = JSON.parse(decodeURIComponent(c.req.header("x-mail-app-file") ?? "")) as { name?: unknown; type?: unknown; size?: unknown; parentId?: unknown };
		const name = cleanFileName(raw.name);
		const size = Number(raw.size);
		if (!name || !Number.isSafeInteger(size) || size < 0) return null;
		return { name, size, type: cleanType(raw.type, name), parentId: folderParam(raw.parentId) };
	} catch {
		return null;
	}
}

// A file small enough for one request, streamed straight into R2.
files.post(`${base}/upload`, async (c) => {
	const meta = uploadHeader(c);
	const length = Number(c.req.header("content-length"));
	if (!meta || !c.req.raw.body || length !== meta.size) return c.json({ error: "This file couldn't be uploaded. Please try again." }, 400);
	if (meta.size > PART_BYTES) return c.json({ error: "This file is too big to upload in one go." }, 413);
	const stub = c.var.mailboxStub;
	const id = crypto.randomUUID();
	const key = keyOf(mailboxOf(c), id);
	await c.env.BUCKET.put(key, c.req.raw.body, { httpMetadata: { contentType: meta.type } });
	const item = await stub.addFile({ id, parentId: meta.parentId, name: meta.name, size: meta.size, type: meta.type, uploadId: null }, viewerOf(c));
	if (item === "missing") {
		await c.env.BUCKET.delete(key);
		return c.json({ error: GONE_FOLDER }, 404);
	}
	return c.json(item, 201);
});

// A big file: start an upload in parts.
files.post(`${base}/uploads`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; type?: unknown; size?: unknown; parentId?: unknown };
	const name = cleanFileName(body.name);
	const size = Number(body.size);
	if (!name || !Number.isSafeInteger(size) || size <= 0) return c.json({ error: "This file couldn't be uploaded. Please try again." }, 400);
	if (size > MAX_FILE_BYTES) return c.json({ error: "Files can be up to 5 GB each." }, 413);
	const type = cleanType(body.type, name);
	const id = crypto.randomUUID();
	const upload = await c.env.BUCKET.createMultipartUpload(keyOf(mailboxOf(c), id), { httpMetadata: { contentType: type } });
	const item = await c.var.mailboxStub.addFile({ id, parentId: folderParam(body.parentId), name, size, type, uploadId: upload.uploadId }, viewerOf(c));
	if (item === "missing") {
		await upload.abort().catch(() => {});
		return c.json({ error: GONE_FOLDER }, 404);
	}
	return c.json({ id, partBytes: PART_BYTES, parts: partCount(size) }, 201);
});

files.put(`${base}/uploads/:id/parts/:n`, async (c) => {
	const id = c.req.param("id");
	const n = Number(c.req.param("n"));
	const pending = ID.test(id) ? await c.var.mailboxStub.pendingFileUpload(id) : null;
	if (!pending) return c.json({ error: "This upload has stopped. Please try again." }, 404);
	const count = partCount(pending.size);
	if (!Number.isInteger(n) || n < 1 || n > count) return c.json({ error: "This file couldn't be uploaded. Please try again." }, 400);
	// R2 wants every part but the last to be the same size.
	const expected = n < count ? PART_BYTES : pending.size - (count - 1) * PART_BYTES;
	if (Number(c.req.header("content-length")) !== expected || !c.req.raw.body) return c.json({ error: "This file couldn't be uploaded. Please try again." }, 400);
	const part = await c.env.BUCKET.resumeMultipartUpload(keyOf(mailboxOf(c), id), pending.uploadId).uploadPart(n, c.req.raw.body);
	return c.json({ partNumber: part.partNumber, etag: part.etag });
});

files.post(`${base}/uploads/:id/complete`, async (c) => {
	const id = c.req.param("id");
	const stub = c.var.mailboxStub;
	const pending = ID.test(id) ? await stub.pendingFileUpload(id) : null;
	if (!pending) return c.json({ error: "This upload has stopped. Please try again." }, 404);
	const body = (await c.req.json().catch(() => ({}))) as { parts?: unknown };
	const parts = (Array.isArray(body.parts) ? body.parts : [])
		.filter((p): p is { partNumber: number; etag: string } => !!p && Number.isInteger(p.partNumber) && typeof p.etag === "string")
		.map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
		.sort((a, b) => a.partNumber - b.partNumber);
	if (parts.length !== partCount(pending.size)) return c.json({ error: "Some of this file didn't arrive. Please try again." }, 400);
	const key = keyOf(mailboxOf(c), id);
	try {
		await c.env.BUCKET.resumeMultipartUpload(key, pending.uploadId).complete(parts);
	} catch {
		await forget(c.env, mailboxOf(c), [(await stub.dropFileUpload(id))!].filter(Boolean));
		return c.json({ error: "This file couldn't be put together. Please try again." }, 400);
	}
	const head = await c.env.BUCKET.head(key);
	if (head?.size !== pending.size) {
		await stub.dropFileUpload(id);
		await c.env.BUCKET.delete(key);
		return c.json({ error: "Some of this file didn't arrive. Please try again." }, 400);
	}
	return c.json(await stub.finishFileUpload(id), 201);
});

files.delete(`${base}/uploads/:id`, async (c) => {
	const id = c.req.param("id");
	const dropped = ID.test(id) ? await c.var.mailboxStub.dropFileUpload(id) : null;
	if (dropped) await forget(c.env, mailboxOf(c), [dropped]);
	return c.body(null, 204);
});

// A file's contents: shown in the app when it can be (pictures, PDFs, video, music, text), otherwise saved.
// Range requests are answered so videos can be skipped through.
files.get(`${base}/:id/content`, async (c) => {
	const id = c.req.param("id");
	const item = ID.test(id) ? await c.var.mailboxStub.getFile(id) : null;
	if (!item || item.kind !== "file") return c.json({ error: "Not found" }, 404);
	const key = keyOf(mailboxOf(c), id);
	const range = c.req.header("range");
	const obj = await c.env.BUCKET.get(key, range ? { range: c.req.raw.headers } : {});
	if (!obj) return c.json({ error: "Not found" }, 404);
	const type = servedType(item.type, item.name);
	const inline = c.req.query("download") !== "1" && type !== "application/octet-stream";
	const safeName = item.name.replace(/[\u0000-\u001f"\\]/g, "_");
	const headers = new Headers({
		"content-type": type,
		"content-disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(item.name)}`,
		"x-content-type-options": "nosniff",
		"accept-ranges": "bytes",
		"cache-control": "private, max-age=86400",
		etag: obj.httpEtag,
	});
	// Nothing a person uploads gets to run in the app. Chrome won't show PDFs with this set, and PDFs can't reach the app anyway.
	if (previewKind(item.type, item.name) !== "pdf") headers.set("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
	const r = obj.range as { offset?: number; length?: number } | undefined;
	if (range && r && "body" in obj) {
		const offset = r.offset ?? 0;
		const length = r.length ?? obj.size - offset;
		headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
		headers.set("content-length", String(length));
		return new Response(obj.body, { status: 206, headers });
	}
	headers.set("content-length", String(obj.size));
	return new Response("body" in obj ? obj.body : null, { headers });
});

files.patch(`${base}/:id`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
	const name = cleanFileName(body.name);
	if (!name) return c.json({ error: "Please give it a name." }, 400);
	const id = c.req.param("id");
	const item = ID.test(id) ? await c.var.mailboxStub.renameFile(id, name) : null;
	return item ? c.json(item) : c.json({ error: "Not found" }, 404);
});

files.post(`${base}/move`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; parentId?: unknown };
	const result = await c.var.mailboxStub.moveFiles(idList(body.ids), folderParam(body.parentId));
	if (result === "missing") return c.json({ error: GONE_FOLDER }, 404);
	if (result === "into-itself") return c.json({ error: "A folder can't go inside itself." }, 400);
	return c.json(result);
});

files.post(`${base}/bin`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
	return c.json({ binned: await c.var.mailboxStub.binFiles(idList(body.ids)) });
});

files.post(`${base}/restore`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
	return c.json({ restored: await c.var.mailboxStub.restoreFiles(idList(body.ids)) });
});

files.post(`${base}/delete`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
	const removed = await c.var.mailboxStub.deleteFilesForever(idList(body.ids));
	await forget(c.env, mailboxOf(c), removed);
	return c.json({ deleted: removed.length });
});

files.post(`${base}/empty-bin`, async (c) => {
	const removed = await c.var.mailboxStub.emptyFileBin();
	await forget(c.env, mailboxOf(c), removed);
	return c.json({ deleted: removed.length });
});

// Saves an email's attachment into the "Email attachments" folder.
files.post(`${base}/from-email`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { emailId?: unknown; attachmentId?: unknown };
	const emailId = typeof body.emailId === "string" ? body.emailId : "";
	const attachmentId = typeof body.attachmentId === "string" ? body.attachmentId : "";
	const stub = c.var.mailboxStub;
	const att = attachmentId ? await stub.getAttachment(attachmentId) : null;
	if (!att || att.email_id !== emailId) return c.json({ error: "Not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${att.filename}`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	const name = cleanFileName(att.filename) || "Attachment";
	const type = cleanType(att.mimetype, name);
	const folder = await stub.topFileFolder(EMAIL_ATTACHMENTS_FOLDER, viewerOf(c));
	const id = crypto.randomUUID();
	// Attachments are at most 25 MB, so reading one into memory is fine.
	const bytes = await obj.arrayBuffer();
	await c.env.BUCKET.put(keyOf(mailboxOf(c), id), bytes, { httpMetadata: { contentType: type } });
	const item = await stub.addFile({ id, parentId: folder.id, name, size: bytes.byteLength, type, uploadId: null }, viewerOf(c));
	return c.json({ item, folder }, 201);
});
