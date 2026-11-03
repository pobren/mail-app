// Mail App addition (not part of upstream Agentic Inbox).
// All inboxes: the newest conversations from every mailbox you can open, in one list, each marked with
// the mailbox it's in. Opening one takes you to it in its own mailbox, where you reply as usual.
import { Badge } from "@cloudflare/kumo";
import { TrayIcon } from "@phosphor-icons/react";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { Folders } from "shared/folders";
import { formatListDate } from "shared/dates";
import { getSnippetText } from "~/lib/utils";
import { useMailboxes } from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";
import type { Email, Mailbox } from "~/types";
import { mailboxLabel } from "~/components/Sidebar";
import copy from "~/copy/mailboxes.en-GB.json";

/** Conversations taken from each mailbox; the list shows the newest of them all. */
const PER_MAILBOX = 50;

interface Row { email: Email; mailbox: Mailbox }

export default function AllInboxesRoute() {
	const navigate = useNavigate();
	const { data: all = [] } = useMailboxes();
	const mine = useMemo(() => all.filter((m) => m.canOpen !== false), [all]);
	const params = { folder: Folders.INBOX, page: "1", limit: String(PER_MAILBOX), threaded: "true" };
	const lists = useQueries({
		queries: mine.map((m) => ({
			queryKey: queryKeys.emails.list(m.id, params),
			queryFn: async () => {
				const data = await api.listEmails(m.id, params);
				return Array.isArray(data) ? { emails: data, totalCount: data.length } : (data as { emails: Email[]; totalCount: number });
			},
			refetchInterval: 60_000,
		})),
	});
	const details = useQueries({
		queries: mine.map((m) => ({
			queryKey: queryKeys.mailboxes.detail(m.id),
			queryFn: () => api.getMailbox(m.id) as Promise<Mailbox>,
			staleTime: 5 * 60_000,
		})),
	});

	const loading = mine.length === 0 || lists.some((l) => l.isLoading);
	const rows: Row[] = useMemo(() => {
		const out: Row[] = [];
		lists.forEach((l, i) => {
			const mailbox = details[i]?.data ?? mine[i];
			for (const email of l.data?.emails ?? []) out.push({ email, mailbox });
		});
		return out.sort((a, b) => (b.email.date ?? "").localeCompare(a.email.date ?? ""));
	}, [lists, details, mine]);

	const unread = (e: Email) => (e.thread_unread_count !== undefined ? e.thread_unread_count > 0 : !e.read);
	const who = (e: Email) => {
		const names = (e.participants ?? e.sender_name ?? e.sender).split(",").map((p) => p.trim().split("@")[0]).filter((n, i, a) => n && a.indexOf(n) === i);
		return names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2 px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5 min-h-[61px]">
				<h1 className="text-lg font-semibold text-kumo-default">{copy.allInboxes}</h1>
				<span className="ml-auto text-sm text-kumo-subtle hidden sm:inline">{copy.allInboxesHint}</span>
			</div>
			<div className="flex-1 overflow-y-auto">
				{loading && rows.length === 0 ? (
					<p className="p-6 text-sm text-kumo-subtle">{copy.loading}</p>
				) : rows.length === 0 ? (
					<div className="flex flex-col items-center gap-2 p-12 text-center">
						<TrayIcon size={48} weight="thin" className="text-kumo-subtle" />
						<p className="text-sm font-medium text-kumo-default">{copy.allEmpty}</p>
					</div>
				) : (
					rows.map(({ email, mailbox }) => {
						const snippet = getSnippetText(email.snippet);
						return (
							<button
								key={`${mailbox.id}/${email.id}`}
								type="button"
								onClick={() => navigate(`/mailbox/${encodeURIComponent(mailbox.id)}/emails/inbox?open=${encodeURIComponent(email.id)}`)}
								className="flex w-full items-start gap-3 border-b border-kumo-line px-4 py-3 text-left hover:bg-kumo-tint md:px-5 cursor-pointer bg-transparent"
							>
								<span className={`mt-1.5 size-2 shrink-0 rounded-full ${unread(email) ? "bg-kumo-brand" : ""}`} />
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className={`truncate text-sm ${unread(email) ? "font-semibold text-kumo-default" : "text-kumo-strong"}`}>{who(email)}</span>
										{(email.thread_count ?? 1) > 1 && (
											<span className="shrink-0 text-xs text-kumo-subtle bg-kumo-fill rounded-full px-1.5 py-0.5 font-medium">{email.thread_count}</span>
										)}
										<Badge variant="outline">{mailboxLabel(mailbox)}</Badge>
										<span className="text-sm text-kumo-subtle shrink-0 ml-auto">{formatListDate(email.date)}</span>
									</div>
									<div className="truncate text-sm mt-0.5">
										<span className={unread(email) ? "font-medium text-kumo-default" : "text-kumo-subtle"}>{email.subject}</span>
										{snippet && <span className="text-kumo-subtle"> &mdash; {snippet}</span>}
									</div>
								</div>
							</button>
						);
					})
				)}
			</div>
		</div>
	);
}
