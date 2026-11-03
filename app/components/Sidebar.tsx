// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: Mail App logo and help links at the foot of the sidebar; Spam, Snoozed and Scheduled folder links; Contacts and Calendar moved to their own screens (see AppSwitcher.tsx); labels; Folders and Labels can be folded away; on wider screens the whole sidebar folds down to a slim strip of icons; everyone who can open more than one mailbox sees them all in one list, each with its own folders; admins are told when email can't be sent yet.

import { Badge, Button, Dialog, Input, Tooltip } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	CaretDoubleLeftIcon,
	CaretDoubleRightIcon,
	CaretDownIcon,
	CaretLeftIcon,
	CaretRightIcon,
	ClockCountdownIcon,
	ClockIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	FolderIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	PlusIcon,
	SlidersHorizontalIcon,
	TrashIcon,
	UsersIcon,
	TrayIcon,
	WarningOctagonIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { NavLink, useLocation, useNavigate, useParams } from "react-router";
import { Folders, SYSTEM_FOLDER_IDS } from "shared/folders";
import { useCreateFolder, useFolders } from "~/queries/folders";
import { useMailbox, useMailboxes } from "~/queries/mailboxes";
import { useMe } from "~/queries/people";
import { useQueries } from "@tanstack/react-query";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";
import type { Folder, Mailbox } from "~/types";
import listCopy from "~/copy/lists.en-GB.json";
import mailboxCopy from "~/copy/mailboxes.en-GB.json";
import { useUIStore } from "~/hooks/useUIStore";
import { useRemembered } from "~/hooks/useRemembered";
import Logo, { HelpLinks, UpdateNotice } from "~/components/Logo";
import SendingCard from "~/components/SendingCard";
import { LABEL_DRAG_TYPE, LabelDialog, LabelDot, isLabelDrag } from "~/components/Labels";
import { useLabels, useReorderLabels } from "~/queries/labels";
import { moveLabel } from "shared/labels";
import labelCopy from "~/copy/labels.en-GB.json";
import { FindBox, ShowMoreButton, useShowMore } from "~/components/ShowMore";
import type { Label } from "shared/labels";

const FOLDER_ICONS: Record<string, React.ReactNode> = {
	[Folders.INBOX]: <TrayIcon size={18} weight="regular" />,
	[Folders.SNOOZED]: <ClockIcon size={18} weight="regular" />,
	[Folders.SCHEDULED]: <ClockCountdownIcon size={18} weight="regular" />,
	[Folders.SENT]: <PaperPlaneTiltIcon size={18} weight="regular" />,
	[Folders.DRAFT]: <FileIcon size={18} weight="regular" />,
	[Folders.ARCHIVE]: <ArchiveIcon size={18} weight="regular" />,
	[Folders.SPAM]: <WarningOctagonIcon size={18} weight="regular" />,
	[Folders.TRASH]: <TrashIcon size={18} weight="regular" />,
};

const SYSTEM_FOLDER_LINKS = [
	{ id: Folders.INBOX, label: "Inbox" },
	{ id: Folders.SNOOZED, label: "Snoozed" },
	{ id: Folders.SCHEDULED, label: "Scheduled" },
	{ id: Folders.SENT, label: "Sent" },
	{ id: Folders.DRAFT, label: "Drafts" },
	{ id: Folders.ARCHIVE, label: "Archive" },
	{ id: Folders.SPAM, label: "Spam" },
	{ id: Folders.TRASH, label: "Bin" },
];

/** Mail App: Scheduled only shows while something is waiting in it, or while it's the page open. */
function systemFolderLinks(count: (id: string) => number, open: (id: string) => boolean) {
	return SYSTEM_FOLDER_LINKS.filter((f) => f.id !== Folders.SCHEDULED || count(f.id) > 0 || open(f.id));
}

/** Mail App: how many folders or labels the sidebar shows before "Show all". */
const SIDEBAR_LIST = 8;
/** Mail App: how many mailboxes the sidebar shows before "Show all". */
const SIDEBAR_MAILBOXES = 5;

