// Mail App: the calendar.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Calendar, CalendarColor, EditScope, EventInput, GuestStatus, Occurrence } from "shared/calendar";
import type { ShareLevel } from "shared/calendar-shares";
import type { FeedLevel } from "shared/calendar-feeds";
import api, { ApiError, type SharedCalendar } from "~/services/api";

const keys = {
	calendars: (mailboxId: string) => ["calendars", mailboxId] as const,
	events: (mailboxId: string, from: string, to: string) => ["calendar-events", mailboxId, from, to] as const,
	allEvents: (mailboxId: string) => ["calendar-events", mailboxId] as const,
	reminders: (mailboxId: string) => ["calendar-reminders", mailboxId] as const,
	shareCounts: (mailboxId: string) => ["calendar-share-counts", mailboxId] as const,
	shares: (mailboxId: string, id: string) => ["calendar-shares", mailboxId, id] as const,
	shared: ["shared-calendars"] as const,
	sharedEvents: (from: string, to: string) => ["shared-calendar-events", from, to] as const,
	allSharedEvents: ["shared-calendar-events"] as const,
};

/** The server's own sentence for what went wrong, if it sent one. */
export function problemOf(err: unknown, fallback: string): string {
	return err instanceof ApiError && typeof err.body?.error === "string" ? err.body.error : fallback;
}

export function useCalendars(mailboxId: string | undefined) {
	return useQuery<Calendar[]>({
		queryKey: mailboxId ? keys.calendars(mailboxId) : ["calendars", "_disabled"],
		queryFn: () => api.listCalendars(mailboxId!),
		enabled: !!mailboxId,
	});
}

export function useCalendarEvents(mailboxId: string | undefined, range: { from: string; to: string } | null) {
	return useQuery<Occurrence[]>({
		queryKey: mailboxId && range ? keys.events(mailboxId, range.from, range.to) : ["calendar-events", "_disabled"],
		queryFn: () => api.listCalendarEvents(mailboxId!, range!.from, range!.to),
		enabled: !!mailboxId && !!range,
		placeholderData: keepPreviousData,
	});
}

export function useUpcomingReminders(mailboxId: string | undefined) {
	return useQuery({
		queryKey: mailboxId ? keys.reminders(mailboxId) : ["calendar-reminders", "_disabled"],
		queryFn: () => api.upcomingReminders(mailboxId!),
		enabled: !!mailboxId,
		refetchInterval: 5 * 60_000,
		staleTime: 60_000,
	});
}

function useRefresh(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return () => {
		// A calendar of yours may be shared with you in another mailbox too, so shared events refresh as well.
		qc.invalidateQueries({ queryKey: keys.allSharedEvents });
		if (!mailboxId) return;
		qc.invalidateQueries({ queryKey: keys.allEvents(mailboxId) });
		qc.invalidateQueries({ queryKey: keys.reminders(mailboxId) });
	};
}

// ── Calendar sharing ─────────────────────────────────────────────

/** How many people each of this mailbox's calendars is shared with. */
export function useShareCounts(mailboxId: string | undefined) {
	return useQuery({
		queryKey: mailboxId ? keys.shareCounts(mailboxId) : ["calendar-share-counts", "_disabled"],
		queryFn: async () => (await api.calendarShareCounts(mailboxId!)).counts,
		enabled: !!mailboxId,
	});
}

export function useCalendarShares(mailboxId: string | undefined, id: string | null) {
	return useQuery({
		queryKey: mailboxId && id ? keys.shares(mailboxId, id) : ["calendar-shares", "_disabled"],
		queryFn: () => api.getCalendarShares(mailboxId!, id!),
		enabled: !!mailboxId && !!id,
	});
}

export function useSaveShares(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, shares }: { id: string; shares: { with: string; level: ShareLevel }[] }) => api.saveCalendarShares(mailboxId!, id, shares),
		onSuccess: (_, { id }) => {
			qc.invalidateQueries({ queryKey: keys.shares(mailboxId!, id) });
			qc.invalidateQueries({ queryKey: keys.shareCounts(mailboxId!) });
			qc.invalidateQueries({ queryKey: keys.shared });
			qc.invalidateQueries({ queryKey: keys.allSharedEvents });
		},
	});
}

/** Calendars other people have shared with you. */
export function useSharedCalendars() {
	return useQuery<SharedCalendar[]>({ queryKey: keys.shared, queryFn: () => api.listSharedCalendars(), staleTime: 60_000 });
}

export function useSharedEvents(range: { from: string; to: string } | null, enabled: boolean) {
	return useQuery({
		queryKey: range ? keys.sharedEvents(range.from, range.to) : ["shared-calendar-events", "_disabled"],
		queryFn: () => api.listSharedEvents(range!.from, range!.to),
		enabled: !!range && enabled,
		placeholderData: keepPreviousData,
	});
}

