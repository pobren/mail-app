// Mail App addition (not part of upstream Agentic Inbox).
// Emails calendar invites: to guests of our own events (invite, update, cancel), and our answer to an
// invite someone sent us. Each carries an invite.ics that Outlook, Gmail and Apple Mail show as an
// invite with Yes / Maybe / No buttons. The email itself says it all in words too.

import { EmailMessage } from "cloudflare:email";
import { sendTracked } from "./sending";
import { sendFailureText } from "../../shared/sending";
import { eventFromInvite, exceptionsFromInvite, inviteIcs, inviteMime, recurrenceIdFromInvite, inviteSubject, joinWords, parseIcs, whenText, STATUS_WORDS, type InviteMethod } from "../../shared/invites";
import type { CalendarEvent, EventInput, Guest, GuestStatus, Organizer } from "../../shared/calendar";
import type { Env } from "../types";

function base64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Who an invite is from: the mailbox's address, with the name its emails go out under (as in the composer). */
export async function organizerFor(env: Env, mailboxId: string, person: { name?: string } | null | undefined): Promise<Organizer> {
	let fromName = "";
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		const settings = obj ? ((await obj.json()) as { fromName?: unknown }) : null;
		if (typeof settings?.fromName === "string") fromName = settings.fromName;
	} catch { /* no name, then */ }
	return { email: mailboxId.toLowerCase(), name: (fromName || person?.name || "").trim() };
}

/**
 * Sends the email and turns a refusal into a sentence. Null when it went.
 *
 * Each person gets their own copy, built in full here so the invite rides alongside the words as a
 * calendar part (what Apple Mail and iCloud need to show Yes / Maybe / No). If Cloudflare won't take
 * an email built that way, the rest go the ordinary way, with the invite as an attached file.
 */
async function send(env: Env, params: Parameters<typeof sendTracked>[1], ics: string, method: InviteMethod, mailboxId?: string): Promise<string | null> {
	const from = typeof params.from === "string" ? { email: params.from } : params.from;
	const to = (Array.isArray(params.to) ? params.to : [params.to]) as (string | { email: string; name?: string })[];
	// Invites count towards the mailbox's sending limit like any other email.
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName((mailboxId ?? from.email).toLowerCase()));
	const overLimit = await (stub as unknown as { checkSendRateLimit(n?: number): Promise<string | null> }).checkSendRateLimit(to.length);
	if (overLimit) return overLimit;
	const left = to.map((t) => (typeof t === "string" ? { email: t } : t));
	while (left.length) {
		const who = left[0];
		try {
			const raw = inviteMime({ from, to: who, subject: params.subject, text: params.text ?? "", html: params.html ?? "", ics, method });
			await env.EMAIL.send(new EmailMessage(from.email, who.email, raw));
			left.shift();
		} catch (e) {
			console.error("Invite not sent as a calendar email, sending it with an attached file:", (e as Error)?.message ?? e);
			break;
		}
	}
	if (!left.length) return null;
	return sendWithFile(env, { ...params, to: left as unknown as string[] }, ics, method);
}

/** The ordinary way: the invite as an attached invite.ics file. */
async function sendWithFile(env: Env, params: Parameters<typeof sendTracked>[1], ics: string, method: InviteMethod): Promise<string | null> {
	const attach = (type: string) => ({
		...params,
		attachments: [{ content: base64(ics), filename: "invite.ics", type, disposition: "attachment" as const }],
		headers: { ...(params.headers ?? {}), "Auto-Submitted": "auto-generated" },
	});
	try {
		await sendTracked(env, attach(`text/calendar; method=${method}; charset=UTF-8`));
		return null;
	} catch (first) {
		// In case the file's type with its method is refused, try once more with just "text/calendar".
		if (!/type|attachment|mime/i.test(String((first as Error)?.message ?? ""))) return sendFailureText(first);
		try {
			await sendTracked(env, attach("text/calendar"));
			return null;
		} catch (e) {
			console.error("Invite not sent:", (e as Error)?.message ?? e);
			return sendFailureText(e);
		}
	}
}

/**
 * Emails guests about one of our events: REQUEST invites them (or, with `update`, says it changed),
 * CANCEL says it's off. Every guest on the event is listed in the invite; `to` says who gets this email.
 */
