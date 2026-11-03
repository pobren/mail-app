// Mail App addition (not part of upstream Agentic Inbox).
// Out of office: when to send an automatic reply, and to whom. Follows RFC 3834: never reply to
// automatic mail, mailing lists or bounces, and reply to each person at most once every few days.

export interface AutoReplySettings {
	enabled: boolean;
	/** Older settings files have a subject; replies now always use "Automatic reply: <subject>". */
	subject?: string;
	message: string;
	/** ISO times. Missing means "from now" and "until I switch it off". */
	start?: string;
	end?: string;
}

/** Each person gets at most one automatic reply in this many days. */
export const AUTO_REPLY_GAP_DAYS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

const time = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/** True when out of office is switched on, has a message, and `now` is inside its dates. */
export function autoReplyActive(s: AutoReplySettings | undefined, now: Date): boolean {
	if (!s?.enabled || !s.message?.trim()) return false;
	const start = time(s.start);
	const end = time(s.end);
	if (!Number.isNaN(start) && now.getTime() < start) return false;
	if (!Number.isNaN(end) && now.getTime() >= end) return false;
	return true;
}

/** "scheduled" before the start, "on" during, "ended" after the end, "off" when switched off. */
export function autoReplyState(s: AutoReplySettings | undefined, now: Date): "off" | "scheduled" | "on" | "ended" {
	if (!s?.enabled || !s.message?.trim()) return "off";
	if (now.getTime() < time(s.start)) return "scheduled";
	if (now.getTime() >= time(s.end)) return "ended";
	return "on";
}

const NO_REPLY_SENDER = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounces?)([-+._@]|$)/i;

/**
 * False for mail that must never get an automatic reply: from the mailbox itself, from no-reply and
 * bounce addresses, and anything marked as automatic, bulk or from a mailing list.
 */
export function shouldAutoReply(sender: string, mailbox: string, headers: { key: string; value: string }[]): boolean {
	const from = sender.trim().toLowerCase();
	if (!from.includes("@") || from === mailbox.trim().toLowerCase()) return false;
	if (NO_REPLY_SENDER.test(from)) return false;
	for (const { key, value } of headers) {
		const k = key.toLowerCase();
		const v = (value || "").trim().toLowerCase();
		if (k === "auto-submitted" && v && v !== "no") return false;
		if (k === "precedence" && /^(bulk|list|junk|auto_reply)/.test(v)) return false;
		if (k === "list-id" || k === "list-unsubscribe" || k === "list-post") return false;
		if (k === "x-auto-response-suppress" && /\b(all|oof|autoreply)\b/.test(v)) return false;
		if (k === "x-autoreply" || k === "x-autorespond" || k === "x-autoresponse") return false;
	}
	return true;
}

/**
 * True when `sender` hasn't had an automatic reply in the last few days, nor since this out of office
 * started (so a new holiday tells people again).
 */
export function dueForAutoReply(lastSent: string | undefined, s: AutoReplySettings, now: Date): boolean {
	const last = time(lastSent);
	if (Number.isNaN(last)) return true;
	if (now.getTime() - last >= AUTO_REPLY_GAP_DAYS * DAY_MS) return true;
	const start = time(s.start);
	return !Number.isNaN(start) && last < start;
}

/** Drops records older than the gap, so the list stays small. */
export function pruneAutoReplyLog(log: Record<string, string>, now: Date): Record<string, string> {
	const keep: Record<string, string> = {};
	for (const [sender, at] of Object.entries(log)) {
		if (now.getTime() - time(at) < AUTO_REPLY_GAP_DAYS * DAY_MS) keep[sender] = at;
	}
	return keep;
}

export function autoReplySubject(original: string): string {
	const subject = original.trim();
	return subject ? `Automatic reply: ${subject}` : "Automatic reply";
}
