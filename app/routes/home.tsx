// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: Mail App name, logo and help links; each mailbox's extra addresses and the catch-all are managed here; team access (people see their own mailboxes; admins see everyone's, and opening someone else's is logged); shared mailboxes, with who uses each one chosen here; admins are told when email can't be sent to other people yet; more than one domain, added from here; long lists show their first few with "Show all" and a "Find…" box; the admin area's menu down the side, with the mailboxes as a table (type, who uses each, status) and each one's options in a menu.

import {
	Button,
	Dialog,
	DropdownMenu,
	Input,
	Loader,
	Select,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { AtIcon, DotsThreeVerticalIcon, EnvelopeIcon, LockSimpleIcon, LockSimpleOpenIcon, PlusIcon, SignInIcon, TrashIcon, UserIcon, UsersIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import api from "~/services/api";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxes,
} from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";
import AdminShell, { Initial, PageHeading, Pill, mailboxTitle } from "~/components/AdminShell";
import MailboxAddresses from "~/components/MailboxAddresses";
import SendingCard from "~/components/SendingCard";
import { useDomains } from "~/queries/domains";
import adminCopy from "~/copy/admin.en-GB.json";
import { FindBox, ShowMoreButton, shortList, useShowMore } from "~/components/ShowMore";
import { useAddressBook } from "~/queries/addresses";
import { fill } from "~/lib/attachments";
import settingsCopy from "~/copy/settings.en-GB.json";
import peopleCopy from "~/copy/people.en-GB.json";
import mailboxCopy from "~/copy/mailboxes.en-GB.json";
import MailboxPeopleDialog, { SharedPicker } from "~/components/MailboxPeople";
import { useMe } from "~/queries/people";
import type { Mailbox } from "~/types";
import { pageTitle } from "~/lib/brand";

const at = settingsCopy.addressAdmin;

export function meta({ matches }: { matches: readonly unknown[] }) {
	return [{ title: pageTitle(matches) }];
}

export default function HomeRoute() {
	const toastManager = useKumoToastManager();
	const { data: mailboxes = [], refetch: refetchMailboxes, isFetched: mailboxesFetched } = useMailboxes();
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();
	const { data: me } = useMe();
	const isAdmin = me?.role === "admin";
	const { data: addressBook } = useAddressBook(isAdmin);
	const { data: domainData } = useDomains(isAdmin);
	const navigate = useNavigate();
	const [addressesFor, setAddressesFor] = useState<string | null>(null);
	// Mail App: an admin opening someone else's mailbox (logged where its people can see).
	const [toOpen, setToOpen] = useState<Mailbox | null>(null);
	const [opening, setOpening] = useState(false);
	const qc = useQueryClient();
	const setAdminAccess = async (mailbox: Mailbox, open: boolean) => {
		setOpening(true);
		try {
			await api.setAdminAccess(mailbox.email, open);
			await qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
			await qc.invalidateQueries({ queryKey: queryKeys.me });
			if (!open) toastManager.add({ title: fill(peopleCopy.open.closed, { mailbox: mailbox.email }) });
			setToOpen(null);
		} catch (err) {
			toastManager.add({ title: err instanceof Error ? err.message : "Something went wrong", variant: "error" });
		} finally {
			setOpening(false);
		}
	};

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity, // config rarely changes
	});

	const domains = configData?.domains ?? [];
	const emailAddresses = configData?.emailAddresses ?? [];

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newPrefix, setNewPrefix] = useState("");
	const [selectedDomain, setSelectedDomain] = useState("");
	const [newName, setNewName] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	// Mail App: a shared mailbox (a team address like sales@), and who gets it.
	const [newShared, setNewShared] = useState(false);
	const [newPeople, setNewPeople] = useState<Set<string>>(new Set());
	const [peopleFor, setPeopleFor] = useState<Mailbox | null>(null);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [mailboxToDelete, setMailboxToDelete] = useState<{
		id: string;
		email: string;
	} | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	// Set default domain when config loads
	useEffect(() => {
		if (domains.length > 0 && !selectedDomain) {
			setSelectedDomain(domains[0]);
		}
	}, [domains, selectedDomain]);

	// Auto-create mailboxes from config (run once when both data sources are ready)
	const autoCreateDone = useRef(false);
	useEffect(() => {
		if (autoCreateDone.current) return;
		if (emailAddresses.length === 0 || !mailboxesFetched) return;
		const existingEmails = new Set(
			mailboxes.map((m) => m.email.toLowerCase()),
		);
		const toCreate = emailAddresses.filter(
			(addr) => !existingEmails.has(addr.toLowerCase()),
		);
		if (toCreate.length === 0) {
			autoCreateDone.current = true;
			return;
		}
		autoCreateDone.current = true;
		let cancelled = false;
		Promise.all(
			toCreate.map((addr) => {
				const localPart = addr.split("@")[0] || addr;
				return api.createMailbox(addr, localPart).catch(() => {});
			}),
		).then(() => { if (!cancelled) refetchMailboxes(); });
		return () => { cancelled = true; };
	}, [emailAddresses, mailboxes, refetchMailboxes]);

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		if (!newPrefix || !selectedDomain) {
			setCreateError("Please fill in all fields");
			return;
		}
		const email = `${newPrefix}@${selectedDomain}`;
		const name = newName || newPrefix;
		setIsCreating(true);
		try {
			const team = newShared ? { shared: true, people: [...newPeople] } : undefined;
			await createMailbox.mutateAsync({ email, name, team });
			toastManager.add({ title: "Mailbox created successfully!" });
			setIsCreateOpen(false);
			setNewPrefix("");
			setNewName("");
			setNewShared(false);
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to create mailbox";
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};

	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		setIsDeleting(true);
		try {
			await deleteMailbox.mutateAsync(mailboxToDelete.id);
			toastManager.add({ title: "Mailbox deleted" });
			setIsDeleteOpen(false);
			setMailboxToDelete(null);
		} catch {
			toastManager.add({ title: "Failed to delete mailbox", variant: "error" });
		} finally {
			setIsDeleting(false);
		}
	};

	const isConfigured = emailAddresses.length > 0;
	const accounts: Mailbox[] = isConfigured
		? emailAddresses
			.map((addr) => mailboxes.find((m) => m.email.toLowerCase() === addr.toLowerCase()) ?? {
				id: addr,
				email: addr,
				name: addr.split("@")[0] || addr,
			})
			// Mail App: people only see their own mailboxes.
			.filter((m) => isAdmin || mailboxes.some((x) => x.email.toLowerCase() === m.email.toLowerCase()))
		: mailboxes;
	// Mail App: a big install's list shows its first ten, with "Show all" and a "Find…" box.
	const mailboxList = useShowMore(accounts, { limit: 10, text: (m) => `${m.name} ${m.email}` });
	const ownedBySomeoneElse = (m: Mailbox) => !!me && !!m.people && m.people.length > 0 && !m.people.some((p) => p.email === me.email);

	const isLoading = !configData;

	const openCreate = () => { setNewPeople(new Set(me ? [me.email] : [])); setIsCreateOpen(true); };
	const a = adminCopy.mailboxes;
	// Mail App: a mailbox's status: its domain's mail records need fixing, or it's someone else's (opening it is logged).
	const domainNeedsFix = (email: string) => {
		const domain = email.split("@")[1]?.toLowerCase();
		return !!domainData?.domains.some((d) => d.name.toLowerCase() === domain && d.checks.some((c) => c.status === "fix"));
	};

	return (
		<AdminShell isAdmin={isAdmin}>
			<SendingCard className="mb-6" />
			<PageHeading
				title={adminCopy.nav.mailboxes}
				intro={isAdmin ? a.intro : a.introMember}
				action={!isConfigured && isAdmin && (
					<Button variant="primary" icon={<PlusIcon size={16} />} onClick={openCreate}>{a.new}</Button>
				)}
			/>

			{isLoading ? (
				<div className="flex justify-center py-20">
					<Loader size="lg" />
				</div>
			) : accounts.length > 0 ? (
				<div className="rounded-2xl border border-kumo-line bg-kumo-base shadow-sm">
					<div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
						<FindBox list={mailboxList} label={mailboxCopy.findMailbox} className="w-full sm:w-80" />
						<span className="ml-auto text-sm text-kumo-subtle">
							{accounts.length === 1 ? a.countOne : fill(a.count, { count: String(accounts.length) })}
							{domains.length > 0 && <span className="hidden sm:inline"> · {shortList(domains)}</span>}
						</span>
					</div>
					{/* Column headings (computer only; on a phone each mailbox is a card) */}
					<div className={`hidden md:grid ${isAdmin ? "md:grid-cols-[minmax(0,2.4fr)_8rem_minmax(0,1.4fr)_9rem_3rem]" : "md:grid-cols-[minmax(0,3fr)_8rem_9rem_3rem]"} items-center gap-4 border-y border-kumo-line bg-kumo-recessed px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle`}>
						<span>{a.columns.mailbox}</span>
						<span>{a.columns.type}</span>
						{isAdmin && <span>{a.columns.usedBy}</span>}
						<span>{a.columns.status}</span>
						<span />
					</div>
					<div className={mailboxList.shown.length ? "" : "hidden"}>
						{mailboxList.shown.map((account, idx) => {
							const locked = account.canOpen === false;
							const fix = isAdmin && domainNeedsFix(account.email);
							const users = account.people ?? [];
							const open = () => (locked ? setToOpen(account) : navigate(`/mailbox/${account.id}`));
							return (
								<div
									key={account.id}
									role="link"
									tabIndex={0}
									onClick={open}
									onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) open(); }}
									className={`grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-4 transition-colors hover:bg-kumo-tint focus:outline-none focus-visible:bg-kumo-tint sm:px-5 ${
										isAdmin ? "md:grid-cols-[minmax(0,2.4fr)_8rem_minmax(0,1.4fr)_9rem_3rem]" : "md:grid-cols-[minmax(0,3fr)_8rem_9rem_3rem]"
									} ${idx > 0 ? "border-t border-kumo-line" : "md:border-t-0 border-t border-kumo-line"}`}
								>
									{/* Mailbox */}
									<div className="flex min-w-0 items-center gap-3.5">
										<Initial name={titleOf(account)} size={42} />
										<div className="min-w-0">
											<div className="truncate text-base font-semibold text-kumo-default">{titleOf(account)}</div>
											<div className="truncate text-sm text-kumo-subtle">{account.email}</div>
											<MailboxAddressLine mailboxId={account.id} aliases={addressBook?.aliases ?? []} catchAll={addressBook?.catchAll ?? {}} />
										</div>
									</div>
									{/* Options (top right on a phone, last column on a computer) */}
									<div className="row-span-1 justify-self-end md:order-last" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
										<MailboxMenu
											account={account}
											isAdmin={isAdmin}
											locked={locked}
											canStop={!locked && ownedBySomeoneElse(account)}
											canDelete={!isConfigured && isAdmin}
											onOpen={open}
											onStop={() => setAdminAccess(account, false)}
											onPeople={() => setPeopleFor(account)}
											onAddresses={() => setAddressesFor(account.id)}
											onDelete={() => { setMailboxToDelete({ id: account.id, email: account.email }); setIsDeleteOpen(true); }}
										/>
									</div>
									{/* Type, used by and status: one wrapped line on a phone, columns on a computer */}
									<div className="col-span-2 flex flex-wrap items-center gap-2 pl-[3.5rem] md:contents md:pl-0">
										<div>
											{account.shared
												? <Pill tone="violet" icon={<UsersIcon size={15} />}>{a.type.shared}</Pill>
												: <Pill tone="blue" icon={<UserIcon size={15} />}>{a.type.personal}</Pill>}
										</div>
										{isAdmin && (
											<div className="min-w-0 text-sm text-kumo-default md:truncate">
												{users.length ? <UsedBy people={users} me={me?.email} /> : <span className="text-kumo-subtle">{a.nobody}</span>}
											</div>
										)}
										<div>
											{locked
												? <Pill tone="grey" icon={<LockSimpleIcon size={14} />} title={a.statusHelp.locked}>{a.status.locked}</Pill>
												: fix
													? <Pill tone="amber" dot title={fill(a.statusHelp.checkDomain, { domain: account.email.split("@")[1] ?? "" })}>{a.status.checkDomain}</Pill>
													: <Pill tone="green" dot>{a.status.active}</Pill>}
										</div>
									</div>
								</div>
							);
						})}
					</div>
					{mailboxList.canFold && (
						<div className="border-t border-kumo-line px-5 py-3">
							<ShowMoreButton list={mailboxList} />
						</div>
					)}
				</div>
			) : (
				<div className="rounded-2xl border border-kumo-line bg-kumo-base py-16 px-6">
					<div className="flex flex-col items-center text-center">
						<div className="mb-4">
							<EnvelopeIcon size={48} weight="thin" className="text-kumo-subtle" />
						</div>
						<h3 className="text-base font-semibold text-kumo-default mb-1.5">
							No mailboxes yet
						</h3>
						<p className="text-sm text-kumo-subtle max-w-sm mb-5">
							{isConfigured
								? "Your email routing is configured but no mailboxes have been created yet. They will appear here automatically."
								: isAdmin || !me
									? "Create a mailbox to start sending and receiving emails with your domain."
									: peopleCopy.noMailboxYet}
						</p>
						{!isConfigured && isAdmin && (
							<Button variant="primary" icon={<PlusIcon size={16} />} onClick={openCreate}>
								Create Mailbox
							</Button>
						)}
					</div>
				</div>
			)}
			{/* Mail App: a mailbox's extra addresses and the catch-all */}
			<Dialog.Root open={!!addressesFor} onOpenChange={(open) => { if (!open) setAddressesFor(null); }}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-3 break-all">
						{fill(at.title, { mailbox: addressesFor ?? "" })}
					</Dialog.Title>
					{addressesFor && <MailboxAddresses mailboxId={addressesFor} />}
					<div className="flex justify-end pt-5">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									{at.done}
								</Button>
							)}
						/>
					</div>
				</Dialog>
			</Dialog.Root>

			{/* Mail App: who uses a mailbox, and whether it's shared */}
			{isAdmin && (
				<MailboxPeopleDialog
					mailbox={peopleFor?.email ?? null}
					shared={!!peopleFor?.shared}
					users={(peopleFor?.people ?? []).map((p) => p.email)}
					me={me?.email}
					onClose={() => setPeopleFor(null)}
				/>
			)}

			{/* Mail App: opening someone else's mailbox is logged where they can see it */}
			<Dialog.Root open={!!toOpen} onOpenChange={(open) => { if (!open) setToOpen(null); }}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2 break-all">
						{fill(peopleCopy.open.title, { mailbox: toOpen?.email ?? "" })}
					</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						{toOpen?.people?.length
							? fill(peopleCopy.open.body, { people: toOpen.people.map((p) => p.name).join(", ") })
							: peopleCopy.open.bodyUnused}
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close render={(props) => <Button {...props} variant="secondary" size="sm">{peopleCopy.form.cancel}</Button>} />
						<Button variant="primary" size="sm" loading={opening} onClick={() => toOpen && setAdminAccess(toOpen, true)}>
							{peopleCopy.open.confirm}
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>

			{/* Create Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-5">
						Create New Mailbox
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
						)}
						<div>
							<span className="text-sm font-medium text-kumo-default mb-1.5 block">
								Email Address
							</span>
							<div className="flex items-center gap-2">
								<div className="flex-1">
									<Input
										aria-label="Address prefix"
										placeholder="info"
										size="sm"
										value={newPrefix}
										onChange={(e) => setNewPrefix(e.target.value)}
										required
									/>
								</div>
								<span className="text-sm text-kumo-subtle">@</span>
								{domains.length > 1 ? (
									<div className="flex-1">
							<Select
								aria-label="Domain"
								value={selectedDomain}
								onValueChange={(value) => {
									if (value) setSelectedDomain(value);
								}}
							>
											{domains.map((d) => (
												<Select.Option key={d} value={d}>
													{d}
												</Select.Option>
											))}
										</Select>
									</div>
								) : (
									<span className="text-sm text-kumo-subtle">
										{selectedDomain || "no domain"}
									</span>
								)}
							</div>
						</div>
						<Input
							label="Display Name (optional)"
							placeholder="Info"
							size="sm"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
						/>
						{/* Mail App: a team address, with who can open it */}
						<SharedPicker shared={newShared} onShared={setNewShared} picked={newPeople} onPicked={setNewPeople} me={me?.email} />
						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isCreating}
								disabled={!selectedDomain}
							>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Delete Dialog */}
			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setMailboxToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						Delete Mailbox
					</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						Are you sure you want to delete{" "}
						<strong className="text-kumo-default">
							{mailboxToDelete?.email}
						</strong>
						? This action cannot be undone.
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							size="sm"
							loading={isDeleting}
							onClick={handleDelete}
						>
							Delete
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</AdminShell>
	);
}

