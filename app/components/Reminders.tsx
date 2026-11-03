// Mail App: Snooze and "Remind me if no reply". The Snooze box (quick times, or a date and time of
// your own), the Remind me menu for an email already sent, and the note at the top of an open email
// that's snoozed, waiting for a reply or back because nobody replied. Words are in
// app/copy/reminders.en-GB.json; how it works is in shared/reminders.ts.

import { Button, Dialog, DropdownMenu, Input, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import { BellRingingIcon, BellSimpleIcon, BellSimpleSlashIcon, CalendarBlankIcon, CalendarDotsIcon, ClockIcon, SunHorizonIcon, SunIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Folders } from "shared/folders";
import { NO_REPLY_DAYS, formatWhen, noReplyDueAt, snoozeChoices, validDueAt, type SnoozeChoice } from "shared/reminders";
import copy from "~/copy/reminders.en-GB.json";
import { fill } from "~/lib/attachments";
import { useReminder, useSnooze, useUnsnooze } from "~/queries/emails";
import type { Email } from "~/types";

const CHOICE_ICONS: Record<SnoozeChoice["id"], React.ReactNode> = {
	later: <ClockIcon size={18} />,
	tomorrow: <SunHorizonIcon size={18} />,
	weekend: <SunIcon size={18} />,
	"next-week": <CalendarBlankIcon size={18} />,
};

/** The time beside a quick snooze choice: "15:30" later today, otherwise "Sat 08:00". */
const choiceTime = (c: SnoozeChoice) =>
	c.at.toLocaleString("en-GB", { ...(c.id === "later" ? {} : { weekday: "short" }), hour: "2-digit", minute: "2-digit" }).replace(",", "");

/** "1 day", "1 week": for the Remind me choices. */
export const dayWords = (days: number) => (copy.days as Record<string, string>)[String(days)] ?? `${days} days`;

/** The value for a datetime-local box: local time, to the minute. */
function localInput(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The Snooze box. `ids` are the conversations' messages as shown in the list. */
export function SnoozeDialog({ mailboxId, ids, fromFolder, onClose, onSnoozed }: {
	mailboxId: string;
	ids: string[];
	fromFolder?: string;
	onClose: () => void;
	onSnoozed?: () => void;
}) {
	const snooze = useSnooze();
	const toast = useKumoToastManager();
	const choices = useMemo(() => snoozeChoices(), []);
	const [picking, setPicking] = useState(false);
	const [picked, setPicked] = useState(() => localInput(choices.find((c) => c.id === "tomorrow")!.at));
	const [problem, setProblem] = useState<string | null>(null);

	const go = (at: number) => {
		if (!validDueAt(at)) return setProblem(copy.pickBad);
		snooze.mutate({ mailboxId, ids, until: at, fromFolder }, {
			onSuccess: () => {
				const when = formatWhen(at);
				toast.add({ title: ids.length > 1 ? fill(copy.snoozedMany, { count: ids.length, when }) : fill(copy.snoozed, { when }) });
				onSnoozed?.();
				onClose();
			},
			onError: (e) => setProblem((e as Error)?.message || copy.failed),
		});
	};

	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="mb-1 text-lg font-semibold">
					{ids.length > 1 ? fill(copy.snoozeTitleMany, { count: ids.length }) : copy.snoozeTitle}
				</Dialog.Title>
				<Dialog.Description className="mb-4 text-sm text-kumo-subtle">{copy.snoozeIntro}</Dialog.Description>
				<div className="-mx-2 mb-3 flex flex-col">
					{choices.map((c) => (
						<button
							key={c.id}
							type="button"
							disabled={snooze.isPending}
							onClick={() => go(c.at.getTime())}
							className="flex items-center gap-3 rounded-lg border-0 bg-transparent px-2 py-2.5 text-left text-base text-kumo-default hover:bg-kumo-tint cursor-pointer disabled:opacity-50"
						>
							<span className="text-kumo-subtle">{CHOICE_ICONS[c.id]}</span>
							<span className="flex-1 font-medium">{copy.choices[c.id]}</span>
							<span className="text-sm text-kumo-subtle">{choiceTime(c)}</span>
						</button>
					))}
					<button
						type="button"
						onClick={() => setPicking((p) => !p)}
						aria-expanded={picking}
						className="flex items-center gap-3 rounded-lg border-0 bg-transparent px-2 py-2.5 text-left text-base text-kumo-default hover:bg-kumo-tint cursor-pointer"
					>
						<span className="text-kumo-subtle"><CalendarDotsIcon size={18} /></span>
						<span className="flex-1 font-medium">{copy.pick}</span>
					</button>
				</div>
				{picking && (
					<div className="mb-3 flex items-end gap-2">
						<div className="flex-1">
							<Input label={copy.pickLabel} type="datetime-local" value={picked} min={localInput(new Date())}
								onChange={(e) => { setPicked(e.target.value); setProblem(null); }} />
						</div>
						<Button variant="primary" loading={snooze.isPending} onClick={() => go(new Date(picked).getTime())}>{copy.pickButton}</Button>
					</div>
				)}
				{problem && <p role="alert" className="mb-3 text-sm text-kumo-danger">{problem}</p>}
				<div className="flex justify-end">
					<Dialog.Close render={(props) => <Button {...props} variant="secondary">{copy.cancel}</Button>} />
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

/** The bell on an email you sent: "Remind me if no reply" in 1, 2 or 3 days or a week, or cancel it. */
export function RemindMenu({ mailboxId, email }: { mailboxId: string; email: Email }) {
	const reminder = useReminder();
	const toast = useKumoToastManager();
	const pending = email.reminders?.find((r) => r.kind === "no-reply" && !r.shown);
	const set = (days: number) => {
		const at = noReplyDueAt(days);
		reminder.mutate({ mailboxId, emailId: email.id, at }, {
			onSuccess: () => toast.add({ title: fill(copy.remindSet, { when: formatWhen(at) }) }),
			onError: () => toast.add({ title: copy.failed, variant: "error" }),
		});
	};
	return (
		<DropdownMenu>
			<Tooltip content={copy.remind} side="bottom" asChild>
				<DropdownMenu.Trigger>
					<Button variant="ghost" shape="square" size="sm" aria-label={copy.remind}
						icon={pending ? <BellRingingIcon size={18} weight="fill" className="text-kumo-brand" /> : <BellSimpleIcon size={18} />} />
				</DropdownMenu.Trigger>
			</Tooltip>
			<DropdownMenu.Content>
				<div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle">{copy.remind}</div>
				{NO_REPLY_DAYS.map((d) => (
					<DropdownMenu.Item key={d} onClick={() => set(d)}>{fill(copy.remindDays, { days: dayWords(d) })}</DropdownMenu.Item>
				))}
				{pending && (<>
					<DropdownMenu.Separator />
					<DropdownMenu.Item icon={BellSimpleSlashIcon} onClick={() => reminder.mutate({ mailboxId, emailId: email.id, at: null }, {
						onSuccess: () => toast.add({ title: copy.remindCancelled }),
					})}>{copy.remindCancel}</DropdownMenu.Item>
				</>)}
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}

/**
 * The note at the top of an open email: snoozed until when (Unsnooze), waiting for a reply (Cancel
 * reminder), or back because nobody replied (Done). `folder` is the folder being looked at.
 */
export function ReminderNote({ mailboxId, email, folder, onDone }: { mailboxId: string; email: Email; folder?: string; onDone?: () => void }) {
	const reminder = useReminder();
	const unsnooze = useUnsnooze();
	const toast = useKumoToastManager();
	const snoozed = email.reminders?.find((r) => r.kind === "snooze");
	const noReply = email.reminders?.find((r) => r.kind === "no-reply");
	const failed = () => toast.add({ title: copy.failed, variant: "error" });

	if (snoozed && folder === Folders.SNOOZED) {
		return (
			<Note icon={<ClockIcon size={16} weight="bold" />} text={fill(copy.snoozedNote, { when: formatWhen(snoozed.due_at) })}>
				<Button variant="secondary" size="sm" loading={unsnooze.isPending} onClick={() => unsnooze.mutate({ mailboxId, ids: [email.id] }, {
					onSuccess: () => { toast.add({ title: copy.unsnoozed }); onDone?.(); },
					onError: failed,
				})}>{copy.unsnooze}</Button>
			</Note>
		);
	}
	if (noReply?.shown) {
		return (
			<Note tone="amber" icon={<BellRingingIcon size={16} weight="bold" />} text={copy.noReplyNote}>
				<Button variant="secondary" size="sm" loading={reminder.isPending} onClick={() => reminder.mutate({ mailboxId, emailId: email.id, at: null }, {
					onSuccess: () => { toast.add({ title: copy.doneToast }); if (folder === Folders.INBOX) onDone?.(); },
					onError: failed,
				})}>{copy.done}</Button>
			</Note>
		);
	}
	if (noReply) {
		return (
			<Note icon={<BellSimpleIcon size={16} weight="bold" />} text={fill(copy.remindPending, { when: formatWhen(noReply.due_at) })}>
				<Button variant="ghost" size="sm" loading={reminder.isPending} onClick={() => reminder.mutate({ mailboxId, emailId: email.id, at: null }, {
					onSuccess: () => toast.add({ title: copy.remindCancelled }),
					onError: failed,
				})}>{copy.remindCancel}</Button>
			</Note>
		);
	}
	return null;
}

function Note({ icon, text, tone = "blue", children }: { icon: React.ReactNode; text: string; tone?: "blue" | "amber"; children?: React.ReactNode }) {
	const colours = tone === "amber"
		? "bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950/40 dark:text-amber-100 dark:border-amber-900"
		: "bg-sky-50 text-sky-900 border-sky-200 dark:bg-sky-950/40 dark:text-sky-100 dark:border-sky-900";
	return (
		<div className={`mx-3 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 text-sm md:mx-4 ${colours}`} role="status">
			<span className="shrink-0">{icon}</span>
			<span className="min-w-0 flex-1">{text}</span>
			{children}
		</div>
	);
}
