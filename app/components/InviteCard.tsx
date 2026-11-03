// Mail App addition (not part of upstream Agentic Inbox).
// The card at the top of an email that carries a calendar invite: what, when and who, a Join button for
// a video call, and Yes / Maybe / No. Answering puts it in the calendar and tells whoever sent it.
// Also shows cancellations, and guests' answers to our own invites.

import { Button, useKumoToastManager } from "@cloudflare/kumo";
import { CalendarBlankIcon, CalendarXIcon, CheckIcon, VideoCameraIcon } from "@phosphor-icons/react";
import { Link } from "react-router";
import type { GuestStatus } from "shared/calendar";
import { joinWords } from "shared/invites";
import { browserTimeZone } from "~/components/calendar/EventDialog";
import copy from "~/copy/calendar.en-GB.json";
import { problemOf, useAnswerInvite, useEmailInvite } from "~/queries/calendar";
import type { Attachment } from "~/types";

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ""));
const words = copy.invite;

/** Does this email carry an invite? (An .ics file, or a calendar part.) */
export function hasInvite(attachments: Attachment[] | undefined): boolean {
	return !!attachments?.some((a) => /^(text\/calendar|application\/ics)/i.test(a.mimetype ?? "") || /\.ics$/i.test(a.filename ?? ""));
}

export default function InviteCard({ mailboxId, emailId, attachments, className = "" }: {
	mailboxId?: string;
	emailId: string;
	attachments?: Attachment[];
	className?: string;
}) {
	const tz = browserTimeZone();
	const show = hasInvite(attachments);
	const { data } = useEmailInvite(mailboxId, emailId, show, tz);
	const answer = useAnswerInvite(mailboxId, emailId, tz);
	const toast = useKumoToastManager();
	const invite = data?.invite;
	if (!show || !invite || !mailboxId) return null;

	const from = invite.organizer?.name || invite.organizer?.email || "";
	const choose = (a: GuestStatus | "remove") => answer.mutate(a, {
		onSuccess: (r) => {
			if (a === "remove") toast.add({ title: words.removed });
			else if (r.problem) toast.add({ title: fill(words.notSent, { problem: r.problem }), variant: "error" });
			else if (from) toast.add({ title: fill(words.sent, { name: from }) });
		},
		onError: (err) => toast.add({ title: problemOf(err, words.failed), variant: "error" }),
	});
	const status = answer.isPending ? null : invite.myStatus;
	const calendarLink = `/mailbox/${encodeURIComponent(mailboxId)}/calendar?date=${invite.start.slice(0, 10)}`;
	const guests = invite.guests.length;

	let footer: React.ReactNode;
	if (invite.method === "REPLY" && invite.answer) {
		footer = <p className="text-base font-medium text-kumo-default">{fill(words.answer[invite.answer.status], { name: invite.answer.name || invite.answer.email })}</p>;
	} else if (invite.cancelled) {
		footer = (
			<div className="flex flex-wrap items-center gap-3">
				<p className="flex items-center gap-1.5 text-base font-medium text-kumo-danger"><CalendarXIcon size={18} /> {words.cancelled}</p>
				{invite.inCalendar && !invite.ours && (
					<Button variant="secondary" size="sm" loading={answer.isPending} onClick={() => choose("remove")}>{words.removeFromCalendar}</Button>
				)}
			</div>
		);
	} else if (invite.ours) {
		footer = <p className="text-sm text-kumo-strong">{words.ours}</p>;
	} else if (invite.outdated) {
		footer = <p className="text-sm text-kumo-strong">{words.outdated}</p>;
	} else {
		footer = (
			<div className="space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<span className="mr-1 text-base font-medium text-kumo-default">{words.going}</span>
					{([["accepted", words.yes], ["tentative", words.maybe], ["declined", words.no]] as [GuestStatus, string][]).map(([key, label]) => (
						<Button key={key} size="sm" variant={status === key ? "primary" : "secondary"} aria-pressed={status === key}
							icon={status === key ? <CheckIcon size={14} weight="bold" /> : undefined}
							disabled={answer.isPending} onClick={() => status !== key && choose(key)}>
							{label}
						</Button>
					))}
				</div>
				{status && status !== "needs-action" && <p className="text-sm text-kumo-strong">{words.answered[status]}</p>}
			</div>
		);
	}

	return (
		<section aria-label={words.title} className={`rounded-xl border border-kumo-line bg-kumo-base p-4 ${className}`}>
			<div className="flex items-start gap-3">
				<div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-kumo-tint text-kumo-brand">
					<CalendarBlankIcon size={24} />
				</div>
				<div className="min-w-0 flex-1 space-y-1">
					<p className="text-xs font-semibold uppercase tracking-wide text-kumo-strong">{words.title}</p>
					<h3 className={`text-lg font-semibold text-kumo-default ${invite.cancelled ? "line-through" : ""}`}>{invite.title}</h3>
					<p className="text-base text-kumo-default">{invite.when}</p>
					{invite.repeats && <p className="text-sm text-kumo-strong">{words.repeats}</p>}
					{invite.oneDate && <p className="text-sm text-kumo-strong">{words.oneDate}</p>}
					{invite.location && <p className="text-base text-kumo-strong">{invite.location}</p>}
					<p className="text-sm text-kumo-strong">
						{[from && fill(words.from, { name: from }), guests > 0 && (guests === 1 ? words.oneGuest : fill(words.guests, { n: guests }))].filter(Boolean).join(" · ")}
					</p>
				</div>
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-2">
				{invite.meetingUrl && !invite.cancelled && (
					<a href={invite.meetingUrl} target="_blank" rel="noopener noreferrer"
						className="inline-flex items-center gap-1.5 rounded-lg bg-kumo-brand px-3 py-1.5 text-sm font-medium text-white no-underline hover:opacity-90">
						<VideoCameraIcon size={16} weight="fill" /> {joinWords(invite.meetingUrl)}
					</a>
				)}
				{invite.inCalendar && (
					<Link to={calendarLink} className="text-sm font-medium text-kumo-strong underline-offset-2 hover:underline">{words.openCalendar}</Link>
				)}
			</div>
			<div className="mt-3 border-t border-kumo-line pt-3">{footer}</div>
		</section>
	);
}
