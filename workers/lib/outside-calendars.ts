// Mail App addition (not part of upstream Agentic Inbox).
// Fetching calendars from other websites (see shared/outside-calendars.ts). The request comes from
// this install's own Cloudflare account and carries nothing about the person.

import { cleanSourceUrl, MAX_OUTSIDE_BYTES, outsideEvents, REFRESH_EVERY_MS, type OutsideEvent } from "../../shared/outside-calendars";
import type { Calendar } from "../../shared/calendar";
import type { MailboxDO } from "../durableObject";

/** Fetches and reads an .ics link. A sentence comes back when it can't. */
export async function fetchOutside(rawUrl: string, calendarId: string, tz: string): Promise<{ events: OutsideEvent[] } | { error: string }> {
	const url = cleanSourceUrl(rawUrl);
	if (!url) return { error: "That isn't a web address we can open." };
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { accept: "text/calendar, text/plain;q=0.8, */*;q=0.5", "user-agent": "Mail App calendar (+https://github.com/pobren/mail-app)" },
			redirect: "follow",
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		return { error: "The website didn't answer. We'll try again later." };
	}
	if (res.status === 404 || res.status === 410) return { error: "That calendar link no longer works (the website says it isn't there)." };
	if (res.status === 401 || res.status === 403) return { error: "That calendar is private on its website, so it can't be read from a link." };
	if (!res.ok) return { error: `The website answered with an error (${res.status}). We'll try again later.` };
	if (Number(res.headers.get("content-length") ?? 0) > MAX_OUTSIDE_BYTES) return { error: "That calendar is too big to add (over 5 MB)." };
	const text = await res.text();
	if (text.length > MAX_OUTSIDE_BYTES) return { error: "That calendar is too big to add (over 5 MB)." };
	const events = outsideEvents(text, calendarId, tz);
	return typeof events === "string" ? { error: events } : { events };
}

/** Brings one calendar from another website up to date, now. */
export async function refreshOutside(stub: DurableObjectStub<MailboxDO>, calendarId: string): Promise<void> {
	const source = await stub.outsideCalendarSource(calendarId);
	if (!source) return;
	await stub.replaceOutsideCalendar(calendarId, await fetchOutside(source.url, calendarId, source.tz));
}

/** Calendars from other websites that are due an update. */
export function dueForRefresh(calendars: Calendar[], now = Date.now()): Calendar[] {
	return calendars.filter((c) => c.sourceUrl && (!c.refreshedAt || now - Date.parse(c.refreshedAt) >= REFRESH_EVERY_MS));
}
