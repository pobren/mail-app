// Mail App addition (not part of upstream Agentic Inbox).
// The Contacts page: everyone you've emailed, plus people you've added or imported, with names and notes.
// On wider screens the chosen person's details and recent emails fill the right-hand side (ContactDetail).
import { Button, Input, Loader, Text, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import { CaretDoubleLeftIcon, DownloadSimpleIcon, SidebarSimpleIcon, MagnifyingGlassIcon, PaperPlaneTiltIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { type FormEvent, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import ContactAvatar from "~/components/ContactAvatar";
import ContactDetail from "~/components/ContactDetail";
import ContactImport from "~/components/ContactImport";
import { ShowMoreButton, useShowMore } from "~/components/ShowMore";
import { useIsWide } from "~/hooks/useIsWide";
import { useRemembered } from "~/hooks/useRemembered";
import { useUIStore } from "~/hooks/useUIStore";
import copy from "~/copy/contacts.en-GB.json";
import { useContacts, useRemoveContact, useSaveContact } from "~/queries/contacts";
import { useMailbox } from "~/queries/mailboxes";
import { isValidContactEmail, type Contact } from "shared/contacts";

interface Editing { email: string; name: string; notes: string; isNew: boolean }

const showDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default function ContactsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: mailbox } = useMailbox(mailboxId);
	const { data: contacts, isLoading } = useContacts(mailboxId);
	const save = useSaveContact(mailboxId);
	const remove = useRemoveContact(mailboxId);
	const toastManager = useKumoToastManager();
	const navigate = useNavigate();
	const wide = useIsWide();
	const { startCompose } = useUIStore();
	const [query, setQuery] = useState("");
	const [editing, setEditing] = useState<Editing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);
	const [chosen, setChosen] = useState<string | null>(null);
	// On wider screens the list folds away, like Mail's folders, leaving the chosen person across the page.
	const [listFolded, setListFolded] = useRemembered("mailapp.contacts.list-folded", false);
	const photos = !!mailbox?.settings?.showPhotos;

	const shown = useMemo(() => {
		const q = query.trim().toLowerCase();
		return (contacts ?? []).filter((c) => !q || c.email.includes(q) || c.name.toLowerCase().includes(q) || c.notes.toLowerCase().includes(q));
	}, [contacts, query]);

	// A long address book shows its first 25, with "Show all" under them. Finding shows every match.
	const list = useShowMore(shown, { limit: 25 });
	const drawn = query.trim() ? shown : list.shown;

	// The person shown on the right: the one clicked, or the first in the list.
	const picked = shown.find((c) => c.email === chosen) ?? shown[0] ?? null;
	const startEdit = (c: Contact) => { setError(null); setEditing({ email: c.email, name: c.name, notes: c.notes, isNew: false }); };

	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!editing) return;
		const email = editing.email.trim().toLowerCase();
		if (!isValidContactEmail(email)) { setError(copy.invalid); return; }
		setError(null);
		save.mutate({ email, name: editing.name.trim(), notes: editing.notes.trim() }, {
			onSuccess: () => { setEditing(null); toastManager.add({ title: copy.saved }); },
			onError: () => toastManager.add({ title: copy.failed, variant: "error" }),
		});
	};

	const write = (c: Contact) => {
		// On wider screens the new email floats in its own box, so you stay on Contacts.
		if (wide) { startCompose({ mode: "new", originalEmail: null, to: c.email }); return; }
		// On phones the inbox opens the new email itself, after it has reset its panel.
		navigate(`/mailbox/${mailboxId}/emails/inbox`, { state: { composeTo: c.email } });
	};

	const form = editing && (
		<form onSubmit={submit} className="space-y-3 rounded-lg border border-kumo-line bg-kumo-base p-4">
			<Input label={copy.email} type="email" value={editing.email} disabled={!editing.isNew} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
			<Input label={copy.name} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
			<label className="block">
				<span className="block text-base font-medium text-kumo-default mb-1.5">{copy.notes}</span>
				<textarea
					value={editing.notes}
					onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
					rows={3}
					className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring"
				/>
			</label>
			{error && <Text variant="error" size="sm">{error}</Text>}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(null); setError(null); }}>{copy.cancel}</Button>
				<Button type="submit" variant="primary" size="sm" loading={save.isPending}>{copy.save}</Button>
			</div>
		</form>
	);

	return (
		<div className="flex h-full min-h-0">
		<div className={`h-full w-full max-w-2xl shrink-0 overflow-y-auto px-4 py-4 md:px-8 md:py-6 lg:w-[34rem] lg:max-w-none lg:border-r lg:border-kumo-line lg:px-6 ${listFolded ? "lg:hidden" : ""}`}>
			<div className="flex items-center justify-between gap-3 mb-2">
				<div className="flex items-center gap-1">
					<h1 className="text-lg font-semibold text-kumo-default">{copy.title}</h1>
					{picked && (
						<Tooltip content={copy.hideList} side="bottom" asChild>
							<Button variant="ghost" shape="square" size="sm" className="hidden lg:flex" icon={<CaretDoubleLeftIcon size={16} />} aria-label={copy.hideList} onClick={() => setListFolded(true)} />
						</Tooltip>
					)}
				</div>
				<div className="flex gap-2">
					<Button variant="secondary" size="sm" icon={<DownloadSimpleIcon size={14} />} onClick={() => { setEditing(null); setImporting(true); }}>
						{copy.import}
					</Button>
					<Button variant="secondary" size="sm" icon={<PlusIcon size={14} />} onClick={() => { setError(null); setImporting(false); setEditing({ email: "", name: "", notes: "", isNew: true }); }}>
						{copy.add}
					</Button>
				</div>
			</div>
			<p className="text-sm text-kumo-subtle mb-4">{mailbox?.settings?.autoContacts === false ? copy.introSavedOnly : copy.intro}</p>

			{editing?.isNew && <div className="mb-4">{form}</div>}
			{importing && mailboxId && (
				<div className="mb-4"><ContactImport mailboxId={mailboxId} contacts={contacts ?? []} onClose={() => setImporting(false)} /></div>
			)}

			<div className="relative mb-3">
				<MagnifyingGlassIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-subtle pointer-events-none" />
				<input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder={copy.search}
					aria-label={copy.search}
					className="w-full rounded-lg border border-kumo-line bg-kumo-base pl-9 pr-3 py-2 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring"
				/>
			</div>

			{isLoading ? (
				<div className="flex justify-center py-12"><Loader size="lg" /></div>
			) : shown.length === 0 ? (
				<p className="text-sm text-kumo-subtle py-6">{contacts?.length ? copy.noMatch : copy.none}</p>
			) : (
				<ul className="divide-y divide-kumo-line rounded-lg border border-kumo-line bg-kumo-base">
					{drawn.map((c) => (
						<li key={c.email} onClick={() => setChosen(c.email)}
							className={`px-3 py-2.5 lg:cursor-pointer ${picked?.email === c.email ? "lg:bg-kumo-tint" : "lg:hover:bg-kumo-tint"}`}>
							{editing && !editing.isNew && editing.email === c.email ? form : (
								<div className="flex items-center gap-3">
									<ContactAvatar email={c.email} name={c.name} photos={photos} />
									<div className="min-w-0 flex-1">
										<div className="truncate text-sm font-medium text-kumo-default">{c.name || c.email}</div>
										{c.name && <div className="truncate text-xs text-kumo-subtle">{c.email}</div>}
										<div className="truncate text-xs text-kumo-subtle">
											{c.sent ? `${c.sent === 1 ? copy.sentOne : copy.sentMany.replace("{count}", String(c.sent))}${c.lastSent ? `, ${copy.lastSent.replace("{date}", showDate(c.lastSent))}` : ""}` : copy.neverSent}
											{c.notes ? ` · ${c.notes}` : ""}
										</div>
									</div>
									<div className="flex shrink-0 gap-1">
										<Button variant="ghost" size="xs" icon={<PaperPlaneTiltIcon size={14} />} onClick={(e) => { e.stopPropagation(); write(c); }} aria-label={`${copy.write} to ${c.name || c.email}`}>
											<span className="hidden sm:inline">{copy.write}</span>
										</Button>
										<Button variant="ghost" size="xs" icon={<PencilSimpleIcon size={14} />} onClick={(e) => { e.stopPropagation(); startEdit(c); }} aria-label={`${copy.edit} ${c.name || c.email}`} />
										<Button
											variant="ghost"
											size="xs"
											icon={<TrashIcon size={14} />}
											onClick={(e) => { e.stopPropagation(); remove.mutate(c.email, { onSuccess: () => toastManager.add({ title: copy.removed }) }); }}
											aria-label={`${copy.remove} ${c.name || c.email}`}
										/>
									</div>
								</div>
							)}
						</li>
					))}
				</ul>
			)}
			{!query.trim() && <ShowMoreButton list={list} className="mt-3" />}
		</div>
		<div className="relative hidden min-w-0 flex-1 overflow-y-auto lg:block">
			{listFolded && (
				<div className="absolute left-4 top-4">
					<Tooltip content={copy.showList} side="right" asChild>
						<Button variant="ghost" shape="square" size="sm" icon={<SidebarSimpleIcon size={18} />} aria-label={copy.showList} onClick={() => setListFolded(false)} />
					</Tooltip>
				</div>
			)}
			{mailboxId && <ContactDetail mailboxId={mailboxId} contact={picked} photos={photos} onWrite={write} onEdit={startEdit} />}
		</div>
		</div>
	);
}
