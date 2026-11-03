// Mail App: the welcome email placed in every new inbox. Wording lives in app/copy/welcome.en-GB.json.
// It is written straight into the mailbox, never sent, so it works on Cloudflare's free plan too.
// A branded install's (Admin > Branding) has the company's name and none of Mail App's links.

import copy from "../../app/copy/welcome.en-GB.json";
import { brandName, isBranded, rebrand, type Branding } from "../../shared/branding";

export interface WelcomeEmail {
	id: string;
	subject: string;
	sender: string;
	sender_name: string;
	recipient: string;
	date: string;
	body: string;
	thread_id: string;
	message_id: string;
}

const esc = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Relative links ("/setup") point at this Mail App's own web address. */
function href(url: string, origin: string): string {
	return url.startsWith("/") ? origin + url : url;
}

export function welcomeEmail(mailbox: string, name: string, origin: string, now = new Date(), branding: Branding | null = null): WelcomeEmail {
	const p = (text: string) => `<p>${esc(rebrand(text, branding))}</p>`;
	const list = (items: string[]) => `<ul>${items.join("")}</ul>`;
	const branded = isBranded(branding);
	const brand = brandName(branding);
	const body = (branded ? [
		p(copy.greeting.replace("{name}", name || mailbox)),
		...copy.paragraphs.map(p),
		p(copy.labelNote),
		...(branding?.supportEmail ? [p(copy.brandedHelp.replace("{support}", branding.supportEmail))] : []),
		p(copy.brandedSignOff.replace("{brand}", brand)),
	] : [
		p(copy.greeting.replace("{name}", name || mailbox)),
		...copy.paragraphs.map(p),
		p(copy.labelNote),
		`<h3>${esc(copy.linksTitle)}</h3>`,
		list(copy.links.map((l) => `<li><a href="${esc(href(l.url, origin))}">${esc(l.text)}</a></li>`)),
		`<h3>${esc(copy.comingTitle)}</h3>`,
		list(copy.coming.map((c) => `<li>${esc(c)}</li>`)),
		p(copy.suggestions),
		p(copy.signOff),
		`<p>${esc(copy.founder.name)}<br><a href="${esc(copy.founder.url)}">${esc(copy.founder.linkText)}</a></p>`,
	]).join("\n");
	const id = crypto.randomUUID();
	return {
		id,
		subject: rebrand(copy.subject, branding),
		sender: branded ? branding?.supportEmail || mailbox : copy.from,
		sender_name: brand,
		recipient: mailbox,
		date: now.toISOString(),
		body,
		thread_id: id,
		message_id: `${id}@welcome.mail-app.invalid`,
	};
}