interface FolderLinkProps {
	to: string;
	icon: React.ReactNode;
	label: string;
	unreadCount?: number;
	onClick?: () => void;
	/** Mail App: sits under a mailbox's name in the mailbox list. */
	indent?: boolean;
	/** Mail App: whether this is the page showing, when the address may be written with @ or %40. */
	active?: boolean;
}

function FolderLink({
	to,
	icon,
	label,
	unreadCount,
	onClick,
	indent,
	active,
}: FolderLinkProps) {
	return (
		<NavLink
			to={to}
			onClick={onClick}
			className={({ isActive: matched }) => {
				const isActive = active ?? matched;
				return `flex items-center gap-3 py-2 ${indent ? "pl-8 pr-3" : "px-3"} rounded-md text-sm transition-colors ${
					isActive
						? "bg-kumo-fill font-semibold text-kumo-default"
						: "text-kumo-strong hover:bg-kumo-tint"
				}`;
			}}
		>
			<span className="shrink-0">{icon}</span>
			<span className="truncate flex-1">{label}</span>
			{unreadCount != null && unreadCount > 0 && (
				<Badge variant="secondary">{unreadCount}</Badge>
			)}
		</NavLink>
	);
}

/** Mail App: "FOLDERS" / "LABELS" heading. Pressing it folds the list away or opens it again. */
function SectionHeader({ title, suffix, open, onToggle, addLabel, onAdd }: {
	title: string;
	/** Mail App: which mailbox the list belongs to, when there's more than one. */
	suffix?: string;
	open: boolean;
	onToggle: () => void;
	addLabel?: string;
	onAdd?: () => void;
}) {
	return (
		<div className="flex items-center justify-between pl-1 pr-3 mb-1.5">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				className="flex items-center gap-1 rounded-md border-0 bg-transparent px-2 py-1 cursor-pointer text-xs uppercase tracking-wider font-semibold text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint"
			>
				{open ? <CaretDownIcon size={12} weight="bold" /> : <CaretRightIcon size={12} weight="bold" />}
				{title}
				{suffix && <span className="ml-1 max-w-32 truncate normal-case tracking-normal font-normal">· {suffix}</span>}
			</button>
			{onAdd && addLabel && (
				<Tooltip content={addLabel} asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<PlusIcon size={16} />}
						onClick={onAdd}
						aria-label={addLabel}
					/>
				</Tooltip>
			)}
		</div>
	);
}

/** Mail App: the line showing where a dragged label will land. */
function DropLine({ position }: { position: "top" | "bottom" }) {
	return <div className={`pointer-events-none absolute inset-x-2 h-0.5 rounded bg-kumo-brand ${position === "top" ? "-top-px" : "-bottom-px"}`} />;
}

/**
 * Mail App: when someone can open more than one mailbox (their own plus shared ones like sales@), every
 * mailbox sits in one list with its own folders underneath, like Outlook. Clicking a folder in any
 * mailbox opens it, and the list never swaps over, so your own inbox is always one click away.
 */
