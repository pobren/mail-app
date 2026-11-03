// Mail App addition (not part of upstream Agentic Inbox).
// Pictures pasted or dropped into the message sit in the editor as data: addresses. Gmail and
// Outlook won't show those, so when the email is sent each one becomes an inline attachment and
// the picture points at it with cid:, which every mail app understands.

export interface InlineImage {
	contentId: string;
	filename: string;
	type: string;
	/** base64 */
	content: string;
}

const DATA_IMG = /(<img\b[^>]*?\bsrc=)(["'])data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)\2/gi;

const extension = (type: string) => (type.split("/")[1] || "png").replace("jpeg", "jpg");

/** Swaps every data: picture for a cid: one and returns the pictures to attach. */
export function extractInlineImages(html: string, newId: () => string = () => crypto.randomUUID()): { html: string; images: InlineImage[] } {
	const images: InlineImage[] = [];
	const out = html.replace(DATA_IMG, (_m, start: string, quote: string, type: string, data: string) => {
		const contentId = `${newId()}@mail-app`;
		const t = type.toLowerCase().replace("image/jpg", "image/jpeg");
		images.push({ contentId, filename: `picture-${images.length + 1}.${extension(t)}`, type: t, content: data.replace(/\s/g, "") });
		return `${start}${quote}cid:${contentId}${quote}`;
	});
	return { html: out, images };
}

/** Bytes of the pictures in a message, so the size check counts them once, as attachments. */
export function inlineImageBytes(html: string): number {
	let total = 0;
	for (const m of html.matchAll(DATA_IMG)) {
		const b64 = m[4].replace(/\s/g, "");
		total += Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
	}
	return total;
}

/** The message without its pictures, for working out how much room the text takes. */
export function withoutInlineImages(html: string): string {
	return html.replace(DATA_IMG, (_m, start: string, quote: string) => `${start}${quote}${quote}`);
}