export function useSaveSharedEvent() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ owner, id, event, scope, occurrence }: { owner: string; id?: string; event: EventInput; scope?: EditScope; occurrence?: string | null }) =>
			id ? api.updateSharedEvent(owner, id, event, scope ?? "all", occurrence ?? null) : api.createSharedEvent(owner, event),
		onSettled: () => qc.invalidateQueries({ queryKey: keys.allSharedEvents }),
	});
}

export function useDeleteSharedEvent() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ owner, id, scope, occurrence }: { owner: string; id: string; scope: EditScope; occurrence: string | null }) =>
			api.deleteSharedEvent(owner, id, scope, occurrence),
		onSettled: () => qc.invalidateQueries({ queryKey: keys.allSharedEvents }),
	});
}

export function useSaveCalendar(mailboxId: string | undefined) {
	const qc = useQueryClient();
	const refresh = useRefresh(mailboxId);
	return useMutation({
		mutationFn: ({ id, name, color, sourceUrl, tz }: { id?: string; name: string; color: CalendarColor; sourceUrl?: string; tz?: string }) =>
			id ? api.updateCalendar(mailboxId!, id, { name, color }) : api.createCalendar(mailboxId!, { name, color, sourceUrl, tz }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: keys.calendars(mailboxId!) });
			refresh();
		},
	});
}

export function useDeleteCalendar(mailboxId: string | undefined) {
	const qc = useQueryClient();
	const refresh = useRefresh(mailboxId);
	return useMutation({
		mutationFn: (id: string) => api.deleteCalendar(mailboxId!, id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: keys.calendars(mailboxId!) });
			refresh();
		},
	});
}

export function useSaveEvent(mailboxId: string | undefined) {
	const refresh = useRefresh(mailboxId);
	return useMutation({
		mutationFn: ({ id, event, scope, occurrence, notify }: { id?: string; event: EventInput; scope?: EditScope; occurrence?: string | null; notify?: boolean }) =>
			id ? api.updateCalendarEvent(mailboxId!, id, event, scope ?? "all", occurrence ?? null, notify) : api.createCalendarEvent(mailboxId!, event, notify),
		onSettled: refresh,
	});
}

export function useDeleteEvent(mailboxId: string | undefined) {
	const refresh = useRefresh(mailboxId);
	return useMutation({
		mutationFn: ({ id, scope, occurrence, notify }: { id: string; scope: EditScope; occurrence: string | null; notify?: boolean }) =>
			api.deleteCalendarEvent(mailboxId!, id, scope, occurrence, notify),
		onSettled: refresh,
	});
}

/** The invite in an email, if it has one (emails with an .ics file only). */
export function useEmailInvite(mailboxId: string | undefined, emailId: string, hasInvite: boolean, tz: string) {
	return useQuery({
		queryKey: ["email-invite", mailboxId, emailId],
		queryFn: () => api.getInvite(mailboxId!, emailId, tz),
		enabled: !!mailboxId && hasInvite,
		staleTime: 30_000,
	});
}

export function useAnswerInvite(mailboxId: string | undefined, emailId: string, tz: string) {
	const qc = useQueryClient();
	const refresh = useRefresh(mailboxId);
	return useMutation({
		mutationFn: (answer: GuestStatus | "remove") => api.answerInvite(mailboxId!, emailId, answer, tz),
		onSettled: () => {
			refresh();
			qc.invalidateQueries({ queryKey: ["email-invite", mailboxId, emailId] });
		},
	});
}

// ── Subscribe links ──────────────────────────────────────────────

export function useCalendarFeed(mailboxId: string | undefined, id: string | null) {
	return useQuery({
		queryKey: ["calendar-feed", mailboxId, id],
		queryFn: async () => (await api.getCalendarFeed(mailboxId!, id!)).feed,
		enabled: !!mailboxId && !!id,
	});
}

export function useSaveCalendarFeed(mailboxId: string | undefined, id: string | null) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ level, renew, off }: { level?: FeedLevel; renew?: boolean; off?: boolean }) =>
			off ? api.deleteCalendarFeed(mailboxId!, id!).then((r) => r.feed) : api.saveCalendarFeed(mailboxId!, id!, level ?? "all", renew).then((r) => r.feed),
		onSuccess: (feed) => qc.setQueryData(["calendar-feed", mailboxId, id], feed),
	});
}

/** Brings a calendar from another website up to date now. */
export function useRefreshCalendar(mailboxId: string | undefined) {
	const qc = useQueryClient();
	const refresh = useRefresh(mailboxId);
	return useMutation({
		mutationFn: (id: string) => api.refreshCalendar(mailboxId!, id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: keys.calendars(mailboxId!) });
			refresh();
		},
	});
}

/** Imports an .ics file into one of your own calendars. */
export function useImportCalendar(mailboxId: string | undefined) {
	const refresh = useRefresh(mailboxId);
	return useMutation({
		mutationFn: ({ id, file }: { id: string; file: File }) => api.importCalendarFile(mailboxId!, id, file),
		onSuccess: refresh,
	});
}
