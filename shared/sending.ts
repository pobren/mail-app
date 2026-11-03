// Mail App addition (not part of upstream Agentic Inbox).
// Can this install send email to anyone? Receiving is free on Cloudflare, but sending to other people
// needs the Workers Paid plan ($5 a month) and the domain switched on for Email Sending. Without
// either, mail sits in Sent and never arrives, which looks like Mail App is broken. Admins see a card
// saying what to do until a sending check gets through.

/** "plan": the account needs Workers Paid. "domain": the domain isn't switched on for sending. */
export type SendingProblem = "plan" | "domain";

export interface SendingStatus {
	state: "ok" | "unknown" | SendingProblem;
	/** The address the last check or failed send came from. */
	from?: string;
	/** Cloudflare's own words for the last failure, for anyone who asks for help. */
	detail?: string;
	/** When we last tried a sending check (ISO time). */
	checkedAt?: string;
}

/** Cloudflare's plan page for the account the person signs in to. */
export const PLAN_URL = "https://dash.cloudflare.com/?to=/:account/workers/plans";

/** Subject of the check email a mailbox sends itself; it's the proof sending works. */
export const CHECK_SUBJECT = "Mail App can send email";

/**
 * What a failed send tells us about the setup, or null if it says nothing (a bad address, too many
 * recipients, a busy moment). Codes are the send_email binding's; the wording match is a fallback
 * for errors that come without a code.
 */
export function sendProblem(e: unknown): SendingProblem | null {
	const code = String((e as { code?: unknown })?.code ?? "");
	const message = String((e as { message?: unknown })?.message ?? e ?? "");
	if (code === "E_SENDER_NOT_VERIFIED" || code === "E_SENDER_DOMAIN_NOT_AVAILABLE") return "domain";
	if (code === "E_RECIPIENT_NOT_ALLOWED") return "plan";
	if (code) return null;
	if (/workers paid|paid plan|subscription|verified destination|destination address/i.test(message)) return "plan";
	if (/domain.*(not (verified|available|onboarded))|sender.*not verified/i.test(message)) return "domain";
	return null;
}

/**
 * The status after a sending check: it either got through, or it failed. A refusal from Cloudflare
 * that we can't name counts as the plan, the usual cause on a new account. A fault in Mail App itself
 * (a TypeError and the like) says nothing about the account, so it stays unknown and shows no card.
 */
export function afterCheck(from: string, at: string, error?: unknown): SendingStatus {
	if (error === undefined) return { state: "ok", from, checkedAt: at };
	const ours = error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError;
	return { state: sendProblem(error) ?? (ours ? "unknown" : "plan"), from, detail: errorText(error), checkedAt: at };
}

/**
 * The status after an everyday send. A failure that names a setup problem is recorded. A success
 * changes nothing: it may have gone to an address Cloudflare lets free accounts send to, so it
 * doesn't prove sending works for everyone. Returns null when nothing needs saving.
 */
export function afterSend(prev: SendingStatus, from: string, error?: unknown): SendingStatus | null {
	if (error === undefined) return null;
	const problem = sendProblem(error);
	if (!problem) return null;
	if (prev.state === problem && prev.detail === errorText(error)) return null;
	return { ...prev, state: problem, from, detail: errorText(error) };
}

/** True when it's time for another automatic sending check. "Check again" ignores this. */
export function checkDue(status: SendingStatus, now: number, everyMs = 10 * 60 * 1000): boolean {
	if (status.state === "ok") return false;
	if (!status.checkedAt) return true;
	const last = Date.parse(status.checkedAt);
	return !Number.isFinite(last) || now - last >= everyMs;
}

function errorText(e: unknown): string {
	const code = (e as { code?: unknown })?.code;
	const message = String((e as { message?: unknown })?.message ?? e ?? "");
	return (code ? `${code}: ${message}` : message).slice(0, 300);
}

/**
 * What to tell the person when Cloudflare won't send their email, in plain English. Codes are the
 * send_email binding's (developers.cloudflare.com/email-service/api/send-emails/workers-api/).
 * Anything we can't name is passed on in Cloudflare's own words.
 */
export function sendFailureText(e: unknown): string {
	const code = String((e as { code?: unknown })?.code ?? "");
	const message = String((e as { message?: unknown })?.message ?? e ?? "").trim();
	switch (code) {
		case "E_SENDER_NOT_VERIFIED":
		case "E_SENDER_DOMAIN_NOT_AVAILABLE":
			return "Not sent. Your domain isn't switched on for sending in Cloudflare yet. An admin can turn it on from the Mailboxes page.";
		case "E_RECIPIENT_NOT_ALLOWED":
			return "Not sent. Your Cloudflare account can only send to its own addresses until sending is switched on ($5 a month). An admin can turn it on from the Mailboxes page.";
		case "E_RECIPIENT_SUPPRESSED":
			return "Not sent. Cloudflare has stopped sending to one of these addresses because earlier emails to it bounced or were reported as spam. Check the address is right.";
		case "E_VALIDATION_ERROR":
		case "E_FIELD_MISSING":
			return "Not sent. One of the addresses doesn't look right. Check the To, Cc and Bcc lines.";
		case "E_TOO_MANY_RECIPIENTS":
			return "Not sent. An email can go to up to 50 people across To, Cc and Bcc.";
		case "E_TOO_MANY_ATTACHMENTS":
			return "Not sent. An email can carry up to 32 attachments.";
		case "E_RATE_LIMIT_EXCEEDED":
			return "Not sent. Cloudflare says too many emails have gone out in a short time. Try again in a few minutes.";
	}
	if (sendProblem(e) === "plan") return sendFailureText({ code: "E_RECIPIENT_NOT_ALLOWED" });
	if (sendProblem(e) === "domain") return sendFailureText({ code: "E_SENDER_DOMAIN_NOT_AVAILABLE" });
	const said = (code ? `${code}: ${message}` : message).slice(0, 200);
	return said
		? `Not sent. Cloudflare refused this email and said: "${said}". Try again, and if it keeps happening ask your admin.`
		: "Not sent. Cloudflare refused this email without saying why. Try again, and if it keeps happening ask your admin.";
}
