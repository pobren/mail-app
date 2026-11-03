// Mail App addition (not part of upstream Agentic Inbox).
// Size rules for sending attachments. Cloudflare Email Service accepts messages of up to 5 MiB in total,
// counted after encoding, and attachments are sent base64-encoded, which makes them about a third bigger.
// See https://developers.cloudflare.com/email-service/platform/limits/

/** Cloudflare's limit for one outgoing message, attachments included. */
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

/** Room kept back for headers, MIME boundaries and the address lines. */
export const HEADROOM_BYTES = 64 * 1024;

/** Bytes of a file once base64-encoded in a message: 4 characters for every 3 bytes, plus a line break every 76. */
export function encodedSize(bytes: number): number {
	const base64 = 4 * Math.ceil(Math.max(0, bytes) / 3);
	return base64 + 2 * Math.ceil(base64 / 76);
}

/** Bytes a string takes as UTF-8. */
export function textBytes(text: string | undefined | null): number {
	return text ? new TextEncoder().encode(text).byteLength : 0;
}

/** Bytes of a base64 string once decoded (no padding or whitespace counted). */
export function base64DecodedSize(content: string): number {
	const clean = content.replace(/[\s]/g, "");
	const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/** Estimated size of the whole message as Cloudflare counts it. The body is counted as if base64-encoded too, to be safe. */
export function estimateMessageBytes(attachmentSizes: number[], html?: string | null, text?: string | null): number {
	const bodies = encodedSize(textBytes(html)) + encodedSize(textBytes(text));
	return HEADROOM_BYTES + bodies + attachmentSizes.reduce((sum, size) => sum + encodedSize(size), 0);
}

/** How many bytes of files (before encoding) still fit alongside this body. */
export function attachmentAllowance(html?: string | null, text?: string | null): number {
	const left = MAX_MESSAGE_BYTES - estimateMessageBytes([], html, text);
	if (left <= 0) return 0;
	// Undo encodedSize: 3 bytes become 4 characters, and 76 characters gain 2 for the line break.
	return Math.floor((left * 3 * 76) / (4 * 78));
}

export function isTooLarge(attachmentSizes: number[], html?: string | null, text?: string | null): boolean {
	return estimateMessageBytes(attachmentSizes, html, text) > MAX_MESSAGE_BYTES;
}

/** "820 KB", "3.7 MB". Uses 1,024 so it matches what people's computers show. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Room the download-links box takes in the email, per link, plus its heading. */
const LINK_BOX_BYTES = 1024;
const LINK_BYTES = 600;

/**
 * Which files go as attachments and which as download links: the biggest files become links until the
 * rest fits in the email. Positions refer to `sizes`. `fixed` are files that must stay in the email, such as
 * pictures in the message itself.
 */
export function splitForLinks(sizes: number[], html?: string | null, text?: string | null, fixed: number[] = []): { attach: number[]; link: number[] } {
	const order = sizes.map((size, i) => ({ size, i })).sort((a, b) => b.size - a.size);
	const link: number[] = [];
	const extra = (n: number) => (n ? LINK_BOX_BYTES + n * LINK_BYTES : 0);
	while (link.length < order.length) {
		const rest = order.filter((o) => !link.includes(o.i)).map((o) => o.size);
		const padding = " ".repeat(extra(link.length));
		if (!isTooLarge([...fixed, ...rest], `${html ?? ""}${padding}`, `${text ?? ""}${padding}`)) break;
		link.push(order[link.length].i);
	}
	const attach = sizes.map((_, i) => i).filter((i) => !link.includes(i));
	return { attach, link: link.sort((a, b) => a - b) };
}
