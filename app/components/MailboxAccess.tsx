// Mail App addition (not part of upstream Agentic Inbox).
// Settings > Account: who else can open this mailbox, and every time an admin opened it, so admin
// access is never hidden.
import { ShieldCheckIcon } from "@phosphor-icons/react";
import copy from "~/copy/people.en-GB.json";
import { fill } from "~/lib/attachments";
import { useMailboxAccess, useMe } from "~/queries/people";
import { FindBox, ShowMoreButton, shortList, useShowMore } from "~/components/ShowMore";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export default function MailboxAccess({ mailboxId }: { mailboxId: string }) {
	const { data } = useMailboxAccess(mailboxId);
	const { data: me } = useMe();
	const s = copy.settings;
	const logList = useShowMore(data?.log ?? [], { text: (l) => `${fill(s.actions[l.action], { by: l.byName, who: l.whoName ?? "" })} ${when(l.at)}` });
	if (!data) return null;
	const people = shortList(data.people.map((p) => (p.email === me?.email ? fill(s.you, { email: p.email }) : p.name)), 6);
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 text-sm font-medium text-kumo-default mb-3">
				<ShieldCheckIcon size={16} /> {s.title}
			</div>
			{people && <p className="text-sm text-kumo-default mb-3">{fill(s.people, { people })}</p>}
			<div className="text-xs font-medium uppercase tracking-wide text-kumo-subtle mb-1.5">{s.logTitle}</div>
			{data.log.length === 0 ? (
				<>
					<p className="text-sm text-kumo-subtle">{s.logEmpty}</p>
					<p className="mt-1 text-xs text-kumo-subtle">{s.logNote}</p>
				</>
			) : (<>
				<FindBox list={logList} label={s.find} className="mb-2" />
				<ul className="space-y-1 text-sm text-kumo-default">
					{logList.shown.map((l, i) => (
						<li key={i} className="flex flex-wrap justify-between gap-x-3">
							<span>{fill(s.actions[l.action], { by: l.byName, who: l.whoName ?? "" })}</span>
							<span className="text-xs text-kumo-subtle">{when(l.at)}</span>
						</li>
					))}
				</ul>
			</>)}
			<ShowMoreButton list={logList} className="mt-2" />
		</div>
	);
}
