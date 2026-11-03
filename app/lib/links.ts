// Mail App addition (not part of upstream Agentic Inbox).
// Turning files too big to attach into download links: encrypt in the browser, upload, and write the
// box of links that goes into the email.
import { formatSize } from "shared/attachments";
import { formatExpiry, linkUrl, sealFile } from "shared/links";
import { escapeHtml } from "~/lib/utils";
import copy from "~/copy/compose.en-GB.json";
import { fill } from "~/lib/attachments";

export interface SharedLink {
	filename: string;
	size: number;
	url: string;
	expires: string;
}

/** Encrypts one file and uploads it. The key never leaves this browser except inside the link itself. */
export async function uploadLink(mailboxId: string, file: { bytes: Uint8Array<ArrayBuffer>; filename: string; type: string }, password?: string): Promise<SharedLink> {
	const { ciphertext, seal, key } = await sealFile(file.bytes, password || undefined);
	const meta = { filename: file.filename, type: file.type, size: file.bytes.byteLength, ...seal };
	const res = await fetch(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/links`, {
		method: "POST",
		headers: { "content-type": "application/octet-stream", "x-mail-app-link": encodeURIComponent(JSON.stringify(meta)) },
		body: ciphertext,
	});
	const body = (await res.json().catch(() => ({}))) as { token?: string; expires?: string; error?: string };
	if (!res.ok || !body.token || !body.expires) throw new Error(body.error || fill(copy.linkUploadFailed, { name: file.filename }));
	return { filename: file.filename, size: file.bytes.byteLength, url: linkUrl(window.location.origin, body.token, key), expires: body.expires };
}

/** The box listing the links, added to the end of the email. */
export function linksBlock(links: SharedLink[], withPassword: boolean): string {
	if (links.length === 0) return "";
	const until = formatExpiry(new Date(links[0].expires));
	const items = links
		.map((l) => `<li style="margin:4px 0"><a href="${escapeHtml(l.url)}">${escapeHtml(l.filename)}</a> <span style="color:#667">(${formatSize(l.size)})</span></li>`)
		.join("");
	const note = withPassword ? `${fill(copy.linksBoxUntil, { date: until })} ${copy.linksBoxPassword}` : fill(copy.linksBoxUntil, { date: until });
	return `<div style="border:1px solid #d9e0e1;border-radius:8px;padding:12px 16px;margin:16px 0"><p style="margin:0 0 6px;font-weight:600">${escapeHtml(links.length === 1 ? copy.linksBoxTitleOne : copy.linksBoxTitle)}</p><ul style="margin:0;padding-left:20px">${items}</ul><p style="margin:8px 0 0;color:#556;font-size:13px">${escapeHtml(note)}</p></div>`;
}
