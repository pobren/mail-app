// Mail App addition (not part of upstream Agentic Inbox).
// How much one mailbox can send. Counted in recipients, not emails, and kept in its own log
// (send_log in the mailbox's storage), so emptying Sent doesn't reset it and one email to hundreds
// of people can't get round it. Calendar invites count too.

export const SEND_LIMITS = { perEmail: 50, perHour: 50, perDay: 200 };

/** How many people an email goes to: every address in to, cc and bcc (strings may hold several, comma separated). */
export function countRecipients(...lists: (string | string[] | null | undefined)[]): number {
	let n = 0;
	for (const list of lists) {
		if (!list) continue;
		for (const part of Array.isArray(list) ? list : [list]) n += String(part).split(",").filter((a) => a.trim()).length;
	}
	return n;
}

/** Why this send would go over the limit, or null when it's fine. */
export function sendLimitError(recipients: number, sentLastHour: number, sentLastDay: number): string | null {
	if (recipients > SEND_LIMITS.perEmail) return `One email can go to at most ${SEND_LIMITS.perEmail} people. Split it into smaller groups.`;
	if (sentLastHour + recipients > SEND_LIMITS.perHour) return `Sending limit reached: this mailbox can email ${SEND_LIMITS.perHour} people an hour. Please try again later.`;
	if (sentLastDay + recipients > SEND_LIMITS.perDay) return `Sending limit reached: this mailbox can email ${SEND_LIMITS.perDay} people a day. Please try again tomorrow.`;
	return null;
}
