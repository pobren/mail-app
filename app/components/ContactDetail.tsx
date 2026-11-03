// Mail App addition (not part of upstream Agentic Inbox).
// The right-hand side of the Contacts page on wider screens: the chosen person, with buttons to email or
// edit them, and the most recent emails to and from them. An email opens in a window over the page (EmailPreview).
import { Button, Loader } from "@cloudflare/kumo";
import { ArrowDownLeftIcon, ArrowUpRightIcon, MagnifyingGlassIcon, PaperPlaneTiltIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import ContactAvatar from "~/components/ContactAvatar";
import EmailPreview from "~/components/EmailPreview";
import copy from "~/copy/contacts.en-GB.json";
import { formatListDate } from "~/lib/utils";
import api from "~/services/api";
import type { Email } from "~/types";
import type { Contact } from "shared/contacts";

const RECENT = 8;

async function emailsWith(mailboxId: string, address: string): Promise<Email[]> {
	const one = async (field: "from" | "to") => {
		const data = await api.searchEmails(mailboxId, { [field]: address, limit: String(RECENT), page: "1" }) as { emails?: Email[] } | Email[];
		return Array.isArray(data) ? data : data?.emails ?? [];
	};
	const [from, to] = await Promise.all([one("from"), one("to")]);
	const seen = new Set<string>();
	return [...from, ...to]
		.filter((e) => !seen.has(e.id) && seen.add(e.id))
		.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
		.slice(0, RECENT);
}

export default function ContactDetail({ mailboxId, contact, photos, onWrite, onEdit }: {
	mailboxId: string;
	contact: Contact | null;
	photos: boolean;
	onWrite: (c: Contact) => void;
	onEdit: (c: Contact) => void;
}) {
	const { data: recent, isLoading } = useQuery({
		queryKey: ["contacts", mailboxId, "recent", contact?.email ?? ""],
		queryFn: () => emailsWith(mailboxId, contact!.email),
		enabled: !!contact,
		staleTime: 60_000,
	});
	const [reading, setReading] = useState<Email | null>(null);

	if (!contact) {
		return <p className="p-8 text-base text-kumo-subtle">{copy.pickOne}</p>;
	}
	const sentLine = contact.sent
		? `${contact.sent === 1 ? copy.sentOne : copy.sentMany.replace("{count}", String(contact.sent))}${contact.lastSent ? `, ${copy.lastSent.replace("{date}", new Date(contact.lastSent).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))}` : ""}`
		: copy.neverSent;

	return (
		<div className="mx-auto max-w-2xl px-8 py-8">
			<div className="flex items-center gap-5">
				<ContactAvatar email={contact.email} name={contact.name} photos={photos} size={80} />
				<div className="min-w-0">
					<h2 className="truncate text-2xl font-semibold text-kumo-default">{contact.name || contact.email}</h2>
					{contact.name && <p className="truncate text-base text-kumo-strong">{contact.email}</p>}
					<p className="mt-1 text-sm text-kumo-subtle">{sentLine}</p>
				</div>
			</div>
			<div className="mt-5 flex flex-wrap gap-2">
				<Button variant="primary" icon={<PaperPlaneTiltIcon size={16} />} onClick={() => onWrite(contact)}>{copy.write}</Button>
				<Button variant="secondary" icon={<PencilSimpleIcon size={16} />} onClick={() => onEdit(contact)}>{copy.edit}</Button>
			</div>
			{contact.notes && (
				<section className="mt-6">
					<h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-kumo-strong">{copy.notesTitle}</h3>
					<p className="whitespace-pre-wrap text-base text-kumo-default">{contact.notes}</p>
				</section>
			)}
			<section className="mt-8">
				<div className="mb-2 flex items-center justify-between gap-3">
					<h3 className="text-sm font-semibold uppercase tracking-wide text-kumo-strong">{copy.recent}</h3>
					<Link to={`/mailbox/${encodeURIComponent(mailboxId)}/search?q=${encodeURIComponent(contact.email)}`}
						className="flex items-center gap-1 text-sm font-medium text-kumo-strong hover:text-kumo-default">
						<MagnifyingGlassIcon size={14} />{copy.seeAll}
					</Link>
				</div>
				{isLoading ? (
					<div className="flex justify-center py-8"><Loader /></div>
				) : !recent?.length ? (
					<p className="text-base text-kumo-subtle">{copy.noRecent}</p>
				) : (
					<ul className="divide-y divide-kumo-line rounded-lg border border-kumo-line bg-kumo-base">
						{recent.map((e) => {
							const fromThem = e.sender.toLowerCase() === contact.email;
							return (
								<li key={e.id}>
									<button type="button" onClick={() => setReading(e)}
										className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left hover:bg-kumo-tint">
										<span className="shrink-0 text-kumo-subtle" title={fromThem ? copy.fromThem : copy.fromYou}>
											{fromThem ? <ArrowDownLeftIcon size={16} /> : <ArrowUpRightIcon size={16} />}
										</span>
										<span className="min-w-0 flex-1 truncate text-base text-kumo-default">{e.subject || copy.noSubject}</span>
										<span className="shrink-0 text-sm text-kumo-subtle">{formatListDate(e.date)}</span>
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</section>
			{reading && <EmailPreview mailboxId={mailboxId} emailId={reading.id} folderId={reading.folder_id || "inbox"} onClose={() => setReading(null)} />}
		</div>
	);
}