function MailboxTree({ mailboxes, current, onNavigate, onNewFolder }: {
	mailboxes: Mailbox[];
	current: string | undefined;
	onNavigate: () => void;
	onNewFolder: () => void;
}) {
	const folderLists = useQueries({
		queries: mailboxes.map((m) => ({
			queryKey: queryKeys.folders.list(m.id),
			queryFn: () => api.listFolders(m.id) as Promise<Folder[]>,
			refetchInterval: 60_000,
		})),
	});
	// Each mailbox's own name ("Acme Sales"), from its settings; shared with the rest of the app's cache.
	const details = useQueries({
		queries: mailboxes.map((m) => ({
			queryKey: queryKeys.mailboxes.detail(m.id),
			queryFn: () => api.getMailbox(m.id) as Promise<Mailbox>,
			staleTime: 5 * 60_000,
		})),
	});
	const group = (m: Mailbox, i: number) => (
		<MailboxGroup
			key={m.id}
			mailbox={m}
			label={mailboxLabel(details[i]?.data ?? m)}
			folders={folderLists[i]?.data ?? []}
			isCurrent={m.id.toLowerCase() === current?.toLowerCase()}
			onNavigate={onNavigate}
			onNewFolder={onNewFolder}
		/>
	);
	const ordered = [
		...mailboxes.map((m, i) => [m, i] as const).filter(([m]) => !m.shared),
		...mailboxes.map((m, i) => [m, i] as const).filter(([m]) => m.shared),
	];
	// A long list of mailboxes shows its first few (and always the one that's open), with "Show all"
	// under them, and a Find box once there are 10 or more.
	const list = useShowMore(ordered, { limit: SIDEBAR_MAILBOXES, text: ([m, i]) => `${mailboxLabel(details[i]?.data ?? m)} ${m.email}` });
	const isOpen = ([m]: (typeof ordered)[number]) => m.id.toLowerCase() === current?.toLowerCase();
	const shown = new Set(list.shown);
	if (!list.query.trim()) for (const entry of ordered) if (isOpen(entry)) shown.add(entry);
	const own = ordered.filter((e) => !e[0].shared && shown.has(e));
	const shared = ordered.filter((e) => e[0].shared && shown.has(e));
	return (
		<>
			<FindBox list={list} label={mailboxCopy.findMailbox} className="px-1 pb-2" />
			{own.map(([m, i]) => group(m, i))}
			{shared.length > 0 && (
				<div className="pt-4">
					<div className="px-3 pb-1.5 text-xs uppercase tracking-wider font-semibold text-kumo-subtle">{mailboxCopy.heading}</div>
					{shared.map(([m, i]) => group(m, i))}
				</div>
			)}
			<ShowMoreButton list={list} showAll={listCopy.showAllMailboxes} className="px-3 py-1" />
		</>
	);
}

function safeDecode(path: string): string {
	try { return decodeURIComponent(path); } catch { return path; }
}

