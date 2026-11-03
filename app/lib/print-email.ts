// Mail App, 2026: print an email or a whole conversation. The messages are made safe the same way as
// on screen (no scripts, trackers removed, pictures fetched privately through Mail App), laid out plainly
// in a hidden frame, and handed to the browser's print window.

import { fetchImage, sanitizeEmailBody, stripWebImages } from "~/components/EmailIframe";
import { formatDetailDate } from "shared/dates";
import { rewriteInlineImages } from "~/lib/utils";
import type { Email } from "~/types";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function who(email: Email): string {
	return email.sender_name ? `${email.sender_name} <${email.sender}>` : email.sender;
}

async function messageHtml(email: Email, mailboxId: string): Promise<string> {
	const body = rewriteInlineImages(email.body || "", mailboxId, email.id, email.attachments);
	const { html, urls } = stripWebImages(sanitizeEmailBody(body));
	const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
	const pictures = await Promise.all(urls.map((u) => fetchImage(u)));
	doc.querySelectorAll<HTMLImageElement>("img[data-app-img]").forEach((img) => {
		const src = pictures[Number(img.dataset.appImg)];
		if (src && src.startsWith("data:image/")) img.src = src;
		else img.remove();
	});
	const files = (email.attachments ?? []).filter((a) => a.disposition !== "inline").map((a) => esc(a.filename));
	return `<article>
		<table class="head">
			<tr><th>From</th><td>${esc(who(email))}</td></tr>
			<tr><th>To</th><td>${esc(email.recipient || "")}</td></tr>
			${email.cc ? `<tr><th>Cc</th><td>${esc(email.cc)}</td></tr>` : ""}
			<tr><th>Date</th><td>${esc(formatDetailDate(email.date))}</td></tr>
			${files.length ? `<tr><th>Attached</th><td>${files.join(", ")}</td></tr>` : ""}
		</table>
		<div class="body">${doc.body.innerHTML}</div>
	</article>`;
}

/** Opens the browser's print window for these messages, oldest first. */
export async function printEmails(messages: Email[], mailboxId: string): Promise<void> {
	if (messages.length === 0) return;
	const ordered = [...messages].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
	const parts = await Promise.all(ordered.map((m) => messageHtml(m, mailboxId)));
	const subject = esc(ordered[ordered.length - 1].subject || "(no subject)");

	const frame = document.createElement("iframe");
	// Same origin so this page can call print(); no allow-scripts, and the page's own rules block scripts too.
	frame.setAttribute("sandbox", "allow-same-origin allow-modals");
	frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
	frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<title>${subject}</title>
<style>
	body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 12pt; line-height: 1.5; color: #000; margin: 0; }
	h1 { font-size: 16pt; margin: 0 0 12pt; }
	article { padding: 10pt 0; border-top: 1px solid #999; page-break-inside: auto; }
	table.head { border-collapse: collapse; margin-bottom: 10pt; font-size: 10pt; }
	table.head th { text-align: left; font-weight: 600; padding: 1pt 10pt 1pt 0; vertical-align: top; color: #444; }
	table.head td { padding: 1pt 0; }
	.body { overflow-wrap: break-word; }
	.body img { max-width: 100%; height: auto; }
	.body table { max-width: 100%; }
	footer { margin-top: 14pt; font-size: 9pt; color: #666; }
</style></head><body>
<h1>${subject}</h1>
${parts.join("\n")}
<footer>Printed from Mail App</footer>
</body></html>`;
	document.body.appendChild(frame);
	await new Promise<void>((resolve) => { frame.onload = () => resolve(); });
	const win = frame.contentWindow;
	if (!win) { frame.remove(); return; }
	win.addEventListener("afterprint", () => setTimeout(() => frame.remove(), 0));
	win.focus();
	win.print();
	// Some browsers don't fire afterprint; tidy up later either way.
	setTimeout(() => frame.remove(), 60_000);
}
