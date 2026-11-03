// Mail App, 2026: calendar reminders inside the open app. Notifications on phones and the Dock come
// from the server (workers/durableObject/calendar.ts); this shows the same reminder as a message in
// the corner while Mail App is open, which also covers devices without notifications switched on.

import { useKumoToastManager } from "@cloudflare/kumo";
import { useEffect } from "react";
import { useUpcomingReminders } from "~/queries/calendar";
import copy from "~/copy/calendar.en-GB.json";

const SHOWN_KEY = "mailapp.calendar.reminders-shown";

function alreadyShown(): Set<string> {
	try { return new Set(JSON.parse(sessionStorage.getItem(SHOWN_KEY) || "[]")); } catch { return new Set(); }
}

function markShown(key: string) {
	try {
		const shown = [...alreadyShown(), key].slice(-200);
		sessionStorage.setItem(SHOWN_KEY, JSON.stringify(shown));
	} catch { /* not remembered: it may show twice */ }
}

export function useCalendarReminders(mailboxId: string | undefined) {
	const { data: reminders } = useUpcomingReminders(mailboxId);
	const toast = useKumoToastManager();
	useEffect(() => {
		if (!reminders?.length) return;
		const timers: ReturnType<typeof setTimeout>[] = [];
		for (const r of reminders) {
			const key = `${mailboxId}|${r.eventId}|${r.occurrence ?? ""}|${r.minutes}`;
			const wait = Date.parse(r.at) - Date.now();
			// Missed by more than five minutes (the app was closed): the notification has done its job.
			if (wait < -5 * 60_000 || wait > 24 * 3_600_000 || alreadyShown().has(key)) continue;
			timers.push(setTimeout(() => {
				if (alreadyShown().has(key)) return;
				markShown(key);
				const start = Date.parse(r.startAt);
				const mins = Math.round((start - Date.now()) / 60_000);
				const when = r.allDay
					? new Date(r.startAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
					: mins <= 0 ? copy.startsNow
					: mins < 60 ? copy.startsIn.replace("{n}", String(mins))
					: copy.startsAt.replace("{when}", new Date(start).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }));
				toast.add({ title: r.title, description: r.location ? `${when} · ${r.location}` : when, timeout: 0 });
			}, Math.max(0, wait)));
		}
		return () => timers.forEach(clearTimeout);
	}, [reminders, mailboxId]); // eslint-disable-line react-hooks/exhaustive-deps
}
