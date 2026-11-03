// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: opens a new email to a contact when sent here from the Contacts page, or with a file or download link from the Files page; labels (chips on each row, and a page per label); tick boxes to act on several conversations at once; Mark all as read; keyboard shortcuts; a "via" tag for mail sent to an extra address; the heading names the mailbox when you can open more than one; a right-click (press and hold on phones) menu on each email; Snooze (the Snoozed folder, and a Snooze button for ticked and right-clicked conversations) and "No reply yet" tags; the Scheduled folder and its "Sends …" tags.

import { Button, Dialog, Pagination, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowBendUpLeftIcon,
	ArrowBendUpRightIcon,
	ArrowsClockwiseIcon,
	ChatCircleIcon,
	ChecksIcon,
	ClockCountdownIcon,
	ClockIcon,
	BellRingingIcon,
	BellSimpleIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	FolderSimpleIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	ProhibitIcon,
	StarIcon,
	TagIcon,
	TrashIcon,
	TrayArrowUpIcon,
	TrayIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { Folders, NOT_MOVE_TARGETS } from "shared/folders";
import { formatListDate } from "shared/dates";
import { formatWhen } from "shared/reminders";
import { SnoozeDialog } from "~/components/Reminders";
import reminderCopy from "~/copy/reminders.en-GB.json";
import scheduledCopy from "~/copy/scheduled.en-GB.json";
import { fill } from "~/lib/attachments";
import MailboxSplitView from "~/components/MailboxSplitView";
import AppTip from "~/components/AppTip";
import EmailContextMenu, { useLongPress, type MenuItem, type MenuPoint } from "~/components/EmailContextMenu";
import api from "~/services/api";
import { getSnippetText } from "~/lib/utils";
import {
	useDeleteEmail,
	useEmails,
	useMarkAllRead,
	useMarkThreadRead,
	useUpdateConversations,
	useUpdateEmail,
} from "~/queries/emails";
import { MoveToFolderMenu } from "~/components/email-panel/EmailPanelToolbar";
import { SHORTCUT_LIST, useShortcuts } from "~/lib/shortcuts";
import { useFolders } from "~/queries/folders";
import { queryKeys } from "~/queries/keys";
import { useIsWide } from "~/hooks/useIsWide";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email } from "~/types";
import { LabelChips, LabelDot, LabelDropZone, LabelMenu } from "~/components/Labels";
import type { Label } from "shared/labels";
import { useLabels } from "~/queries/labels";
import { useMailbox, useMailboxes, useSpamAction } from "~/queries/mailboxes";
import { mailboxLabel } from "~/components/Sidebar";
import labelCopy from "~/copy/labels.en-GB.json";
import settingsCopy from "~/copy/settings.en-GB.json";

const addressCopy = settingsCopy.addresses;

/** Mail App: how many label chips a row shows before "+2". */
const MAX_ROW_CHIPS = 3;

const PAGE_SIZE = 25;

const FOLDER_EMPTY_STATES: Record<
	string,
	{
		icon: React.ReactNode;
		title: string;
		description: string;
		showCompose?: boolean;
	}
> = {
	[Folders.INBOX]: {
		icon: <TrayIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Your inbox is empty",
		description:
			"New emails will appear here when they arrive. Send an email to get the conversation started.",
		showCompose: true,
	},
	[Folders.SENT]: {
		icon: (
			<PaperPlaneTiltIcon size={48} weight="thin" className="text-kumo-subtle" />
		),
		title: "No sent emails",
		description: "Emails you send will show up here.",
		showCompose: true,
	},
	[Folders.DRAFT]: {
		icon: <FileIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "No drafts",
		description: "Emails you're still working on will be saved here.",
		showCompose: true,
	},
	[Folders.ARCHIVE]: {
		icon: <ArchiveIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Archive is empty",
		description:
			"Move emails here to keep your inbox clean without deleting them.",
	},
	[Folders.SNOOZED]: {
		icon: <ClockIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: reminderCopy.emptyTitle,
		description: reminderCopy.emptyText,
	},
	[Folders.SCHEDULED]: {
		icon: <ClockCountdownIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: scheduledCopy.emptyTitle,
		description: scheduledCopy.emptyText,
	},
	[Folders.TRASH]: {
		icon: <TrashIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Bin is empty",
		description:
			"Deleted emails will appear here. You can restore them or permanently delete them.",
	},
};

