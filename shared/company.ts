// Mail App addition (not part of upstream Agentic Inbox).
// Email disclaimer: the admin pastes their disclaimer (company name, number, registered office and so on)
// once, and it goes at the end of every email anyone sends from this install (UK companies must show
// these on their business emails). Kept in R2 at setup/company.json. The footer goes in when an email is sent,
// so it's on mail written in Mail App, sent through the API or by the AI assistant, and auto-replies.

export interface CompanyDetails {
	enabled: boolean;
	/** The disclaimer, as the admin pasted it, one line per line. */
	disclaimer: string;
}

export const MAX_DISCLAIMER = 2000;

/** Marks the footer in the HTML, so it's never added twice. */
export const COMPANY_FOOTER_MARK = "data-app-company";

const clean = (v: unknown, max: number): string =>
	typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

/** Keeps the line breaks (and single blank lines between paragraphs), tidies everything else. */
const cleanDisclaimer = (v: string): string =>
	v.replace(/\r\n?/g, "\n").split("\n").map((l) => clean(l, MAX_DISCLAIMER)).join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_DISCLAIMER).trim();

// The page used to ask for the company's name, number, registered office, VAT number and an extra
// line, saved as separate fields. A saved copy of those becomes the same footer, written out as a disclaimer.
const REGISTERED_IN: Record<string, string> = {
	"england-wales": "England and Wales",
	wales: "Wales",
	scotland: "Scotland",
	"northern-ireland": "Northern Ireland",
};

function fromOldFields(o: Record<string, unknown>): string {
	const name = clean(o.name, 160);
	if (!name) return "";
	const number = clean(o.number, 160).toUpperCase();
	const where = REGISTERED_IN[String(o.registeredIn)] ?? REGISTERED_IN["england-wales"];
	const office = typeof o.office === "string"
		? o.office.replace(/\r\n?/g, "\n").split("\n").map((l) => clean(l, 300).replace(/,$/, "")).filter(Boolean).join(", ")
		: "";
	const vat = clean(o.vat, 160).toUpperCase();
	const extra = clean(o.extra, 500);
	const lines = [number ? `${name}. Registered in ${where}, company number ${number}.` : `${name}.`];
	if (office) lines.push(`Registered office: ${office}.`.replace(/\.\.$/, "."));
	if (vat) lines.push(`VAT number: ${vat}.`);
	if (extra) lines.push(/[.!?]$/.test(extra) ? extra : `${extra}.`);
	return lines.join("\n");
}

export function cleanCompany(v: unknown): CompanyDetails {
	const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
	const disclaimer = typeof o.disclaimer === "string" ? cleanDisclaimer(o.disclaimer) : fromOldFields(o);
	return { enabled: o.enabled === true && !!disclaimer, disclaimer };
}

/** The footer's lines, as plain text. A blank line keeps a gap between paragraphs. */
export function companyFooterLines(d: CompanyDetails): string[] {
	return d.disclaimer ? d.disclaimer.split("\n") : [];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function companyFooterHtml(d: CompanyDetails): string {
	const lines = companyFooterLines(d);
	if (!lines.length) return "";
	return `<div ${COMPANY_FOOTER_MARK}="1" style="margin-top: 24px; padding-top: 8px; border-top: 1px solid #e5e5e5; color: #6b6b6b; font-size: 12px; line-height: 1.5;">${lines.map(esc).join("<br>")}</div>`;
}

export function companyFooterText(d: CompanyDetails): string {
	const lines = companyFooterLines(d);
	return lines.length ? `--\n${lines.join("\n")}` : "";
}

// Where the quoted email starts in a reply or forward written in Mail App (see app/lib/utils.ts and
// app/hooks/useComposeForm.ts): the footer goes above it, under what the person wrote.
const HTML_QUOTE_STARTS = [
	'<br><blockquote style="border-left: 2px solid #ccc;',
	'<div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>Forwarded message:',
];
const TEXT_QUOTE_START = /\n(On .{3,200} wrote:|Forwarded message:)/;

function quoteStart(html: string): number {
	const found = HTML_QUOTE_STARTS.map((m) => html.indexOf(m)).filter((i) => i >= 0);
	return found.length ? Math.min(...found) : -1;
}

/** Adds the footer to an outgoing email's HTML and text, above any quoted email. */
export function withCompanyFooter<T extends { html?: string; text?: string }>(email: T, d: CompanyDetails | null): T {
	if (!d?.enabled) return email;
	const footerHtml = companyFooterHtml(d);
	if (!footerHtml) return email;
	const out = { ...email };
	if (email.html) {
		const at = quoteStart(email.html);
		const own = at >= 0 ? email.html.slice(0, at) : email.html;
		if (!own.includes(COMPANY_FOOTER_MARK)) {
			out.html = at >= 0 ? `${own}${footerHtml}${email.html.slice(at)}` : insertBeforeBodyEnd(email.html, footerHtml);
		}
	}
	if (email.text !== undefined || !email.html) {
		const text = email.text ?? "";
		const footerText = companyFooterText(d);
		const m = TEXT_QUOTE_START.exec(text);
		out.text = m ? `${text.slice(0, m.index).trimEnd()}\n\n${footerText}\n${text.slice(m.index)}` : `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${footerText}`;
	}
	return out;
}

function insertBeforeBodyEnd(html: string, footer: string): string {
	const end = html.search(/<\/body>/i);
	return end >= 0 ? `${html.slice(0, end)}${footer}${html.slice(end)}` : `${html}${footer}`;
}