/** Mail App: "Also hello@…, support@…" and a Catch-all tag (per domain) under a mailbox on the list. */
function MailboxAddressLine({ mailboxId, aliases, catchAll }: { mailboxId: string; aliases: { address: string; mailbox: string }[]; catchAll: Record<string, string> }) {
	const id = mailboxId.toLowerCase();
	const mine = aliases.filter((a) => a.mailbox === id).map((a) => a.address);
	const caught = Object.keys(catchAll).filter((d) => catchAll[d] === id).sort();
	if (mine.length === 0 && caught.length === 0) return null;
	return (
		<div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-kumo-subtle">
			{mine.length > 0 && <span className="min-w-0 break-all">{fill(at.also, { addresses: shortList(mine) })}</span>}
			{(caught.length > 3 ? [fill(at.catchAllMany, { count: String(caught.length) })] : caught.map((d) => fill(at.catchAllBadge, { domain: d }))).map((tag) => (
				<span key={tag} className="shrink-0 rounded-full bg-kumo-tint px-2 py-0.5 text-kumo-default">{tag}</span>
			))}
		</div>
	);
}

/**
 * Mail App: the name a mailbox goes by on the list. Mailboxes are often named after their address, so then
 * a personal one takes its person's name ("Sam Patel") and a shared one its first part ("Support").
 */
