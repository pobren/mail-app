// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: "Block sender" and "Not spam" buttons; Label button; one-click Archive button; Print button; "Make a rule" button; Snooze, and "Remind me if no reply" on sent mail.

import { Button, Tooltip } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import {
	ArchiveIcon,
	ArrowBendUpLeftIcon,
	ArrowBendUpRightIcon,
	ArrowLeftIcon,
	ChatCircleIcon,
	ClockIcon,
	CodeIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FolderSimpleIcon,
	FunnelSimpleIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	PrinterIcon,
	ProhibitIcon,
	TrayArrowUpIcon,
	StarIcon,
	TrashIcon,
	XIcon,
} from "@phosphor-icons/react";
import type { Folder, Email } from "~/types";

interface EmailPanelToolbarProps {
	email: Email;
	mailboxId?: string;
	isDraftFolder: boolean;
	isSending: boolean;
	moveToFolders: Folder[];
	lastReceivedMessage?: Email;
	onBack: () => void;
	onSendDraft: () => void;
	onEditDraft: () => void;
	onReply: () => void;
	onReplyAll: () => void;
	onForward: () => void;
	onToggleStar: () => void;
	onToggleRead: () => void;
	onMove: (folderId: string) => void;
	/** Mail App: one click to Archive. Left out when the email is already there. */
	onArchive?: () => void;
	/** Mail App: opens the Snooze box. */
	onSnooze?: () => void;
	/** Mail App: the "Remind me if no reply" bell, on mail you sent. */
	remindMenu?: React.ReactNode;
	/** Mail App: which spam button to show, if any. */
	spamAction?: "block" | "not-spam";
	onSpam?: (action: "block" | "not-spam") => void;
	/** Mail App: start an inbox rule for mail from this sender. */
	onMakeRule?: () => void;
	onViewSource: () => void;
	/** Mail App: print the email, or the whole conversation. */
	onPrint?: () => void;
	onDelete: () => void;
	/** Mail App: the Label button. */
	labelMenu?: React.ReactNode;
}

export default function EmailPanelToolbar({
	email,
	mailboxId,
	isDraftFolder,
	isSending,
	moveToFolders,
	onBack,
	onSendDraft,
	onEditDraft,
	onReply,
	onReplyAll,
	onForward,
	onToggleStar,
	onToggleRead,
	onMove,
	onArchive,
	onSnooze,
	remindMenu,
	spamAction,
	onSpam,
	onMakeRule,
	onViewSource,
	onPrint,
	onDelete,
	labelMenu,
}: EmailPanelToolbarProps) {
	return (
		<div className="flex items-center gap-1 px-3 py-2 border-b border-kumo-line shrink-0 md:px-4">
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={<ArrowLeftIcon size={18} />}
				onClick={onBack}
				aria-label="Back to list"
				className="md:hidden shrink-0"
			/>

			{isDraftFolder ? (
				<>
					<Button
						variant="primary"
						size="sm"
						icon={<PaperPlaneTiltIcon size={16} />}
						onClick={onSendDraft}
						loading={isSending}
					>
						{isSending ? "Sending..." : "Send"}
					</Button>
					<Button
						variant="secondary"
						size="sm"
						icon={<PencilSimpleIcon size={16} />}
						onClick={onEditDraft}
					>
						Edit
					</Button>
				</>
			) : (
				<>
					<Tooltip content="Reply" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowBendUpLeftIcon size={18} />}
							onClick={onReply}
							aria-label="Reply"
						/>
					</Tooltip>
					<Tooltip content="Reply All" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ChatCircleIcon size={18} />}
							onClick={onReplyAll}
							aria-label="Reply All"
						/>
					</Tooltip>
					<Tooltip content="Forward" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowBendUpRightIcon size={18} />}
							onClick={onForward}
							aria-label="Forward"
						/>
					</Tooltip>
				</>
			)}

			<div className="h-5 w-px bg-kumo-fill mx-0.5" />

			<Tooltip content={email.starred ? "Unstar" : "Star"} side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={
						<StarIcon
							size={18}
							weight={email.starred ? "fill" : "regular"}
							className={email.starred ? "text-kumo-warning" : ""}
						/>
					}
					onClick={onToggleStar}
					aria-label={email.starred ? "Unstar" : "Star"}
				/>
			</Tooltip>

			<Tooltip content={email.read ? "Mark as unread" : "Mark as read"} side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={email.read ? <EnvelopeSimpleIcon size={18} /> : <EnvelopeOpenIcon size={18} />}
					onClick={onToggleRead}
					aria-label={email.read ? "Mark as unread" : "Mark as read"}
				/>
			</Tooltip>

			{onArchive && (
				<Tooltip content="Archive" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ArchiveIcon size={18} />}
						onClick={onArchive}
						aria-label="Archive"
					/>
				</Tooltip>
			)}
			{onSnooze && (
				<Tooltip content="Snooze" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ClockIcon size={18} />}
						onClick={onSnooze}
						aria-label="Snooze"
					/>
				</Tooltip>
			)}
			{remindMenu}
			<MoveToFolderMenu folders={moveToFolders} onMove={onMove} />
			{labelMenu}

			{spamAction === "not-spam" && (
				<Button
					variant="secondary"
					size="sm"
					icon={<TrayArrowUpIcon size={16} />}
					onClick={() => onSpam?.("not-spam")}
					className="ml-1"
				>
					Not spam
				</Button>
			)}
			{spamAction === "block" && (
				<Tooltip content="Block sender" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ProhibitIcon size={18} />}
						onClick={() => onSpam?.("block")}
						aria-label="Block sender"
					/>
				</Tooltip>
			)}

			{onMakeRule && (
				<Tooltip content="Make a rule for mail like this" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<FunnelSimpleIcon size={18} />}
						onClick={onMakeRule}
						aria-label="Make a rule for mail like this"
						className="hidden md:inline-flex"
					/>
				</Tooltip>
			)}

			<div className="ml-auto flex items-center gap-0.5">
				{onPrint && (
					<Tooltip content="Print" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<PrinterIcon size={18} />}
							onClick={onPrint}
							aria-label="Print"
							className="hidden md:inline-flex"
						/>
					</Tooltip>
				)}
				<Tooltip content="View source" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<CodeIcon size={18} />}
						onClick={onViewSource}
						aria-label="View source"
					/>
				</Tooltip>
				<Tooltip content="Delete" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<TrashIcon size={18} />}
						onClick={onDelete}
						aria-label="Delete"
					/>
				</Tooltip>
				<Tooltip content="Close" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<XIcon size={18} />}
						onClick={onBack}
						aria-label="Close"
						className="hidden md:inline-flex"
					/>
				</Tooltip>
			</div>
		</div>
	);
}

export function MoveToFolderMenu({ folders, onMove }: { folders: Folder[]; onMove: (id: string) => void }) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	return (
		<div ref={ref} className="relative">
			<Tooltip content="Move to folder" side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={<FolderSimpleIcon size={18} />}
					onClick={() => setOpen((o) => !o)}
					aria-label="Move to folder"
				/>
			</Tooltip>
			{open && (
				<div className="absolute top-full left-0 z-50 mt-1 min-w-[160px] rounded-lg border border-kumo-line bg-kumo-elevated shadow-lg py-1">
					<div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle">Move to</div>
					<div className="h-px bg-kumo-line my-1" />
					{folders.map((f) => (
						<button
							key={f.id}
							type="button"
							className="w-full text-left px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-overlay transition-colors"
							onClick={() => { onMove(f.id); setOpen(false); }}
						>
							{f.name}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
