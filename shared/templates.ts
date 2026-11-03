// Mail App addition (not part of upstream Agentic Inbox).
// Email templates: saved messages to start an email from. They live in the mailbox's settings file in R2.

export interface EmailTemplate {
	id: string;
	name: string;
	subject: string;
	/** Plain text. Blank lines start a new paragraph. */
	body: string;
}

export const MAX_TEMPLATES = 50;

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Turns a template's plain text into the composer's HTML: a paragraph per block, a line break per line. */
export function templateHtml(body: string): string {
	return body
		.replace(/\r\n?/g, "\n")
		.trim()
		.split(/\n{2,}/)
		.map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
		.join("");
}

// The empty first line the composer starts with, above the signature or the quoted email.
const LEADING_EMPTY = /^(?:\s*<p>(?:\s|<br\s*\/?>)*<\/p>)+/i;

/**
 * Puts a template at the top of the email, above any signature or quoted email, in place of the empty
 * first line. The subject is only filled in when it's empty, so a reply keeps its "Re:".
 */
export function applyTemplate(body: string, subject: string, template: Pick<EmailTemplate, "subject" | "body">): { body: string; subject: string } {
	const rest = body.replace(LEADING_EMPTY, "");
	return {
		body: `${templateHtml(template.body)}${rest ? `<p></p>${rest}` : ""}`,
		subject: subject.trim() ? subject : template.subject,
	};
}

/** Keeps only well-formed templates, trimmed and capped, so a bad settings file can't break the composer. */
export function cleanTemplates(value: unknown): EmailTemplate[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((t): t is EmailTemplate => !!t && typeof t === "object" && typeof t.id === "string" && typeof t.name === "string" && typeof t.body === "string")
		.map((t) => ({ id: t.id, name: t.name.trim(), subject: typeof t.subject === "string" ? t.subject : "", body: t.body }))
		.filter((t) => t.name && t.body.trim())
		.slice(0, MAX_TEMPLATES);
}
