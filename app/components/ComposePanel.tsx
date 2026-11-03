// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: attachments (attach, drag and drop, paste), kept in drafts and forwards, with a size check; files too big to attach go as download links; templates; contact suggestions in the address boxes; pictures dropped or pasted into the message stay in it; the editor loads only when composing; Send stays in view; on wider screens it sits in a floating box that can be minimised or made full screen; a From line when the mailbox has extra addresses; in a shared mailbox, a "Sent as" line with your name; attach from Files; "Remind me if no reply". Scheduled send. In a narrow box the footer buttons drop their words (icons only) so Send never goes off the edge.

import { Banner, Button, DropdownMenu, Input } from "@cloudflare/kumo";
import { ArrowsInSimpleIcon, ArrowsOutSimpleIcon, BellRingingIcon, BellSimpleIcon, BellSimpleSlashIcon, ClockCountdownIcon, DesktopIcon, FloppyDiskIcon, FolderSimpleIcon, GearIcon, MinusIcon, NotepadIcon, PaperclipIcon, PaperPlaneTiltIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { type ClipboardEvent, type DragEvent, lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useComposeForm } from "~/hooks/useComposeForm";
import copy from "~/copy/compose.en-GB.json";
import ComposeAttachments from "./ComposeAttachments";
import { PickFilesDialog } from "./files/FileDialogs";
import filesCopy from "~/copy/files.en-GB.json";
import reminderCopy from "~/copy/reminders.en-GB.json";
import { NO_REPLY_DAYS } from "shared/reminders";
import { dayWords } from "./Reminders";
import { ScheduleDialog } from "./ScheduleSend";
import scheduledCopy from "~/copy/scheduled.en-GB.json";
import { fill } from "~/lib/attachments";
import RecipientInput from "./RecipientInput";
import { useContacts } from "~/queries/contacts";
import { useMailbox } from "~/queries/mailboxes";
import { isPicture } from "~/lib/inline-picture";
import { type ComposeSize, useUIStore } from "~/hooks/useUIStore";

// The editor is only downloaded when someone starts writing, so reading mail stays quick.
const RichTextEditor = lazy(() => import("./RichTextEditor"));

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
// Pictures dropped or pasted into the message itself go in the text; the editor handles those.
const intoMessage = (target: EventTarget | null, files: File[]) =>
	files.length > 0 && files.every(isPicture) && target instanceof Element && !!target.closest(".ProseMirror");

interface ComposePanelProps {
	/** Mail App: set when the composer is in the floating box (ComposeDock). */
	size?: ComposeSize;
	onSize?: (size: ComposeSize) => void;
}

export default function ComposePanel({ size, onSize }: ComposePanelProps = {}) {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();

	const {
		to,
		setTo,
		cc,
		setCc,
		bcc,
		setBcc,
		showCcBcc,
		setShowCcBcc,
		subject,
		setSubject,
		body,
		setBody,
		error,
		isSavingDraft,
		isSending,
		formTitle,
		handleSaveDraft,
		handleSend,
		countdown,
		undoSend,
		sendNow,
		fromAddress,
		setFromAddress,
		fromOptions,
		sentAs,
		closeCompose,
		attachments,
		addFiles,
		removeAttachment,
		attachmentBytes,
		attachmentLimit,
		attachmentsTooBig,
		tooBigText,
		isForward,
		linkKeys,
		linksOn,
		protectLinks,
		setProtectLinks,
		linkPassword,
		setLinkPassword,
		templates,
		insertTemplate,
		remindDays,
		setRemindDays,
	} = useComposeForm(mailboxId, folder);
	const navigate = useNavigate();
	const finishCompose = useUIStore((s) => s.finishCompose);
	const docked = !!size && !!onSize;
	const minimised = size === "minimised";
	// Mail App: undo send. While Send waits, the box shrinks to a bar with Undo, and Undo brings it back.
	const counting = countdown !== null;
	const sizeBeforeSend = useRef<ComposeSize>("normal");
	useEffect(() => {
		if (!counting || !docked) return;
		sizeBeforeSend.current = size === "minimised" ? "normal" : size;
		onSize("minimised");
	}, [counting]); // eslint-disable-line react-hooks/exhaustive-deps
	const undo = () => { undoSend(); if (docked) onSize(sizeBeforeSend.current); };
	const sendingText = copy.sendingIn.replace("{n}", String(countdown ?? ""));
	const { data: contacts = [] } = useContacts(mailboxId);
	const { data: mailbox } = useMailbox(mailboxId);
	const photos = !!mailbox?.settings?.showPhotos;

	const fileInput = useRef<HTMLInputElement>(null);
	// Mail App: choosing files kept in Files.
	const [pickingFiles, setPickingFiles] = useState(false);
	const [scheduling, setScheduling] = useState(false);
	const [dragging, setDragging] = useState(false);
	const dragDepth = useRef(0);

	// Files dropped anywhere on the panel are attached; a pasted screenshot or file is too.
	const onDragEnter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current += 1; setDragging(true); };
	const onDragOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
	const onDragLeave = (e: DragEvent) => { if (!hasFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false); };
	const onDrop = (e: DragEvent) => {
		if (!hasFiles(e)) return;
		dragDepth.current = 0; setDragging(false);
		if (intoMessage(e.target, Array.from(e.dataTransfer.files))) return;
		e.preventDefault(); e.stopPropagation();
		addFiles(e.dataTransfer.files);
	};
	const onPaste = (e: ClipboardEvent) => {
		const files = Array.from(e.clipboardData?.files ?? []);
		if (files.length === 0 || intoMessage(e.target, files)) return;
		e.preventDefault(); e.stopPropagation();
		addFiles(files);
	};

	return (
		<div
			className="relative flex flex-col h-full bg-kumo-base"
			onDragEnter={onDragEnter}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDropCapture={onDrop}
		>
			{dragging && (
				<div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-kumo-brand bg-kumo-base/90 text-base font-medium text-kumo-default">
					<PaperclipIcon size={20} className="mr-2" />
					{copy.dropHere}
				</div>
			)}
			{docked && counting ? (
				<div className="flex items-center justify-between gap-2 pl-4 pr-2 py-2 bg-kumo-fill border-b border-kumo-line shrink-0" role="status">
					<h2 className="text-sm font-semibold text-kumo-default truncate">{sendingText}</h2>
					<div className="flex items-center gap-1 shrink-0">
						<Button variant="secondary" size="sm" onClick={undo}>{copy.undo}</Button>
						<Button variant="ghost" size="sm" onClick={sendNow}>{copy.sendNow}</Button>
					</div>
				</div>
			) : docked ? (
				<div
					className="flex items-center justify-between gap-2 pl-4 pr-2 py-2 bg-kumo-fill border-b border-kumo-line shrink-0 cursor-pointer"
					onClick={() => onSize(minimised ? "normal" : "minimised")}
				>
					<h2 className="text-sm font-semibold text-kumo-default truncate">
						{(minimised && subject.trim()) || formTitle}
					</h2>
					<div className="flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<MinusIcon size={16} />}
							onClick={() => onSize(minimised ? "normal" : "minimised")}
							aria-label={minimised ? copy.restore : copy.minimise}
							title={minimised ? copy.restore : copy.minimise}
						/>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={size === "full" ? <ArrowsInSimpleIcon size={16} /> : <ArrowsOutSimpleIcon size={16} />}
							onClick={() => onSize(size === "full" ? "normal" : "full")}
							aria-label={size === "full" ? copy.exitFullScreen : copy.fullScreen}
							title={size === "full" ? copy.exitFullScreen : copy.fullScreen}
						/>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<XIcon size={16} />}
							onClick={closeCompose}
							disabled={isSending}
							aria-label="Close compose"
							title={copy.close}
						/>
					</div>
				</div>
			) : (
				<div className="flex items-center justify-between px-4 py-3 border-b border-kumo-line shrink-0 md:px-6">
					<h2 className="text-base font-semibold text-kumo-default">
						{formTitle}
					</h2>
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<XIcon size={18} />}
							onClick={closeCompose}
							disabled={isSending}
							aria-label="Close compose"
						/>
					</div>
				</div>
			)}

			<form
				onSubmit={(e) => handleSend(e, finishCompose)}
				onPasteCapture={onPaste}
				className={`flex flex-col flex-1 min-h-0 ${minimised ? "hidden" : ""}`}
			>
				<div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6 space-y-4">
					{error && <Banner variant="error" text={error} />}

					<div className="space-y-3">
						{/* Mail App: only shown when the mailbox has extra addresses to choose from. */}
						{fromOptions.length > 1 && (
							<div className="flex items-center gap-2">
								<label htmlFor="compose-from" className="text-sm font-medium text-kumo-subtle w-14 shrink-0">
									{copy.from}
								</label>
								<select
									id="compose-from"
									aria-label={copy.fromLabel}
									value={fromAddress}
									onChange={(e) => setFromAddress(e.target.value)}
									className="min-w-0 flex-1 rounded-lg border border-kumo-line bg-kumo-base px-2.5 py-1.5 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring"
								>
									{fromOptions.map((addr) => <option key={addr} value={addr}>{addr}</option>)}
								</select>
							</div>
						)}
						{/* Mail App: in a shared mailbox, the customer sees who on the team wrote to them. */}
						{sentAs && (
							<p className="text-xs text-kumo-subtle">{copy.sentAs} <span className="font-medium text-kumo-default">{sentAs}</span></p>
						)}
						<div className="flex items-center gap-2">
							<label className="text-sm font-medium text-kumo-subtle w-14 shrink-0">
								To
							</label>
							<div className="flex-1 flex items-center gap-2 min-w-0">
								<RecipientInput label="To" placeholder="recipient@example.com" value={to} onChange={setTo} contacts={contacts} photos={photos} required />
								{!showCcBcc && (
									<button
										type="button"
										onClick={() => setShowCcBcc(true)}
										className="shrink-0 text-xs text-kumo-link hover:text-kumo-link-hover font-medium"
									>
										CC / BCC
									</button>
								)}
							</div>
						</div>

						{showCcBcc && (
							<div className="flex items-center gap-2">
								<label className="text-sm font-medium text-kumo-subtle w-14 shrink-0">
									CC
								</label>
								<div className="flex-1">
									<RecipientInput label="CC" placeholder="Separate multiple addresses with commas" value={cc} onChange={setCc} contacts={contacts} photos={photos} />
								</div>
							</div>
						)}

						{showCcBcc && (
							<div className="flex items-center gap-2">
								<label className="text-sm font-medium text-kumo-subtle w-14 shrink-0">
									BCC
								</label>
								<div className="flex-1">
									<RecipientInput label="BCC" placeholder="Separate multiple addresses with commas" value={bcc} onChange={setBcc} contacts={contacts} photos={photos} />
								</div>
							</div>
						)}

						<div className="flex items-center gap-2">
							<label className="text-sm font-medium text-kumo-subtle w-14 shrink-0">
								Subject
							</label>
							<div className="flex-1">
								<Input
									type="text"
									placeholder="Email subject"
									size="sm"
									className="w-full"
									value={subject}
									onChange={(e) => setSubject(e.target.value)}
									required
								/>
							</div>
						</div>
					</div>

					{/* Mail App: in the floating box the writing area grows to fill the space */}
					<div className={`border border-kumo-line rounded-md overflow-hidden bg-kumo-base ${size === "full" ? "[&_.ProseMirror]:min-h-[calc(90vh-320px)]" : docked ? "[&_.ProseMirror]:min-h-[min(300px,calc(100vh-420px))]" : ""}`}>
						<Suspense fallback={<div className="min-h-[220px]" />}>
							<RichTextEditor
								value={body}
								onChange={setBody}
							/>
						</Suspense>
					</div>

					<ComposeAttachments
						attachments={attachments}
						usedBytes={attachmentBytes}
						limitBytes={attachmentLimit}
						tooBig={attachmentsTooBig}
						tooBigText={tooBigText}
						isForward={isForward}
						onRemove={removeAttachment}
						linkKeys={linkKeys}
						linksOn={linksOn}
						protectLinks={protectLinks}
						onProtectLinks={setProtectLinks}
						linkPassword={linkPassword}
						onLinkPassword={setLinkPassword}
					/>
					{attachmentsTooBig && attachments.length === 0 && <p className="text-sm text-kumo-danger">{tooBigText}</p>}
				</div>

				{/* Footer actions */}
				{/* Mail App: sized by the compose box, not the screen, so the floating box and the
				    installed app at tablet width both keep Send in view. Below 56rem the buttons
				    show icons only; if even that is too wide they wrap rather than push Send off. */}
				<div className="@container mt-auto px-4 py-3 border-t border-kumo-line bg-kumo-fill/30 shrink-0 md:px-6">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div className="flex flex-wrap items-center gap-1 min-w-0">
							<Button type="button" variant="ghost" size="sm" icon={<TrashIcon size={16} />} onClick={closeCompose} disabled={isSending} aria-label={copy.discard} title={copy.discard}>
								<span className="hidden @[56rem]:inline">{copy.discard}</span>
							</Button>
							{/* Mail App: attach from this device or from Files */}
							<DropdownMenu>
								<DropdownMenu.Trigger>
									<Button type="button" variant="ghost" size="sm" icon={<PaperclipIcon size={16} />} disabled={isSending} aria-label={copy.attachLabel} title={copy.attachLabel}>
										<span className="hidden @[56rem]:inline">{copy.attach}</span>
									</Button>
								</DropdownMenu.Trigger>
								<DropdownMenu.Content>
									<DropdownMenu.Item icon={DesktopIcon} onClick={() => fileInput.current?.click()}>{filesCopy.attachFromDevice}</DropdownMenu.Item>
									<DropdownMenu.Item icon={FolderSimpleIcon} onClick={() => setPickingFiles(true)}>{filesCopy.attachFromFiles}</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu>
							{pickingFiles && mailboxId && <PickFilesDialog mailboxId={mailboxId} onOpenChange={setPickingFiles} onPick={addFiles} />}
							{/* Mail App: start from a saved template */}
							<DropdownMenu>
								<DropdownMenu.Trigger>
									<Button type="button" variant="ghost" size="sm" icon={<NotepadIcon size={16} />} disabled={isSending} aria-label={copy.templatesLabel} title={copy.templatesLabel}>
										<span className="hidden @[56rem]:inline">{copy.templates}</span>
									</Button>
								</DropdownMenu.Trigger>
								<DropdownMenu.Content>
									{templates.map((t) => (
										<DropdownMenu.Item key={t.id} onClick={() => insertTemplate(t)}>{t.name}</DropdownMenu.Item>
									))}
									{templates.length > 0 && <DropdownMenu.Separator />}
									<DropdownMenu.Item icon={GearIcon} onClick={() => navigate(`/mailbox/${mailboxId}/settings`)}>
										{copy.templatesManage}
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu>
							{/* Mail App: "Remind me if no reply" */}
							<DropdownMenu>
								<DropdownMenu.Trigger>
									<Button type="button" variant="ghost" size="sm" disabled={isSending} aria-label={reminderCopy.remind} title={remindDays ? fill(reminderCopy.remindChosen, { days: dayWords(remindDays) }) : reminderCopy.remind}
										icon={remindDays ? <BellRingingIcon size={16} weight="fill" className="text-kumo-brand" /> : <BellSimpleIcon size={16} />}>
										<span className="hidden @[56rem]:inline">{remindDays ? fill(reminderCopy.remindChosen, { days: dayWords(remindDays) }) : reminderCopy.remindShort}</span>
									</Button>
								</DropdownMenu.Trigger>
								<DropdownMenu.Content>
									<div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle">{reminderCopy.remind}</div>
									{NO_REPLY_DAYS.map((d) => (
										<DropdownMenu.Item key={d} onClick={() => setRemindDays(d)}>{fill(reminderCopy.remindDays, { days: dayWords(d) })}</DropdownMenu.Item>
									))}
									{remindDays !== null && (<>
										<DropdownMenu.Separator />
										<DropdownMenu.Item icon={BellSimpleSlashIcon} onClick={() => setRemindDays(null)}>{reminderCopy.remindOff}</DropdownMenu.Item>
									</>)}
								</DropdownMenu.Content>
							</DropdownMenu>
							<input
								ref={fileInput}
								type="file"
								multiple
								hidden
								onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
							/>
						</div>
						<div className="flex items-center gap-2 ml-auto shrink-0">
							<Button
								type="button"
								variant="secondary"
								size="sm"
								loading={isSavingDraft}
								disabled={isSending}
								icon={<FloppyDiskIcon size={14} />}
								onClick={handleSaveDraft}
								aria-label={copy.saveDraft}
								title={copy.saveDraft}
							>
								<span className="hidden @[56rem]:inline">{isSavingDraft ? "Saving..." : copy.saveDraft}</span>
							</Button>
							{/* Mail App: scheduled send */}
							<Button
								type="button"
								variant="secondary"
								size="sm"
								disabled={isSavingDraft || isSending || attachmentsTooBig}
								icon={<ClockCountdownIcon size={14} />}
								aria-label={scheduledCopy.scheduleLabel}
								title={scheduledCopy.scheduleLabel}
								onClick={() => setScheduling(true)}
							>
								<span className="hidden @[56rem]:inline">{scheduledCopy.schedule}</span>
							</Button>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isSending}
								disabled={isSavingDraft || isSending || attachmentsTooBig}
								icon={<PaperPlaneTiltIcon size={14} />}
							>
								{isSending ? "Sending..." : "Send"}
							</Button>
							{scheduling && (
								<ScheduleDialog busy={isSending} onClose={() => setScheduling(false)}
									onPick={(at) => { setScheduling(false); void handleSend(null, finishCompose, at); }} />
							)}
						</div>
					</div>
				</div>
			</form>
			{counting && !docked && (
				<div className="absolute inset-0 z-30 flex flex-col justify-end bg-kumo-base/60" role="status">
					<div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-kumo-line bg-kumo-base shadow-lg">
						<span className="text-sm font-medium text-kumo-default">{sendingText}</span>
						<div className="flex items-center gap-2">
							<Button variant="secondary" size="sm" onClick={undo}>{copy.undo}</Button>
							<Button variant="primary" size="sm" onClick={sendNow}>{copy.sendNow}</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