function EmailListSkeleton() {
	return (
		<div className="animate-pulse space-y-1 p-2">
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 px-3 py-3">
					<div className="w-4 h-4 rounded bg-kumo-fill" />
					<div className="w-5 h-5 rounded bg-kumo-fill" />
					<div className="flex-1 space-y-2">
						<div className="flex items-center gap-2">
							<div className="h-3 w-24 rounded bg-kumo-fill" />
							<div className="h-3 w-4 rounded bg-kumo-fill" />
							<div className="h-3 flex-1 rounded bg-kumo-fill" />
							<div className="h-3 w-12 rounded bg-kumo-fill" />
						</div>
						<div className="h-2.5 w-3/4 rounded bg-kumo-fill" />
					</div>
				</div>
			))}
		</div>
	);
}

function FolderEmptyState({
	folder,
	onCompose,
}: {
	folder?: string;
	onCompose: () => void;
}) {
	const config = (folder && FOLDER_EMPTY_STATES[folder]) || {
		icon: (
			<EnvelopeSimpleIcon size={48} weight="thin" className="text-kumo-subtle" />
		),
		title: "No emails",
		description: "This folder is empty.",
	};

	return (
		<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
			<div className="mb-4">{config.icon}</div>
			<h3 className="text-base font-semibold text-kumo-default mb-1.5">
				{config.title}
			</h3>
			<p className="text-sm text-kumo-subtle max-w-xs mb-5">
				{config.description}
			</p>
			{"showCompose" in config && config.showCompose && (
				<Button
					variant="primary"
					size="sm"
					icon={<PencilSimpleIcon size={16} />}
					onClick={onCompose}
				>
					Compose
				</Button>
			)}
		</div>
	);
}

/** Mail App: a row's label chips, with "+2" when there are more than fit. */
function ViaAddress({ address, mailboxId }: { address?: string | null; mailboxId?: string }) {
	if (!address || address.toLowerCase() === mailboxId?.toLowerCase()) return null;
	const short = address.slice(0, address.lastIndexOf("@") + 1);
	return (
		<Tooltip content={addressCopy.viaTip.replace("{address}", address)} asChild>
			<span className="shrink-0 max-w-[10rem] truncate text-xs text-kumo-subtle bg-kumo-fill rounded-full px-1.5 py-0.5">
				{addressCopy.via.replace("{address}", short)}
			</span>
		</Tooltip>
	);
}

function RowLabels({ email, labels, hideId }: { email: Email; labels: Label[]; hideId?: string }) {
	const ids = (email.labels ?? []).filter((id) => id !== hideId && labels.some((l) => l.id === id));
	if (ids.length === 0) return null;
	const shown = labels.filter((l) => ids.includes(l.id)).slice(0, MAX_ROW_CHIPS).map((l) => l.id);
	return (
		<span className="flex shrink-0 items-center gap-1 max-w-[60%] overflow-hidden">
			<LabelChips ids={shown} labels={labels} />
			{ids.length > shown.length && (
				<span className="shrink-0 text-[11px] font-medium text-kumo-subtle">+{ids.length - shown.length}</span>
			)}
		</span>
	);
}

