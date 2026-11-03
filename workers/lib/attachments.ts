// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: emails too big for Cloudflare to send are refused with a clear message.

/**
 * Shared attachment storage logic.
 * Eliminates the triplicated atob → Uint8Array → R2.put pattern.
 */
import type { Env } from "../types";
import { base64DecodedSize, isTooLarge } from "shared/attachments";
import copy from "../../app/copy/compose.en-GB.json";

/**
 * Mail App: Cloudflare refuses messages over 5 MiB, and sending happens after the reply has gone back,
 * so a too-big email would vanish quietly. Check first and return the words to show, or null if it fits.
 */
export function messageTooLarge(
	attachments: { content: string }[] | undefined,
	html?: string,
	text?: string,
): string | null {
	if (!attachments?.length) return null;
	return isTooLarge(attachments.map((att) => base64DecodedSize(att.content)), html, text) ? copy.tooBigServer : null;
}

export interface StoredAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string;
}

/**
 * Store base64-encoded attachments to R2 and return metadata for the DO.
 */
export async function storeAttachments(
	bucket: Env["BUCKET"],
	emailId: string,
	attachments?: {
		content: string;
		filename: string;
		type: string;
		disposition: string;
		contentId?: string;
	}[],
): Promise<StoredAttachment[]> {
	if (!attachments?.length) return [];

	const results: StoredAttachment[] = [];
	for (const att of attachments) {
		const attachmentId = crypto.randomUUID();
		// Sanitize filename to prevent path traversal in R2 keys
		const safeFilename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
		const key = `attachments/${emailId}/${attachmentId}/${safeFilename}`;
		const binaryStr = atob(att.content);
		const bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
		await bucket.put(key, bytes);
		results.push({
			id: attachmentId,
			email_id: emailId,
			filename: safeFilename,
			mimetype: att.type,
			size: bytes.byteLength,
			content_id: att.contentId || null,
			disposition: att.disposition,
		});
	}
	return results;
}
