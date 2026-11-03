// Mail App addition (not part of upstream Agentic Inbox).
// Scheduled send: an email written now and sent at a time chosen in the composer. It waits in the
// Scheduled folder; the mailbox's alarm sends it when it's due (workers/durableObject/scheduled.ts).
// It can be sent straight away, given another time, or taken back to Drafts until then.

/** The furthest ahead an email can be scheduled. */
export const MAX_SCHEDULE_AHEAD_MS = 366 * 86_400_000;

/** Sooner than this isn't worth scheduling: it may already have passed by the time it's saved. */
export const MIN_SCHEDULE_AHEAD_MS = 60_000;

/** An email that was due this long ago (the install was locked, or the alarm held up) still goes. */
export const SEND_LATE_MS = 7 * 86_400_000;

/** Whether `at` is a time an email can be scheduled for. */
export function validSendAt(at: unknown, now = Date.now()): at is number {
	return typeof at === "number" && Number.isFinite(at) && at >= now + MIN_SCHEDULE_AHEAD_MS && at <= now + MAX_SCHEDULE_AHEAD_MS;
}

/** Where the email's sending details (with its attachments) wait in R2 until it goes. */
export const scheduledKey = (mailbox: string, emailId: string) => `scheduled/${mailbox.toLowerCase()}/${emailId}.json`;

/** What the person is told when a scheduled email couldn't go, in a notification. */
export function failedWords(subject: string, reason: string): { title: string; body: string } {
	const s = subject.trim() || "(no subject)";
	return { title: "A scheduled email wasn't sent", body: `“${s.slice(0, 80)}”: ${reason} It's in Drafts.` };
}