export async function emailGuests(env: Env, method: "REQUEST" | "CANCEL", ev: CalendarEvent, organizer: Organizer, to: Guest[], update = false): Promise<string | null> {
	if (!to.length) return null;
	const ics = inviteIcs(method, ev, organizer, method === "CANCEL" ? to : ev.guests);
	const who = organizer.name || organizer.email;
	const opening = method === "CANCEL" ? `${who} has cancelled this event.` : update ? `${who} has changed this event.` : `${who} has invited you to an event.`;
	const details: [string, string][] = [
		["When", whenText(ev)],
		...(ev.location ? [["Where", ev.location] as [string, string]] : []),
		...(ev.meetingUrl && method !== "CANCEL" ? [[joinWords(ev.meetingUrl), ev.meetingUrl] as [string, string]] : []),
		...(ev.guests.length ? [["Guests", ev.guests.map((g) => g.name || g.email).join(", ")] as [string, string]] : []),
	];
	const closing = method === "CANCEL"
		? "Open the attached file to take it out of your calendar."
		: "Use the Yes, Maybe or No buttons in your email app, or open the attached invite to add it to your calendar.";
	const text = [opening, "", ev.title, ...details.map(([k, v]) => `${k}: ${v}`), ...(ev.notes ? ["", ev.notes] : []), "", closing].join("\n");
	const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.5;color:#111">
<p>${escapeHtml(opening)}</p>
<p style="font-size:20px;font-weight:600;margin:16px 0 8px">${escapeHtml(ev.title)}</p>
<table style="border-collapse:collapse">${details.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#555;vertical-align:top">${escapeHtml(k)}</td><td style="padding:2px 0">${
		/^https?:\/\//.test(v) ? `<a href="${escapeHtml(v)}">${escapeHtml(v)}</a>` : escapeHtml(v)}</td></tr>`).join("")}</table>
${ev.notes ? `<p style="white-space:pre-wrap">${escapeHtml(ev.notes)}</p>` : ""}
<p style="color:#555">${escapeHtml(closing)}</p></div>`;
	return send(env, {
		to: to.map((g) => (g.name ? { email: g.email, name: g.name } : g.email)) as unknown as string[],
		from: organizer.name ? { email: organizer.email, name: organizer.name } : organizer.email,
		subject: inviteSubject(method, ev, { update }),
		text, html,
	}, ics, method);
}

/** Our answer to an invite someone sent us, emailed to whoever sent it. */
export async function emailAnswer(env: Env, ev: CalendarEvent, organizer: Organizer, me: Guest, answer: GuestStatus, mailboxId?: string): Promise<string | null> {
	const ics = inviteIcs("REPLY", ev, organizer, [{ ...me, status: answer }]);
	const who = me.name || me.email;
	const words = { accepted: "has accepted", tentative: "might come to", declined: "has declined", "needs-action": "has seen" }[answer];
	const text = `${who} ${words} your invitation to ${ev.title}.\n\nWhen: ${whenText(ev)}\n\nAnswer: ${STATUS_WORDS[answer]}`;
	return send(env, {
		to: organizer.email,
		from: me.name ? { email: me.email, name: me.name } : me.email,
		subject: inviteSubject("REPLY", ev, { answer }),
		text,
		html: `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.5"><p>${escapeHtml(`${who} ${words} your invitation to `)}<strong>${escapeHtml(ev.title)}</strong>.</p><p style="color:#555">${escapeHtml(whenText(ev))}</p></div>`,
	}, ics, "REPLY", mailboxId);
}

interface InviteStub {
	calendarEventByUid(uid: string, recurrenceId?: string | null): Promise<CalendarEvent | null>;
	setCalendarGuestStatus(uid: string, email: string, status: GuestStatus, name?: string, recurrenceId?: string | null): Promise<CalendarEvent | null>;
	saveCalendarInvite(input: EventInput, invite: { uid: string; organizer: Organizer | null; sequence: number; exceptions: string[]; recurrenceId?: string | null }, viewer: { email: string; name: string }): Promise<CalendarEvent>;
}

/**
 * When an invite email arrives: a guest's answer to one of our invites is noted on the event, and a
 * change to an event already in the calendar is taken in (keeping our own answer). New invites wait
 * for the person to answer them from the email. `sender` is who the email is from.
 */
export async function takeInIncomingInvite(stub: InviteStub, ics: string, sender: string): Promise<void> {
	// Only the guest themselves can answer for a guest, and only whoever sent an invite can change it.
	const from = sender.toLowerCase();
	const file = parseIcs(ics);
	for (const ev of file.events) {
		if (file.method === "REPLY") {
			const series = ev.recurrenceId ? await stub.calendarEventByUid(ev.uid) : null;
			const rid = ev.recurrenceId ? recurrenceIdFromInvite(ev, file, series?.timeZone ?? "Europe/London") : null;
			for (const a of ev.attendees) if (a.email === from) await stub.setCalendarGuestStatus(ev.uid, a.email, a.status, a.name, rid);
			continue;
		}
		if (file.method !== "REQUEST") continue;
		// One date of a series changed on its own: the series says who may change it.
		const series = ev.recurrenceId ? await stub.calendarEventByUid(ev.uid) : null;
		const rid = ev.recurrenceId ? recurrenceIdFromInvite(ev, file, series?.timeZone ?? "Europe/London") : null;
		const had = (await stub.calendarEventByUid(ev.uid, rid)) ?? (rid ? series : null);
		if (!had?.organizer || had.organizer.email !== from) continue;
		if (had.recurrenceId === rid && had.sequence >= ev.sequence) continue;
		const input = eventFromInvite(ev, file, had.timeZone, had.calendarId);
		// Our own answer stays as it was.
		const mine = new Map(had.guests.filter((g) => g.status !== "needs-action").map((g) => [g.email, g.status]));
		input.guests = input.guests.map((g) => (mine.has(g.email) ? { ...g, status: mine.get(g.email)! } : g));
		await stub.saveCalendarInvite(input, { uid: ev.uid, organizer: ev.organizer ?? had.organizer, sequence: ev.sequence, exceptions: exceptionsFromInvite(ev, file, input), recurrenceId: rid }, { email: had.createdBy ?? "", name: had.createdByName ?? "" });
	}
}
