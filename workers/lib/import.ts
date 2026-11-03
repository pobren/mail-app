// Mail App, 2026: restoring a backup, or bringing mail across from Gmail, Apple Mail or Thunderbird.
// The browser reads the .mbox file and sends its messages here a batch at a time; each one is parsed,
// its attachments are stored, and it's added to the right folder with its labels and read/starred
// state. Mail that's already in the mailbox (same Message-ID) is skipped, so a restore can be run
// again safely, for example after a lost connection.

import PostalMime from "postal-mime";
import { Folders } from "../../shared/folders";
import { LABEL_COLOR_KEYS, MAX_LABEL_NAME } from "../../shared/labels";
import { placement, type Placement } from "../../shared/mbox-import";
import { cleanSenderName } from "../../shared/contacts";
import type { Env } from "../types";

type Stub = DurableObjectStub<import("../durableObject").MailboxDO>;
type ImportItem = Parameters<import("../durableObject").MailboxDO["importEmails"]>[0][number];

export interface ImportResult {
	added: number;
	skipped: number;
	failed: number;
}

const SYSTEM_IDS: Record<string, string> = {
	inbox: Folders.INBOX, sent: Folders.SENT, draft: Folders.DRAFT, archive: Folders.ARCHIVE, spam: Folders.SPAM, trash: Folders.TRASH,
};

const msgId = (s: string | undefined | null) => {
	if (!s) return null;
	const m = s.match(/<([^>]+)>/);
	return (m ? m[1] : s.trim().split(/\s+/)[0]) || null;
};

function slugify(text: string) {
	return text.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]+/g, "").replace(/--+/g, "-").replace(/^-+|-+$/g, "");
}

/** Finds each folder by name, making the ones that don't exist yet. */
async function folderIds(stub: Stub, names: string[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (names.length === 0) return out;
	const existing = await stub.getFolders();
	for (const name of names) {
		const found = existing.find((f) => f.name.toLowerCase() === name.toLowerCase());
		if (found) { out.set(name, found.id); continue; }
		const base = slugify(name) || "imported";
		for (let n = 1; n < 50; n++) {
			const id = n === 1 ? base : `${base}-${n}`;
			if (existing.some((f) => f.id === id)) continue;
			const made = await stub.createFolder(id, name);
			if (made) { out.set(name, made.id); existing.push({ id: made.id, name, unreadCount: 0 }); break; }
		}
	}
	return out;
}

/** Finds each label by name, making the ones that don't exist yet (while there's room). */
async function labelIds(stub: Stub, names: string[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (names.length === 0) return out;
	const existing = await stub.getLabels();
	let colour = existing.length;
	for (const raw of names) {
		const name = raw.slice(0, MAX_LABEL_NAME);
		const found = existing.find((l) => l.name.toLowerCase() === name.toLowerCase());
		if (found) { out.set(raw, found.id); continue; }
		const made = await stub.createLabel(name, LABEL_COLOR_KEYS[colour++ % LABEL_COLOR_KEYS.length]);
		if (typeof made === "object") { out.set(raw, made.id); existing.push(made); }
	}
	return out;
}

export async function importMessages(env: Env, stub: Stub, mailboxId: string, raws: Uint8Array[], fallback: Placement["folder"]): Promise<ImportResult> {
	const result: ImportResult = { added: 0, skipped: 0, failed: 0 };
	const parsed: { email: Awaited<ReturnType<PostalMime["parse"]>>; place: Placement; messageId: string | null }[] = [];
	for (const raw of raws) {
		try {
			const email = await new PostalMime().parse(raw);
			parsed.push({ email, place: placement(email.headers, fallback), messageId: msgId(email.messageId) });
		} catch {
			result.failed += 1;
		}
	}

	// Skip what's already here, and repeats within this batch.
	const known = new Set(await stub.knownMessageIds(parsed.map((p) => p.messageId).filter((x): x is string => !!x)));
	const fresh = parsed.filter((p) => {
		if (!p.messageId) return true;
		if (known.has(p.messageId)) { result.skipped += 1; return false; }
		known.add(p.messageId);
		return true;
	});
	if (fresh.length === 0) return result;

	const folders = await folderIds(stub, [...new Set(fresh.flatMap((p) => ("name" in p.place.folder ? [p.place.folder.name] : [])))]);
	const labels = await labelIds(stub, [...new Set(fresh.flatMap((p) => p.place.labels))]);

	const items: ImportItem[] = [];
	for (const { email, place, messageId } of fresh) {
		const id = crypto.randomUUID();
		const attachments: ImportItem["attachments"] = [];
		for (const att of email.attachments ?? []) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(`attachments/${id}/${attId}/${filename}`, att.content);
			attachments.push({
				id: attId, email_id: id, filename, mimetype: att.mimeType || "application/octet-stream",
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment",
			});
		}
		const inReplyTo = msgId(email.inReplyTo);
		const references = (email.references ?? "").split(/\s+/).map(msgId).filter((x): x is string => !!x);
		const to = (email.to ?? []).map((a) => a.address?.toLowerCase()).filter(Boolean) as string[];
		const cc = (email.cc ?? []).map((a) => a.address?.toLowerCase()).filter(Boolean) as string[];
		const bcc = (email.bcc ?? []).map((a) => a.address?.toLowerCase()).filter(Boolean) as string[];
		const date = email.date && !Number.isNaN(new Date(email.date).getTime()) ? new Date(email.date).toISOString() : new Date().toISOString();
		const folderId = "system" in place.folder ? SYSTEM_IDS[place.folder.system] : (folders.get(place.folder.name) ?? Folders.ARCHIVE);
		items.push({
			folderId,
			labelIds: place.labels.map((l) => labels.get(l)).filter((x): x is string => !!x),
			attachments,
			email: {
				id,
				subject: email.subject || "",
				sender: (email.from?.address || "").toLowerCase(),
				sender_name: cleanSenderName(email.from?.name || "") || null,
				recipient: (to.length ? to : [mailboxId]).join(", "),
				cc: cc.join(", ") || null,
				bcc: bcc.join(", ") || null,
				date,
				body: email.html || email.text || "",
				read: place.read,
				starred: place.starred,
				in_reply_to: inReplyTo,
				email_references: references.length ? JSON.stringify(references) : null,
				thread_id: references[0] || inReplyTo || messageId || id,
				message_id: messageId,
				raw_headers: JSON.stringify(email.headers),
			},
		});
	}
	const added = await stub.importEmails(items);
	result.added += added.length;
	result.skipped += items.length - added.length;
	return result;
}
