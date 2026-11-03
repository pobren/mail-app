// Mail App: scheduled send. The box for choosing when an email goes (quick times, or a date and time of
// your own), and the note at the top of an email waiting in Scheduled (Send now, Change time, Cancel
// send). Words are in app/copy/scheduled.en-GB.json; how it works is in shared/scheduled.ts.

import { Button, Dialog, Input, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowUUpLeftIcon, CalendarBlankIcon, CalendarDotsIcon, ClockIcon, ClockCountdownIcon, PaperPlaneTiltIcon, SunHorizonIcon, SunIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { formatWhen, snoozeChoices, type SnoozeChoice } from "shared/reminders";
import { validSendAt } from "shared/scheduled";
import copy from "~/copy/scheduled.en-GB.json";
import { fill } from "~/lib/attachments";
import { useReschedule } from "~/queries/emails";
import type { Email } from "~/types";

const CHOICE_ICONS: Record<SnoozeChoice["id"], React.ReactNode> = {
	later: <ClockIcon size={18} />,
	tomorrow: <SunHorizonIcon size={18} />,
	weekend: <SunIcon size={18} />,
	"next-week": <CalendarBlankIcon size={18} />,
};

const choiceTime = (c: SnoozeChoice) =>
	c.at.toLocaleString("en-GB", { ...(c.id === "later" ? {} : { weekday: "short" }), hour: "2-digit", minute: "2-digit" }).replace(",", "");

function localInput(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Choosing when an email goes. `onPick` gets the time in ms; `busy` while it's being saved. */
export function ScheduleDialog({ title = copy.title, button = copy.pickButton, initial, busy, problem: outside, onPick, onClose }: {
	title?: string;
	button?: string;
	initial?: number | null;
	busy?: boolean;
	problem?: string | null;
	onPick: (at: number) => void;
	onClose: () => void;
}) {
	// "Saturday morning" is left out on Fridays after 6pm and at weekends, as for snoozing. On a Sunday,
	// tomorrow morning is Monday morning, so it's only offered once.
	const choices = useMemo(() => snoozeChoices().filter((c, i, all) => all.findIndex((x) => x.at.getTime() === c.at.getTime()) === i), []);
	const [picking, setPicking] = useState(!!initial);
	const [picked, setPicked] = useState(() => localInput(initial ? new Date(initial) : choices.find((c) => c.id === "tomorrow")!.at));
	const [problem, setProblem] = useState<string | null>(null);

	const go = (at: number) => {
		if (!validSendAt(at)) return setProblem(copy.pickBad);
		setProblem(null);
		onPick(at);
	};

	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="mb-1 text-lg font-semibold">{title}</Dialog.Title>
				<Dialog.Description className="mb-4 text-sm text-kumo-subtle">{copy.intro}</Dialog.Description>
				<div className="-mx-2 mb-3 flex flex-col">
					{choices.map((c) => (
						<button key={c.id} type="button" disabled={busy} onClick={() => go(c.at.getTime())}
							className="flex cursor-pointer items-center gap-3 rounded-lg border-0 bg-transparent px-2 py-2.5 text-left text-base text-kumo-default hover:bg-kumo-tint disabled:opacity-50">
							<span className="text-kumo-subtle">{CHOICE_ICONS[c.id]}</span>
							<span className="flex-1 font-medium">{copy.choices[c.id]}</span>
							<span className="text-sm text-kumo-subtle">{choiceTime(c)}</span>
						</button>
					))}
					<button type="button" onClick={() => setPicking((p) => !p)} aria-expanded={picking}
						className="flex cursor-pointer items-center gap-3 rounded-lg border-0 bg-transparent px-2 py-2.5 text-left text-base text-kumo-default hover:bg-kumo-tint">
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
						<Button variant="primary" loading={busy} icon={<ClockCountdownIcon size={16} />} onClick={() => go(new Date(picked).getTime())}>{button}</Button>
					</div>
				)}
				{(problem || outside) && <p role="alert" className="mb-3 text-sm text-kumo-danger">{problem || outside}</p>}
				<div className="flex justify-end">
					<Dialog.Close render={(props) => <Button {...props} variant="secondary">{copy.cancel}</Button>} />
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

/** The note at the top of an email waiting in Scheduled. `onDone` when it has left the folder. */
export function ScheduledNote({ mailboxId, email, onDone }: { mailboxId: string; email: Email; onDone?: () => void }) {
	const change = useReschedule();
	const toast = useKumoToastManager();
	const [changing, setChanging] = useState(false);
	if (!email.send_at) return null;
	const failed = (e: unknown) => toast.add({ title: (e as { body?: { error?: string } }).body?.error || copy.failed, variant: "error" });
	const act = (at: number | "now" | null, done: string, leaves: boolean) => change.mutate({ mailboxId, emailId: email.id, at }, {
		onSuccess: () => { toast.add({ title: done }); setChanging(false); if (leaves) onDone?.(); },
		onError: failed,
	});
	return (
		<div className="mx-3 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-900 md:mx-4 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100" role="status">
			<span className="shrink-0"><ClockCountdownIcon size={16} weight="bold" /></span>
			<span className="min-w-0 flex-1">{fill(copy.note, { when: formatWhen(email.send_at) })}</span>
			<div className="flex flex-wrap gap-2">
				<Button variant="primary" size="sm" icon={<PaperPlaneTiltIcon size={14} />} disabled={change.isPending} onClick={() => act("now", copy.sentNow, true)}>{copy.sendNow}</Button>
				<Button variant="secondary" size="sm" icon={<ClockIcon size={14} />} disabled={change.isPending} onClick={() => setChanging(true)}>{copy.changeButton}</Button>
				<Button variant="secondary" size="sm" icon={<ArrowUUpLeftIcon size={14} />} disabled={change.isPending} onClick={() => act(null, copy.unscheduled, true)}>{copy.unschedule}</Button>
			</div>
			{changing && (
				<ScheduleDialog title={copy.changeTitle} button={copy.changeButton} initial={email.send_at} busy={change.isPending}
					onPick={(at) => act(at, fill(copy.changed, { when: formatWhen(at) }), false)} onClose={() => setChanging(false)} />
			)}
		</div>
	);
}