/** Mail App: one mailbox in the list: its name (press to fold it away) and, when open, its folders. */
function MailboxGroup({ mailbox, label, folders, isCurrent, onNavigate, onNewFolder }: {
	mailbox: Mailbox;
	label: string;
	folders: Folder[];
	isCurrent: boolean;
	onNavigate: () => void;
	onNewFolder: () => void;
}) {
	const [open, setOpen] = useRemembered(`mailapp.sidebar.mailbox.${mailbox.id.toLowerCase()}`, !mailbox.shared || isCurrent);
	const base = `/mailbox/${encodeURIComponent(mailbox.id)}/emails`;
	const here = safeDecode(useLocation().pathname).toLowerCase();
	const isHere = (folderId: string) => here === safeDecode(`${base}/${folderId}`).toLowerCase();
	const unread = (id: string) => folders.find((f) => f.id === id)?.unreadCount || 0;
	const custom = useShowMore(folders.filter((f) => !(SYSTEM_FOLDER_IDS as readonly string[]).includes(f.id)), { limit: SIDEBAR_LIST });
	return (
		<div className="pb-1">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				title={mailbox.email}
				className="flex w-full items-center gap-2 py-2 px-2 rounded-md border-0 bg-transparent cursor-pointer text-left text-sm font-semibold text-kumo-default hover:bg-kumo-tint"
			>
				<span className="w-3 shrink-0 text-kumo-subtle">
					{open ? <CaretDownIcon size={12} weight="bold" /> : <CaretRightIcon size={12} weight="bold" />}
				</span>
				<span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
					mailbox.shared ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" : "bg-kumo-brand text-white"
				}`}>
					{mailbox.shared ? <UsersIcon size={13} weight="bold" /> : (label.trim()[0] ?? "?").toUpperCase()}
				</span>
				<span className="truncate flex-1">{label}</span>
				{!open && unread(Folders.INBOX) > 0 && <Badge variant="secondary">{unread(Folders.INBOX)}</Badge>}
			</button>
			{open && (
				<div className="space-y-0.5">
					{systemFolderLinks(unread, isHere).map((folder) => (
						<FolderLink
							key={folder.id}
							to={`${base}/${folder.id}`}
							icon={FOLDER_ICONS[folder.id]}
							label={folder.label}
							unreadCount={unread(folder.id)}
							onClick={onNavigate}
							indent
							active={isHere(folder.id)}
						/>
					))}
					{custom.shown.map((folder) => (
						<FolderLink
							key={folder.id}
							to={`${base}/${folder.id}`}
							icon={<FolderIcon size={18} />}
							label={folder.name}
							unreadCount={folder.unreadCount}
							onClick={onNavigate}
							indent
							active={isHere(folder.id)}
						/>
					))}
					<ShowMoreButton list={custom} showAll={listCopy.showAllFolders} className="py-1 pl-8" />
					{isCurrent && (
						<button
							type="button"
							onClick={onNewFolder}
							className="flex w-full items-center gap-3 py-1.5 pl-8 pr-3 rounded-md border-0 bg-transparent cursor-pointer text-left text-xs text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint"
						>
							<span className="shrink-0"><PlusIcon size={14} /></span>
							<span>New folder</span>
						</button>
					)}
				</div>
			)}
		</div>
	);
}

/** The name people will recognise: the mailbox's display name, else the part of the address before the @. */
export function mailboxLabel(m: Mailbox): string {
	const name = m.settings?.fromName?.trim();
	if (name) return name;
	return m.email.split("@")[0] || m.email;
}

export default function Sidebar({ onCollapse }: { onCollapse?: () => void }) {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const { data: folders = [] } = useFolders(mailboxId);
	const createFolderMutation = useCreateFolder();
	const { startCompose, closeSidebar } = useUIStore();
	const { data: currentMailbox } = useMailbox(mailboxId);
	const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");
	const { data: labels = [] } = useLabels(mailboxId);
	// Mail App: null = closed, "new" = making a label, or the label being changed.
	const [labelDialog, setLabelDialog] = useState<Label | "new" | null>(null);
	const reorderLabels = useReorderLabels();
	// Mail App: the label being dragged, and where it would land ("end" = after the last one).
	const [dragging, setDragging] = useState<string | null>(null);
	const [dropBefore, setDropBefore] = useState<string | null>(null);
	const [foldersOpen, setFoldersOpen] = useRemembered("mailapp.sidebar.folders", true);
	const [labelsOpen, setLabelsOpen] = useRemembered("mailapp.sidebar.labels", true);
	// Mail App: more than one mailbox to open (a shared one, say) shows them all in one list, like Outlook.
	const { data: allMailboxes = [] } = useMailboxes();
	const openable = allMailboxes.filter((m) => m.canOpen !== false);
	const showTree = openable.length > 1;
	const { data: me } = useMe();

	const customFolders = useMemo(
		() =>
			folders.filter((f) => !(SYSTEM_FOLDER_IDS as readonly string[]).includes(f.id)),
		[folders],
	);
	// Mail App: a long list of folders or labels shows its first few, with "Show all" under them.
	const folderList = useShowMore(customFolders, { limit: SIDEBAR_LIST });
	const labelList = useShowMore(labels, { limit: SIDEBAR_LIST });

	const { pathname } = useLocation();
	const getUnreadCount = (folderId: string) => {
		const found = folders.find((f) => f.id === folderId);
		return found?.unreadCount || 0;
	};

	const handleCreateFolder = (e: React.FormEvent) => {
		e.preventDefault();
		if (newFolderName.trim() && mailboxId) {
			createFolderMutation.mutate({ mailboxId, name: newFolderName.trim() });
			setNewFolderName("");
			setIsCreateFolderOpen(false);
		}
	};

	const displayName = useMemo(() => {
		if (!currentMailbox) return mailboxId?.split("@")[0] || "Mailbox";
		// Prefer settings.fromName > name > local part of email
		if (currentMailbox.settings?.fromName) {
			return currentMailbox.settings.fromName;
		}
		if (currentMailbox.name && currentMailbox.name !== currentMailbox.email) {
			return currentMailbox.name;
		}
		return currentMailbox.email.split("@")[0] || currentMailbox.name;
	}, [currentMailbox, mailboxId]);

	const handleNavClick = () => {
		// Close mobile sidebar on navigation
		closeSidebar();
	};

	return (
		<aside className="h-full w-64 bg-kumo-recessed flex flex-col shrink-0 border-r border-kumo-line">
			{/* Back + identity. Mail App: with the mailbox list showing, every mailbox is named there instead,
			    and only admins keep the way back to the Mailboxes page. */}
			<div className={`relative px-4 ${showTree ? "pt-3" : "pt-4 pb-1"}`}>
				{(!showTree || me?.role === "admin") && (
					<button
						type="button"
						onClick={() => {
							navigate("/");
							closeSidebar();
						}}
						className="flex items-center gap-1.5 text-kumo-subtle text-sm hover:text-kumo-default transition-colors mb-2.5 cursor-pointer bg-transparent border-0 p-0"
					>
						<CaretLeftIcon size={14} />
						<span>Mailboxes</span>
					</button>
				)}
				{onCollapse && (
					<Tooltip content="Hide sidebar" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<CaretDoubleLeftIcon size={16} />}
							onClick={onCollapse}
							aria-label="Hide sidebar"
							className={`hidden md:inline-flex absolute right-2 ${showTree ? "top-1.5" : "top-3"}`}
						/>
					</Tooltip>
				)}
				{!showTree && (
					<div className="px-1">
						<div className="text-base font-semibold text-kumo-default truncate">
							{displayName}
						</div>
						<div className="text-sm text-kumo-subtle truncate mt-0.5">
							{currentMailbox?.email || mailboxId}
						</div>
					</div>
				)}
			</div>

			{/* Compose */}
			<div className={`px-3 ${showTree ? "pt-2 pb-3" : "py-3"}`}>
				<Button
					variant="primary"
					icon={<PencilSimpleIcon size={16} />}
					onClick={() => startCompose()}
					className="w-full"
				>
					Compose
				</Button>
				{showTree && (
					<p className="mt-1.5 px-1 text-xs text-kumo-subtle truncate" title={currentMailbox?.email || mailboxId}>
						{mailboxCopy.sendsFrom.replace("{address}", currentMailbox?.email || mailboxId || "")}
					</p>
				)}
			</div>

			{/* Navigation */}
			<nav className="flex-1 overflow-y-auto px-2 space-y-0.5">
				{showTree ? (
					<MailboxTree
						mailboxes={openable}
						current={mailboxId}
						onNavigate={handleNavClick}
						onNewFolder={() => setIsCreateFolderOpen(true)}
					/>
				) : (
					<>
						{systemFolderLinks(getUnreadCount, (id) => pathname.endsWith(`/emails/${id}`)).map((folder) => (
							<FolderLink
								key={folder.id}
								to={`/mailbox/${mailboxId}/emails/${folder.id}`}
								icon={FOLDER_ICONS[folder.id]}
								label={folder.label}
								unreadCount={getUnreadCount(folder.id)}
								onClick={handleNavClick}
							/>
						))}

						{/* Custom folders. Mail App: the Folders and Labels lists can be folded away. */}
						<div className="pt-5">
							<SectionHeader
								title="Folders"
								open={foldersOpen}
								onToggle={() => setFoldersOpen(!foldersOpen)}
								addLabel="New folder"
								onAdd={() => setIsCreateFolderOpen(true)}
							/>
							{foldersOpen && folderList.shown.map((folder) => (
								<FolderLink
									key={folder.id}
									to={`/mailbox/${mailboxId}/emails/${folder.id}`}
									icon={<FolderIcon size={18} />}
									label={folder.name}
									unreadCount={folder.unreadCount}
									onClick={handleNavClick}
								/>
							))}
							{foldersOpen && <ShowMoreButton list={folderList} showAll={listCopy.showAllFolders} className="px-3 py-1" />}
						</div>
					</>
				)}

				{/* Mail App: labels. Drag one onto an email to label it, or up and down the list to move it. */}
				<div className="pt-5 pb-2">
					<SectionHeader
						title={labelCopy.heading}
						suffix={showTree ? displayName : undefined}
						open={labelsOpen}
						onToggle={() => setLabelsOpen(!labelsOpen)}
						addLabel={labelCopy.newLabel}
						onAdd={() => setLabelDialog("new")}
					/>
					{labelsOpen && labels.length === 0 && (
						<p className="px-3 text-xs text-kumo-subtle">{labelCopy.sidebarEmpty}</p>
					)}
					{labelsOpen && labels.length > 1 && (
						<p className="hidden md:block px-3 pb-1 text-xs text-kumo-subtle">{labelCopy.dragHint}</p>
					)}
					{labelsOpen && labelList.shown.map((label) => (
						<div
							key={label.id}
							draggable
							onDragStart={(e) => {
								e.dataTransfer.setData(LABEL_DRAG_TYPE, label.id);
								e.dataTransfer.effectAllowed = "copyMove";
								setDragging(label.id);
								// Lets the drop reach the email even over its message, which sits in its own frame.
								document.body.classList.add("app-dragging-label");
							}}
							onDragEnd={() => {
								setDragging(null);
								setDropBefore(null);
								document.body.classList.remove("app-dragging-label");
							}}
							onDragOver={(e) => {
								if (!dragging || !isLabelDrag(e)) return;
								e.preventDefault();
								e.dataTransfer.dropEffect = "move";
								// Top half of a row drops before it, bottom half after it.
								const box = e.currentTarget.getBoundingClientRect();
								const after = e.clientY > box.top + box.height / 2;
								const i = labels.findIndex((l) => l.id === label.id);
								setDropBefore(after ? (labels[i + 1]?.id ?? "end") : label.id);
							}}
							onDrop={(e) => {
								if (!dragging || !mailboxId) return;
								e.preventDefault();
								const next = moveLabel(labels, dragging, dropBefore === "end" ? null : dropBefore);
								if (next !== labels) reorderLabels.mutate({ mailboxId, labels: next });
								setDragging(null);
								setDropBefore(null);
							}}
							className={`group relative flex items-center gap-0.5 ${dragging === label.id ? "opacity-40" : ""}`}
						>
							{dragging && dropBefore === label.id && <DropLine position="top" />}
							{dragging && dropBefore === "end" && label.id === labels[labels.length - 1]?.id && <DropLine position="bottom" />}
							<div className="min-w-0 flex-1">
							<FolderLink
								to={`/mailbox/${mailboxId}/labels/${label.id}`}
								icon={<span className="flex size-[18px] items-center justify-center"><LabelDot color={label.color} /></span>}
								label={label.name}
								unreadCount={label.unreadCount}
								onClick={handleNavClick}
							/>
							</div>
							<button
								type="button"
								onClick={() => setLabelDialog(label)}
								className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-kumo-subtle hover:text-kumo-default hover:bg-kumo-fill md:opacity-0 md:group-hover:opacity-100 focus:opacity-100"
								aria-label={`${labelCopy.editLabel}: ${label.name}`}
								title={labelCopy.editLabel}
							>
								<SlidersHorizontalIcon size={14} />
							</button>
						</div>
					))}
					{labelsOpen && <ShowMoreButton list={labelList} showAll={listCopy.showAllLabels} className="px-3 py-1" />}
				</div>
			</nav>

			{mailboxId && (
				<LabelDialog
					mailboxId={mailboxId}
					label={labelDialog === "new" ? null : labelDialog}
					open={labelDialog !== null}
					onOpenChange={(open) => { if (!open) setLabelDialog(null); }}
					onDeleted={(label) => {
						if (window.location.pathname.endsWith(`/labels/${label.id}`)) navigate(`/mailbox/${mailboxId}/emails/inbox`);
					}}
				/>
			)}

			<div className="px-4 py-3 border-t border-kumo-line">
				<UpdateNotice className="mb-3 text-xs" />
				<SendingCard compact className="mb-3 text-xs" />
				<a href="/" className="no-underline text-sm">
					<Logo size={18} />
				</a>
				<HelpLinks className="mt-1" />
			</div>

			{/* Create folder dialog */}
			<Dialog.Root
				open={isCreateFolderOpen}
				onOpenChange={setIsCreateFolderOpen}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						Create folder
					</Dialog.Title>
					<form onSubmit={handleCreateFolder} className="space-y-4">
						<Input
							label="Folder name"
							placeholder="e.g. Projects"
							value={newFolderName}
							onChange={(e) => setNewFolderName(e.target.value)}
							required
						/>
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								disabled={!newFolderName.trim()}
							>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</aside>
	);
}

/** Mail App: the sidebar folded down to a strip of icons on wider screens, so the email list gets the room. */
export function SidebarRail({ onExpand }: { onExpand: () => void }) {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: folders = [] } = useFolders(mailboxId);
	const { data: labels = [] } = useLabels(mailboxId);
	const { startCompose } = useUIStore();
	const unread = (id: string) => folders.find((f) => f.id === id)?.unreadCount || 0;
	const { pathname } = useLocation();
	const railLink = ({ isActive }: { isActive: boolean }) =>
		`relative flex size-10 items-center justify-center rounded-md transition-colors ${
			isActive ? "bg-kumo-fill text-kumo-default" : "text-kumo-strong hover:bg-kumo-tint"
		}`;

	return (
		<aside className="h-full w-14 bg-kumo-recessed flex flex-col items-center shrink-0 border-r border-kumo-line py-3 gap-1">
			<Tooltip content="Show sidebar" side="right" asChild>
				<Button
					variant="ghost"
					shape="square"
					icon={<CaretDoubleRightIcon size={16} />}
					onClick={onExpand}
					aria-label="Show sidebar"
				/>
			</Tooltip>
			<Tooltip content="Compose" side="right" asChild>
				<Button
					variant="primary"
					shape="square"
					icon={<PencilSimpleIcon size={18} />}
					onClick={() => startCompose()}
					aria-label="Compose"
					className="my-2"
				/>
			</Tooltip>
			<nav className="flex flex-col items-center gap-0.5">
				{systemFolderLinks(unread, (id) => pathname.endsWith(`/emails/${id}`)).map((folder) => {
					const count = unread(folder.id);
					return (
						<Tooltip key={folder.id} content={count ? `${folder.label} (${count} unread)` : folder.label} side="right" asChild>
							<NavLink to={`/mailbox/${mailboxId}/emails/${folder.id}`} className={railLink} aria-label={folder.label}>
								{FOLDER_ICONS[folder.id]}
								{count > 0 && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-kumo-brand" />}
							</NavLink>
						</Tooltip>
					);
				})}
			</nav>
			{labels.length > 0 && (
				<nav className="flex flex-col items-center gap-0.5 border-t border-kumo-line pt-1 mt-1 overflow-y-auto min-h-0">
					{labels.map((label) => (
						<Tooltip key={label.id} content={label.name} side="right" asChild>
							<NavLink to={`/mailbox/${mailboxId}/labels/${label.id}`} className={railLink} aria-label={label.name}>
								<LabelDot color={label.color} />
							</NavLink>
						</Tooltip>
					))}
				</nav>
			)}
		</aside>
	);
}
