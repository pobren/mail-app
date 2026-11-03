// Mail App addition (not part of upstream Agentic Inbox).
// The invite email a new person gets at their personal address. Wording lives in
// app/copy/people.en-GB.json. It goes to their personal address because their new mailbox can't show
// them anything until they've signed in. A branded install's (Admin > Branding) says the company's name.
import { rebrand, type Branding } from "../../shared/branding";
import { loadBranding } from "./branding";
import copy from "../../app/copy/people.en-GB.json";
import { sendTracked } from "./sending";
import type { Env } from "../types";

const fillIn = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface Invite {
	to: string;
	name: string;
	mailbox: string | null;
	admin: string;
	url: string;
}

export function inviteText(i: Invite, branding: Branding | null = null): { subject: string; text: string; html: string } {
	const v = { name: i.name, admin: i.admin, mailbox: i.mailbox ?? "", url: i.url, email: i.to };
	const e = copy.email;
	const fill = (s: string, vars: Record<string, string>) => fillIn(rebrand(s, branding), vars);
	const lines = [
		fill(e.greeting, v),
		fill(e.intro, v),
		i.mailbox ? fill(e.mailbox, v) : fill(e.noMailbox, v),
		fill(e.howTo, v),
		rebrand(e.tip, branding),
		rebrand(e.signOff, branding),
		i.admin,
	];
	const html = lines.map((l) => `<p>${esc(l).replace(esc(i.url), `<a href="${esc(i.url)}">${esc(i.url)}</a>`)}</p>`).join("\n");
	return { subject: fill(e.subject, v), text: lines.join("\n\n"), html };
}

/**
 * Sends the invite from the admin's own mailbox. Sending to someone else's address needs Cloudflare's
 * paid plan (or that address approved on the account), so a failure is expected sometimes: the caller
 * then shows the admin the text to send themselves.
 */
export async function sendInvite(env: Env, invite: Invite, from: { email: string; name: string } | null): Promise<{ sent: true } | { sent: false; error: string; text: string; subject: string }> {
	const message = inviteText(invite, await loadBranding(env.BUCKET));
	if (!from) return { sent: false, error: "you don't have a mailbox to send it from", text: message.text, subject: message.subject };
	try {
		await sendTracked(env, { to: invite.to, from, subject: message.subject, text: message.text, html: message.html });
		return { sent: true };
	} catch (e) {
		return { sent: false, error: (e as Error).message || "sending failed", text: message.text, subject: message.subject };
	}
}
