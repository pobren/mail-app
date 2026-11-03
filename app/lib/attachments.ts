// Mail App addition (not part of upstream Agentic Inbox).
// Attachments in the composer: reading files people pick, drop or paste, and fetching
// a saved draft's or a forwarded email's attachments so they can be sent again.
import type { Attachment } from "~/types";
import { getAttachmentUrl } from "~/lib/utils";
import { extractInlineImages } from "shared/inline-images";

/** What the server's send and draft routes accept. */
export interface OutgoingAttachment {
	content: string; // base64
	filename: string;
	type: string;
	disposition: "attachment" | "inline";
	contentId?: string;
}

export interface ComposeAttachment {
	key: string;
	filename: string;
	type: string;
	size: number;
	status: "loading" | "ready" | "error";
	/** base64, read for files small enough to attach. */
	content?: string;
	/** The picked file itself, kept for files that may go as a download link. */
	file?: File;
}

let counter = 0;
export const newKey = () => `att-${Date.now()}-${counter++}`;

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result || "");
			resolve(url.slice(url.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file"));
		reader.readAsDataURL(blob);
	});
}

/** A pasted screenshot has no useful name, so give it one. */
function fileName(file: File): string {
	if (file.name && file.name !== "image.png") return file.name;
	const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
	return `Screenshot ${new Date().toLocaleString("en-GB").replace(/[/:]/g, "-").replace(",", "")}.${ext}`;
}

export function placeholderFor(file: File): ComposeAttachment {
	return { key: newKey(), filename: fileName(file), type: file.type || "application/octet-stream", size: file.size, status: "loading" };
}

export async function readFile(file: File): Promise<string> {
	return blobToBase64(file);
}

export function placeholderForStored(att: Attachment): ComposeAttachment {
	return { key: newKey(), filename: att.filename, type: att.mimetype || "application/octet-stream", size: att.size, status: "loading" };
}

export async function readStored(mailboxId: string, emailId: string, att: Attachment): Promise<string> {
	const res = await fetch(getAttachmentUrl(mailboxId, emailId, att.id), { headers: { Accept: "*/*" } });
	if (!res.ok) throw new Error(`Couldn't fetch ${att.filename}`);
	return blobToBase64(await res.blob());
}

/** The file's bytes, for encrypting into a download link. */
export async function bytesOf(att: ComposeAttachment): Promise<Uint8Array<ArrayBuffer>> {
	if (att.file) return new Uint8Array(await att.file.arrayBuffer());
	const bin = atob(att.content ?? "");
	return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export function toOutgoing(list: ComposeAttachment[]): OutgoingAttachment[] {
	return list
		.filter((att) => att.status === "ready" && att.content)
		.map((att) => ({ content: att.content as string, filename: att.filename, type: att.type, disposition: "attachment" as const }));
}

/** Pictures in the message become inline attachments the email points at, ready to send. */
export function withInlinePictures(html: string, attachments: OutgoingAttachment[]): { html: string; attachments: OutgoingAttachment[] } {
	const { html: out, images } = extractInlineImages(html);
	return {
		html: out,
		attachments: [...attachments, ...images.map((img) => ({ content: img.content, filename: img.filename, type: img.type, disposition: "inline" as const, contentId: img.contentId }))],
	};
}

/** Fills {name} style gaps in a line from the copy file. */
export function fill(text: string, values: Record<string, string | number>): string {
	return text.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

/** Fetches a saved draft's attachments so it can be sent straight from the email view. */
export async function storedToOutgoing(mailboxId: string, emailId: string, list: Attachment[] | undefined): Promise<OutgoingAttachment[]> {
	const files = (list ?? []).filter((att) => att.disposition !== "inline");
	return Promise.all(files.map(async (att) => ({
		content: await readStored(mailboxId, emailId, att),
		filename: att.filename,
		type: att.mimetype || "application/octet-stream",
		disposition: "attachment" as const,
	})));
}