const titleOf = mailboxTitle;

/** Mail App: who uses a mailbox, as small initials and names ("You, Sam and 2 more"). */
function UsedBy({ people, me }: { people: { email: string; name: string }[]; me?: string }) {
	const names = people.map((p) => (p.email === me ? peopleCopy.you.charAt(0).toUpperCase() + peopleCopy.you.slice(1) : p.name));
	return (
		<span className="flex min-w-0 items-center gap-2">
			<span className="flex shrink-0 -space-x-1.5">
				{people.slice(0, 3).map((p) => (
					<span key={p.email} className="rounded-full ring-2 ring-kumo-base"><Initial name={p.name} size={24} /></span>
				))}
			</span>
			<span className="truncate">{shortList(names, 2)}</span>
		</span>
	);
}

/** Mail App: a mailbox's options: open it, who uses it, its extra addresses, and delete. */
function MailboxMenu(props: {
	account: Mailbox;
	isAdmin: boolean;
	locked: boolean;
	canStop: boolean;
	canDelete: boolean;
	onOpen: () => void;
	onStop: () => void;
	onPeople: () => void;
	onAddresses: () => void;
	onDelete: () => void;
}) {
	const c = adminCopy.mailboxes.actions;
	return (
		<DropdownMenu>
			<DropdownMenu.Trigger>
				<Button
					variant="secondary"
					size="sm"
					shape="square"
					aria-label={fill(c.menu, { mailbox: props.account.email })}
					icon={<DotsThreeVerticalIcon size={18} weight="bold" />}
				/>
			</DropdownMenu.Trigger>
			<DropdownMenu.Content>
				<DropdownMenu.Item onClick={props.onOpen}>
					<span className="flex items-center gap-2">{props.locked ? <LockSimpleIcon size={16} /> : <SignInIcon size={16} />}{props.locked ? c.openLogged : c.open}</span>
				</DropdownMenu.Item>
				{props.canStop && (
					<DropdownMenu.Item onClick={props.onStop}>
						<span className="flex items-center gap-2"><LockSimpleOpenIcon size={16} />{c.stopOpening}</span>
					</DropdownMenu.Item>
				)}
				{props.isAdmin && (
					<DropdownMenu.Item onClick={props.onPeople}>
						<span className="flex items-center gap-2"><UsersIcon size={16} />{c.people}</span>
					</DropdownMenu.Item>
				)}
				{props.isAdmin && (
					<DropdownMenu.Item onClick={props.onAddresses}>
						<span className="flex items-center gap-2"><AtIcon size={16} />{c.addresses}</span>
					</DropdownMenu.Item>
				)}
				{props.canDelete && (
					<DropdownMenu.Item onClick={props.onDelete}>
						<span className="flex items-center gap-2 text-kumo-danger"><TrashIcon size={16} />{c.delete}</span>
					</DropdownMenu.Item>
				)}
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}