export default function EmailListRoute() {
	const location = useLocation();
	const navigate = useNavigate();
	const { mailboxId, folder, labelId } = useParams<{
		mailboxId: string;
		folder: string;
		labelId: string;
	}>();
	const {
		selectedEmailId,
		isComposing,
		selectEmail,
		closePanel,
		startCompose,
	} = useUIStore();
	const wide = useIsWide();
	const [page, setPage] = useState(1);

	const queryClient = useQueryClient();
	const updateEmail = useUpdateEmail();
	const markThreadRead = useMarkThreadRead();
	const deleteEmail = useDeleteEmail();
	const updateConversations = useUpdateConversations();
	const markAllRead = useMarkAllRead();
	const spamAction = useSpamAction();
	const toastManager = useKumoToastManager();
	// Mail App: the conversations ticked in the list.
	const [picked, setPicked] = useState<Set<string>>(() => new Set());
	// Mail App: the conversations the Snooze box is open for.
	const [snoozing, setSnoozing] = useState<string[] | null>(null);

	const params = useMemo<Record<string, string>>(
		() => ({
			...(labelId ? { label: labelId } : { folder: folder || "" }),
			page: String(page),
			limit: String(PAGE_SIZE),
		}),
		[folder, labelId, page],
	);

	const {
		data: emailData,
		isFetching: isRefreshing,
	} = useEmails(mailboxId, params, { refetchInterval: 30_000 });

	const emails = emailData?.emails ?? [];
	const totalCount = emailData?.totalCount ?? 0;

	const { data: folders = [] } = useFolders(mailboxId);
	const { data: labels = [] } = useLabels(mailboxId);
	const currentLabel = labelId ? labels.find((l) => l.id === labelId) : undefined;
	// Mail App: with more than one mailbox to open, the heading says whose this is ("Inbox · Acme Sales").
	const { data: allMailboxes = [] } = useMailboxes();
	const { data: thisMailbox } = useMailbox(mailboxId);
	const whose = allMailboxes.filter((m) => m.canOpen !== false).length > 1 && thisMailbox ? mailboxLabel(thisMailbox) : null;

	const folderName = useMemo(() => {
		if (labelId) return currentLabel?.name ?? labelCopy.heading;
		const found = folders.find((f) => f.id === folder);
		if (found) return found.name;
		return folder ? folder.charAt(0).toUpperCase() + folder.slice(1) : "Inbox";
	}, [folders, folder, labelId, currentLabel?.name]);

	// Mail App: on wider screens a new email floats in its own box, so it doesn't open the side panel.
	const isPanelOpen = selectedEmailId !== null || (isComposing && !wide);

	// Track folder identity to detect folder changes vs page changes
	const prevFolderRef = useRef<string | undefined>(undefined);

	useEffect(() => {
		const folderChanged = prevFolderRef.current !== `${mailboxId}/${folder}/${labelId}`;
		prevFolderRef.current = `${mailboxId}/${folder}/${labelId}`;

		if (folderChanged) {
			closePanel();
			setPage(1);
			setPicked(new Set());
		}
		// Mail App: "Write email" on the Contacts page lands here with who to write to; on phones, "Send by email"
		// and "Email the link" on the Files page land here with the file or the link.
		const state = location.state as { composeTo?: string; composeFiles?: File[]; composeSubject?: string; composeText?: string; openEmail?: string } | null;
		// Mail App: "Open" on Reports > Find an email lands here with the email to show.
		if (state?.openEmail) {
			selectEmail(state.openEmail);
			navigate(".", { replace: true, state: null });
		}
		if (state?.composeTo || state?.composeFiles?.length || state?.composeText) {
			startCompose({ mode: "new", originalEmail: null, to: state.composeTo, files: state.composeFiles, subject: state.composeSubject, text: state.composeText });
			navigate(".", { replace: true, state: null });
		}
	}, [mailboxId, folder, labelId, closePanel, location.state, startCompose, navigate, selectEmail]);

	const toggleStar = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId)
			updateEmail.mutate({
				mailboxId,
				id: email.id,
				data: { starred: !email.starred },
			});
	};

	const handleDelete = (e: React.MouseEvent, emailId: string) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId) {
			const confirmed = window.confirm("Are you sure you want to delete this email?");
			if (!confirmed) return;
			deleteEmail.mutate({ mailboxId, id: emailId });
			if (selectedEmailId === emailId) closePanel();
		}
	};

	const handleRefresh = () => {
		if (mailboxId) {
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		}
	};

	// Mail App: tick boxes. Acting on ticked conversations clears the ticks.
	const togglePick = (id: string) =>
		setPicked((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const allPicked = emails.length > 0 && emails.every((e) => picked.has(e.id));
	const pickAll = () => setPicked(allPicked ? new Set() : new Set(emails.map((e) => e.id)));
	const pickedCount = picked.size;
	const inTrash = folder === Folders.TRASH;
	const conversations = (n: number) => `${n} conversation${n === 1 ? "" : "s"}`;
	const actOn = (ids: string[], action: "move" | "read" | "unread" | "delete", folderId?: string, done?: string) => {
		if (!mailboxId || ids.length === 0) return;
		updateConversations.mutate(
			{ mailboxId, ids, action, folderId, fromFolder: labelId ? undefined : folder },
			{
				onSuccess: () => { if (done) toastManager.add({ title: done }); },
				onError: () => toastManager.add({ title: "That didn't work. Please try again.", variant: "error" }),
			},
		);
		if ((action === "move" || action === "delete") && selectedEmailId && ids.includes(selectedEmailId)) closePanel();
		setPicked(new Set());
	};
	const actOnPicked = (action: "move" | "read" | "unread" | "delete", folderId?: string, done?: string) =>
		actOn([...picked], action, folderId, done);
	const trashOrDelete = (ids: string[]) => {
		if (inTrash) {
			if (!window.confirm(`Delete ${conversations(ids.length)} forever? This can't be undone.`)) return;
			actOn(ids, "delete", undefined, `${conversations(ids.length)} deleted`);
		} else {
			actOn(ids, "move", Folders.TRASH, `${conversations(ids.length)} moved to Bin`);
		}
	};
	const moveTargets = folders.filter((f) => f.id !== folder && f.id !== Folders.DRAFT && !NOT_MOVE_TARGETS.includes(f.id));
	// Mail App: Snooze from anywhere but Drafts, Spam and the Bin.
	const canSnooze = folder !== Folders.DRAFT && folder !== Folders.SPAM && !inTrash;
	const snooze = (ids: string[]) => { if (ids.length) setSnoozing(ids); };
	const unreadHere = labelId
		? (currentLabel?.unreadCount ?? 0)
		: (folders.find((f) => f.id === folder)?.unreadCount ?? 0);
	const handleMarkAllRead = () => {
		if (!mailboxId) return;
		markAllRead.mutate(
			labelId ? { mailboxId, labelId } : { mailboxId, folderId: folder },
			{ onSuccess: () => toastManager.add({ title: `Everything in ${folderName} is marked as read` }) },
		);
	};

	// Mail App: the right-click menu (press and hold on phones). On a ticked email it acts on all the ticked ones.
	const [menu, setMenu] = useState<{ email: Email; at: MenuPoint } | null>(null);
	const closeMenu = useCallback(() => setMenu(null), []);
	const longPress = useLongPress<Email>((at, email) => setMenu({ email, at }));
	const openMenu = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		// The keyboard's menu key gives no position, so the menu opens under the row instead.
		const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: box.left + 48, y: box.bottom };
		setMenu({ email, at });
	};
	// Reply and Forward need the whole message, which the list doesn't carry.
	const startReply = async (email: Email, mode: "reply" | "reply-all" | "forward") => {
		if (!mailboxId) return;
		try {
			const thread = email.thread_id && (email.thread_count ?? 1) > 1
				? await queryClient.fetchQuery({
					queryKey: queryKeys.emails.thread(mailboxId, email.thread_id),
					queryFn: () => api.getThread(mailboxId, email.thread_id!) as Promise<Email[]>,
				})
				: [await queryClient.fetchQuery({
					queryKey: queryKeys.emails.detail(mailboxId, email.id),
					queryFn: () => api.getEmail(mailboxId, email.id) as Promise<Email>,
				})];
			const sent = thread
				.filter((m) => m.folder_id !== Folders.DRAFT)
				.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
			const latest = sent[0] ?? thread[0];
			// As the open email does: reply to the newest message someone else sent.
			const mine = thisMailbox?.email?.toLowerCase();
			const target = mode === "forward" ? latest : (sent.find((m) => m.sender?.toLowerCase() !== mine) ?? latest);
			startCompose({ mode, originalEmail: target });
		} catch {
			toastManager.add({ title: "That didn't work. Please try again.", variant: "error" });
		}
	};
	const menuItems = (email: Email): { title: string; items: MenuItem[] } => {
		const many = picked.has(email.id) && pickedCount > 1;
		const ids = many ? [...picked] : [email.id];
		const n = ids.length;
		const isDraft = folder === Folders.DRAFT;
		const unread = many ? emails.some((e) => picked.has(e.id) && hasUnread(e)) : hasUnread(email);
		const doneMoving = (id: string) => `${many ? conversations(n) : "Conversation"} moved to ${folders.find((f) => f.id === id)?.name ?? "the folder"}`;
		const items: MenuItem[] = [];
		if (!many && !isDraft) {
			items.push(
				{ kind: "item", label: "Reply", icon: <ArrowBendUpLeftIcon size={16} />, onSelect: () => startReply(email, "reply") },
				{ kind: "item", label: "Reply all", icon: <ChatCircleIcon size={16} />, onSelect: () => startReply(email, "reply-all") },
				{ kind: "item", label: "Forward", icon: <ArrowBendUpRightIcon size={16} />, onSelect: () => startReply(email, "forward") },
				{ kind: "separator" },
			);
		}
		items.push(
			unread
				? { kind: "item", label: "Mark as read", icon: <EnvelopeOpenIcon size={16} />, onSelect: () => actOn(ids, "read") }
				: { kind: "item", label: "Mark as unread", icon: <EnvelopeSimpleIcon size={16} />, onSelect: () => actOn(ids, "unread") },
		);
		if (!many) {
			items.push({
				kind: "item",
				label: email.starred ? "Unstar" : "Star",
				icon: <StarIcon size={16} />,
				onSelect: () => mailboxId && updateEmail.mutate({ mailboxId, id: email.id, data: { starred: !email.starred } }),
			});
		}
		if (folder !== Folders.ARCHIVE && !isDraft) {
			items.push({ kind: "item", label: "Archive", icon: <ArchiveIcon size={16} />, onSelect: () => actOn(ids, "move", Folders.ARCHIVE, doneMoving(Folders.ARCHIVE)) });
		}
		if (canSnooze) {
			items.push({ kind: "item", label: reminderCopy.snooze, icon: <ClockIcon size={16} />, onSelect: () => snooze(ids) });
		}
		if (moveTargets.length > 0) {
			items.push({ kind: "move", label: "Move to", icon: <FolderSimpleIcon size={16} />, folders: moveTargets, onMove: (id) => actOn(ids, "move", id, doneMoving(id)) });
		}
		if (!many && mailboxId) {
			items.push({ kind: "labels", label: labelCopy.menuTitle, icon: <TagIcon size={16} />, mailboxId, email, labels });
		}
		// As the open email's Block sender and Not spam buttons: only on mail someone else sent.
		const sender = email.sender?.toLowerCase();
		if (!many && !isDraft && folder !== Folders.SENT && folder !== Folders.SCHEDULED && sender && sender !== thisMailbox?.email?.toLowerCase()) {
			const notSpam = folder === Folders.SPAM;
			items.push({
				kind: "item",
				label: notSpam ? "Not spam" : "Mark as spam",
				icon: notSpam ? <TrayArrowUpIcon size={16} /> : <ProhibitIcon size={16} />,
				onSelect: () => {
					if (!mailboxId) return;
					if (!notSpam && !window.confirm(`Move this to Spam and block ${email.sender}? Their mail will go straight to Spam. You can unblock them in Settings.`)) return;
					spamAction.mutate({ mailboxId, action: notSpam ? "not-spam" : "block", sender: email.sender, emailId: email.id }, {
						onSuccess: () => toastManager.add({ title: notSpam ? "Moved to Inbox. Mail from this sender won't go to Spam." : `Moved to Spam and blocked ${email.sender}` }),
						onError: () => toastManager.add({ title: "That didn't work. Please try again.", variant: "error" }),
					});
					if (selectedEmailId === email.id) closePanel();
				},
			});
		}
		items.push(
			{ kind: "separator" },
			{ kind: "item", label: inTrash ? "Delete forever" : "Delete", icon: <TrashIcon size={16} />, danger: true, onSelect: () => trashOrDelete(ids) },
		);
		return { title: many ? `${n} selected` : email.subject || "(no subject)", items };
	};

	// Mail App: keyboard shortcuts for the list (the open email has its own, in EmailPanel).
	const [helpOpen, setHelpOpen] = useState(false);
	const openAt = (step: number) => {
		if (emails.length === 0) return;
		const at = emails.findIndex((e) => e.id === selectedEmailId);
		const next = at === -1 ? 0 : Math.min(Math.max(at + step, 0), emails.length - 1);
		const email = emails[next];
		handleRowClick(email);
		document.querySelector(`[data-email-row="${CSS.escape(email.id)}"]`)?.scrollIntoView({ block: "nearest" });
	};
	useShortcuts({
		c: () => startCompose(),
		"/": () => document.querySelector<HTMLInputElement>('input[aria-label="Search emails"]')?.focus(),
		j: () => openAt(1),
		k: () => openAt(-1),
		x: () => { if (selectedEmailId) togglePick(selectedEmailId); },
		e: () => { if (!selectedEmailId && pickedCount > 0 && folder !== Folders.ARCHIVE) actOnPicked("move", Folders.ARCHIVE, `${conversations(pickedCount)} moved to Archive`); },
		"?": () => setHelpOpen(true),
	});

	// Thread-aware helpers
	const hasUnread = (email: Email): boolean => {
		if (email.thread_unread_count !== undefined) {
			return email.thread_unread_count > 0;
		}
		return !email.read;
	};

	const handleRowClick = (email: Email) => {
		selectEmail(email.id);
		if (mailboxId && hasUnread(email)) {
			if (email.thread_id && email.thread_count && email.thread_count > 1) {
				markThreadRead.mutate({
					mailboxId,
					threadId: email.thread_id,
				});
			} else {
				updateEmail.mutate({
					mailboxId,
					id: email.id,
					data: { read: true },
				});
			}
		}
	};

	const formatParticipants = (email: Email): string => {
		// Mail App: an email of yours back because nobody replied says who it went to.
		if (email.no_reply === "due" && (email.thread_count ?? 1) === 1 && email.recipient) {
			return `To: ${email.recipient.split(",")[0].trim().split("@")[0]}`;
		}
		if (email.participants) {
			const names = email.participants
				.split(",")
				// Each is a name ("Hannah Clarke") or, for mail without one, an address shown as "hannah".
				.map((p) => p.trim().split("@")[0])
				.filter((name, idx, arr) => arr.indexOf(name) === idx);
			if (names.length <= 3) return names.join(", ");
			return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
		}
		return email.sender_name || email.sender.split("@")[0];
	};

	return (
		<MailboxSplitView
			selectedEmailId={selectedEmailId}
			isComposing={isComposing}
		>
				{/* Folder header. Mail App: with conversations ticked, it becomes the bar of things to do to them. */}
				<div className="flex items-center gap-2 px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5 min-h-[61px]">
					{emails.length > 0 && (
						<input
							type="checkbox"
							checked={allPicked}
							ref={(el) => { if (el) el.indeterminate = pickedCount > 0 && !allPicked; }}
							onChange={pickAll}
							aria-label={allPicked ? "Untick all" : "Tick all on this page"}
							title={allPicked ? "Untick all" : "Tick all on this page"}
							className="size-4 shrink-0 cursor-pointer accent-kumo-brand"
						/>
					)}
					{pickedCount > 0 ? (
						<>
							<span className="text-sm font-medium text-kumo-default mr-1 whitespace-nowrap">{pickedCount} selected</span>
							<div className="flex items-center gap-0.5">
								{folder !== Folders.ARCHIVE && (
									<Tooltip content="Archive" side="bottom" asChild>
										<Button variant="ghost" shape="square" size="sm" icon={<ArchiveIcon size={18} />} aria-label="Archive"
											onClick={() => actOnPicked("move", Folders.ARCHIVE, `${conversations(pickedCount)} moved to Archive`)} />
									</Tooltip>
								)}
								{canSnooze && (
									<Tooltip content={reminderCopy.snooze} side="bottom" asChild>
										<Button variant="ghost" shape="square" size="sm" icon={<ClockIcon size={18} />} aria-label={reminderCopy.snooze}
											onClick={() => snooze([...picked])} />
									</Tooltip>
								)}
								<MoveToFolderMenu folders={moveTargets} onMove={(id) => {
									const name = folders.find((f) => f.id === id)?.name ?? "the folder";
									actOnPicked("move", id, `${conversations(pickedCount)} moved to ${name}`);
								}} />
								<Tooltip content="Mark as read" side="bottom" asChild>
									<Button variant="ghost" shape="square" size="sm" icon={<EnvelopeOpenIcon size={18} />} aria-label="Mark as read"
										onClick={() => actOnPicked("read")} />
								</Tooltip>
								<Tooltip content="Mark as unread" side="bottom" asChild>
									<Button variant="ghost" shape="square" size="sm" icon={<EnvelopeSimpleIcon size={18} />} aria-label="Mark as unread"
										onClick={() => actOnPicked("unread")} />
								</Tooltip>
								<Tooltip content={inTrash ? "Delete forever" : "Delete"} side="bottom" asChild>
									<Button variant="ghost" shape="square" size="sm" icon={<TrashIcon size={18} />} aria-label={inTrash ? "Delete forever" : "Delete"}
										onClick={() => trashOrDelete([...picked])} />
								</Tooltip>
							</div>
							<Tooltip content="Clear selection" side="bottom" asChild>
								<Button variant="ghost" shape="square" size="sm" icon={<XIcon size={18} />} aria-label="Clear selection"
									onClick={() => setPicked(new Set())} className="ml-auto" />
							</Tooltip>
						</>
					) : (
						<>
							<h1 className="flex min-w-0 items-center gap-2 text-lg font-semibold text-kumo-default">
								{currentLabel && <LabelDot color={currentLabel.color} />}
								<span className="truncate">{folderName}</span>
								{whose && <span className="truncate font-normal text-kumo-subtle">· {whose}</span>}
							</h1>
							<div className="flex items-center gap-1 ml-auto">
								{totalCount > 0 && (
									<span className="text-sm text-kumo-subtle mr-2 hidden sm:inline">
										{totalCount} conversation{totalCount !== 1 ? "s" : ""}
									</span>
								)}
								{unreadHere > 0 && (
									<Tooltip content="Mark all as read" side="bottom" asChild>
										<Button
											variant="ghost"
											shape="square"
											size="sm"
											icon={<ChecksIcon size={18} />}
											onClick={handleMarkAllRead}
											aria-label="Mark all as read"
										/>
									</Tooltip>
								)}
								<Tooltip
									content={isRefreshing ? "Refreshing..." : "Refresh"}
									side="bottom"
									asChild
								>
									<Button
										variant="ghost"
										shape="square"
										size="sm"
										icon={
											<ArrowsClockwiseIcon
												size={18}
												className={isRefreshing ? "animate-spin" : ""}
											/>
										}
										onClick={handleRefresh}
										disabled={isRefreshing}
										aria-label="Refresh"
									/>
								</Tooltip>
							</div>
						</>
					)}
				</div>

				{/* Email rows */}
				<div className="flex-1 overflow-y-auto pb-24 md:pb-0">
				{/* Mail App: suggests Mail App on the Dock or home screen, in the inbox only. */}
				{folder === Folders.INBOX && !labelId && <AppTip />}
				{isRefreshing && emails.length === 0 ? (
					<EmailListSkeleton />
				) : emails.length > 0 ? (
						<div>
							{emails.map((email) => {
								const isSelected = selectedEmailId === email.id;
								const isPicked = picked.has(email.id);
								const snippet = getSnippetText(email.snippet);
								return (
									<LabelDropZone key={email.id} mailboxId={mailboxId} email={email}>
									{(drop) => (
									<div
										{...drop.props}
										{...longPress.bind(email)}
										data-email-row={email.id}
										role="button"
										tabIndex={0}
										aria-haspopup="menu"
										onContextMenu={(e) => openMenu(e, email)}
										onClick={() => { if (!longPress.opened()) handleRowClick(email); }}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												handleRowClick(email);
											}
										}}
										className={`group flex items-center gap-3 w-full text-left cursor-pointer transition-colors [-webkit-touch-callout:none] pointer-coarse:select-none ${menu?.email.id === email.id ? "bg-kumo-tint" : ""} border-b border-kumo-line px-4 py-2.5 md:px-6 md:py-3 ${
											isPanelOpen ? "md:px-4 md:py-2.5" : ""
										} ${isSelected || isPicked ? "bg-kumo-tint" : "hover:bg-kumo-tint"} ${drop.over ? "bg-kumo-tint outline-2 -outline-offset-2 outline-dashed outline-kumo-brand" : ""}`}
									>
										{/* Mail App: tick box */}
										<input
											type="checkbox"
											checked={isPicked}
											onClick={(e) => e.stopPropagation()}
											onKeyDown={(e) => e.stopPropagation()}
											onChange={() => togglePick(email.id)}
											aria-label={`Select: ${email.subject || "(no subject)"}`}
											className="size-4 shrink-0 cursor-pointer accent-kumo-brand"
										/>

										{/* Unread dot */}
										<div className="w-2.5 shrink-0 flex justify-center">
											{hasUnread(email) && (
												<div className="h-2 w-2 rounded-full bg-kumo-brand" />
											)}
										</div>

										{/* Star */}
										<button
											type="button"
											className="shrink-0 p-0.5 bg-transparent border-0 cursor-pointer"
											onClick={(e) => {
												e.stopPropagation();
												toggleStar(e, email);
											}}
										>
											<StarIcon
												size={16}
												weight={email.starred ? "fill" : "regular"}
												className={
													email.starred
														? "text-kumo-warning"
														: "text-kumo-subtle hover:text-kumo-warning"
												}
											/>
										</button>

										{/* Content */}
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span
													className={`truncate text-sm ${hasUnread(email) ? "font-semibold text-kumo-default" : "text-kumo-strong"}`}
												>
													{formatParticipants(email)}
												</span>
												{/* Mail App: which extra address it was sent to, when it wasn't the main one */}
												<ViaAddress address={email.delivered_to} mailboxId={mailboxId} />
												{(email.thread_count ?? 1) > 1 && (
													<span className="shrink-0 text-xs text-kumo-subtle bg-kumo-fill rounded-full px-1.5 py-0.5 font-medium">
														{email.thread_count}
													</span>
												)}
												{email.has_draft && (
													<span className="shrink-0 text-xs text-kumo-destructive font-medium">
														Draft
													</span>
												)}
												{/* Mail App: snoozed until, waiting for a reply, or back because nobody replied */}
												{email.no_reply === "due" && (
													<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
														<BellRingingIcon size={12} weight="bold" />{reminderCopy.noReplyTag}
													</span>
												)}
												{typeof email.no_reply === "number" && (
													<Tooltip content={fill(reminderCopy.remindPending, { when: formatWhen(email.no_reply) })} asChild>
														<span className="shrink-0 text-kumo-subtle"><BellSimpleIcon size={14} weight="bold" /></span>
													</Tooltip>
												)}
												{folder === Folders.SCHEDULED && email.send_at && (
													<span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-300">
														<ClockCountdownIcon size={12} weight="bold" />{fill(scheduledCopy.tag, { when: formatWhen(email.send_at) })}
													</span>
												)}
												{folder === Folders.SNOOZED && email.snoozed_until && (
													<span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-300">
														<ClockIcon size={12} weight="bold" />{fill(reminderCopy.snoozedTag, { when: formatWhen(email.snoozed_until) })}
													</span>
												)}
												{email.needs_reply && !email.has_draft && (
													<Tooltip content="Needs reply" asChild>
														<span className="shrink-0 text-kumo-warning">
															<ArrowBendUpLeftIcon size={14} weight="bold" />
														</span>
													</Tooltip>
												)}
												<span className="text-sm text-kumo-subtle shrink-0 ml-auto">
													{formatListDate(email.shown_at || email.date)}
												</span>
											</div>
											<div className="flex items-center gap-1 min-w-0 text-sm mt-0.5">
												{/* Mail App: label chips before the subject, leaving out the label whose page this is */}
												<RowLabels email={email} labels={labels} hideId={labelId} />
												<div className="truncate min-w-0">
													<span
														className={hasUnread(email) ? "font-medium text-kumo-default" : "text-kumo-subtle"}
													>
														{email.subject}
													</span>
												{snippet && (
													<span className="text-kumo-subtle font-normal">
														{" "}&mdash; {snippet}
													</span>
												)}
												</div>
										</div>
									</div>

										{/* Hover actions */}
										<div className="hidden group-hover:flex has-[[aria-expanded=true]]:flex items-center shrink-0">
											{mailboxId && <LabelMenu mailboxId={mailboxId} email={email} compact align="right" />}
											<Tooltip content={email.read ? "Mark unread" : "Mark read"} asChild>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={email.read ? <EnvelopeSimpleIcon size={14} /> : <EnvelopeOpenIcon size={14} />}
													onClick={(e) => {
														e.stopPropagation();
														if (mailboxId)
															updateEmail.mutate({
																mailboxId,
																id: email.id,
																data: { read: !email.read },
															});
													}}
													aria-label={email.read ? "Mark unread" : "Mark read"}
												/>
											</Tooltip>
											<Tooltip content="Delete" asChild>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={<TrashIcon size={14} />}
													onClick={(e) => handleDelete(e, email.id)}
													aria-label="Delete"
												/>
											</Tooltip>
										</div>
									</div>
									)}
									</LabelDropZone>
								);
							})}
						</div>
					) : (
						labelId ? (
							<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
								<div className="mb-4"><TagIcon size={48} weight="thin" className="text-kumo-subtle" /></div>
								<h3 className="text-base font-semibold text-kumo-default mb-1.5">{labelCopy.emptyTitle}</h3>
								<p className="text-sm text-kumo-subtle max-w-xs">{labelCopy.emptyText}</p>
							</div>
						) : (
						<FolderEmptyState
							folder={folder}
							onCompose={() => startCompose()}
						/>
						)
					)}
				</div>

				{/* Pagination */}
				{totalCount > PAGE_SIZE && (
					<div className="flex justify-center py-3 border-t border-kumo-line shrink-0">
						<Pagination
							page={page}
							setPage={(p: number) => { setPage(p); setPicked(new Set()); }}
							perPage={PAGE_SIZE}
							totalCount={totalCount}
						/>
					</div>
				)}
			{menu && (() => {
				const { title, items } = menuItems(menu.email);
				return <EmailContextMenu key={`${menu.email.id}:${menu.at.x}:${menu.at.y}`} at={menu.at} title={title} items={items} onClose={closeMenu} />;
			})()}
			<Dialog.Root open={helpOpen} onOpenChange={setHelpOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">Keyboard shortcuts</Dialog.Title>
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
						{SHORTCUT_LIST.map(([key, what]) => (
							<div key={key} className="contents">
								<dt><kbd className="rounded border border-kumo-line bg-kumo-recessed px-1.5 py-0.5 font-mono text-xs">{key}</kbd></dt>
								<dd className="text-kumo-default">{what}</dd>
							</div>
						))}
					</dl>
				</Dialog>
			</Dialog.Root>
			{snoozing && mailboxId && (
				<SnoozeDialog
					mailboxId={mailboxId}
					ids={snoozing}
					fromFolder={labelId ? undefined : folder}
					onClose={() => setSnoozing(null)}
					onSnoozed={() => {
						if (selectedEmailId && snoozing.includes(selectedEmailId)) closePanel();
						setPicked(new Set());
					}}
				/>
			)}
		</MailboxSplitView>
	);
}
