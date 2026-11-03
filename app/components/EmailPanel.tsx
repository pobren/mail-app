// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: "Block sender" and "Not spam"; sending a draft from here keeps its attachments and its pictures; labels; Archive and Print buttons; keyboard shortcuts; "Make a rule"; why a message is in Spam; Keep or Block a new masked address, and leak warnings; Snooze, "Remind me if no reply" and their notes; the scheduled send note.

import { useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Folders, NOT_MOVE_TARGETS } from "shared/folders";
import { ReminderNote, RemindMenu, SnoozeDialog } from "~/components/Reminders";
import { ScheduledNote } from "~/components/ScheduleSend";
import EmailPanelDialogs from "~/components/email-panel/EmailPanelDialogs";
import EmailPanelHeader from "~/components/email-panel/EmailPanelHeader";
import SpamReason from "~/components/email-panel/SpamReason";
import MaskedNote from "~/components/email-panel/MaskedNote";
import { printEmails } from "~/lib/print-email";
import { useShortcuts } from "~/lib/shortcuts";
import EmailPanelToolbar from "~/components/email-panel/EmailPanelToolbar";
import SingleMessageView from "~/components/email-panel/SingleMessageView";
import ThreadMessage from "~/components/email-panel/ThreadMessage";
import { storedToOutgoing, withInlinePictures } from "~/lib/attachments";
import { splitEmailList, toEmailListValue } from "~/lib/utils";
import api from "~/services/api";
import { useDeleteEmail, useEmail, useMoveEmail, useReplyToEmail, useSendEmail, useThreadReplies, useUpdateConversations, useUpdateEmail } from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { useMailbox, useSpamAction } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";
import { LabelChips, LabelMenu, useLabelDrop } from "~/components/Labels";
import { useLabels, useSetEmailLabels } from "~/queries/labels";
import type { Email, Folder, Mailbox } from "~/types";

function EmailPanelSkeleton() {
	return (
		<div className="animate-pulse p-5 space-y-4">
			<div className="h-5 w-2/3 rounded bg-kumo-fill" />
			<div className="flex items-center gap-3"><div className="w-10 h-10 rounded-full bg-kumo-fill" /><div className="space-y-2 flex-1"><div className="h-3 w-40 rounded bg-kumo-fill" /><div className="h-2.5 w-24 rounded bg-kumo-fill" /></div></div>
			<div className="space-y-2 pt-4"><div className="h-2.5 w-full rounded bg-kumo-fill" /><div className="h-2.5 w-5/6 rounded bg-kumo-fill" /><div className="h-2.5 w-4/6 rounded bg-kumo-fill" /><div className="h-2.5 w-3/4 rounded bg-kumo-fill" /></div>
		</div>
	);
}

export default function EmailPanel({ emailId }: { emailId: string }) {
	const { mailboxId, folder } = useParams<{ mailboxId: string; folder: string }>();
	const { data: email } = useEmail(mailboxId, emailId) as { data?: Email };
	const { data: threadRepliesRaw } = useThreadReplies(mailboxId, email?.thread_id) as {
		data?: Email[];
	};
	const updateEmail = useUpdateEmail();
	const deleteEmailMut = useDeleteEmail();
	const moveEmailMut = useMoveEmail();
	const conversationsMut = useUpdateConversations();
	const spamMut = useSpamAction();
	const sendEmailMut = useSendEmail();
	const replyMut = useReplyToEmail();
	const { data: folders = [] } = useFolders(mailboxId) as { data?: Folder[] };
	const { data: currentMailbox } = useMailbox(mailboxId) as {
		data?: Mailbox;
	};
	const { closePanel, startCompose } = useUIStore();
	const toastManager = useKumoToastManager();
	const navigate = useNavigate();
	const { data: labels = [] } = useLabels(mailboxId);
	const setLabels = useSetEmailLabels();
	const labelDrop = useLabelDrop(mailboxId, email);
	const [isSending, setIsSending] = useState(false);
	const [sourceViewEmail, setSourceViewEmail] = useState<Email | null>(null);
	const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
	const [previewImage, setPreviewImage] = useState<{ url: string; filename: string } | null>(null);
	const [snoozing, setSnoozing] = useState(false);
	const isDraftFolder = folder === Folders.DRAFT;
	// Mail App: a sent email back in the Inbox because nobody replied. Moving or deleting it from here deals
	// with the reminder and leaves the email in Sent.
	const isNoReplyInInbox = folder === Folders.INBOX && !!email && email.folder_id === Folders.SENT;

	const threadReplies = useMemo(() => {
		if (!threadRepliesRaw || !email) return [];
		return threadRepliesRaw.filter((e) => e.id !== email.id);
	}, [threadRepliesRaw, email]);

	const allMessages = useMemo(() => {
		if (!email) return [];
		return [email, ...threadReplies].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
	}, [email, threadReplies]);

	// Reset expanded state only when the selected email changes, not on every refetch.
	// Using allMessages as a dependency would reset user expand/collapse state on background refetches.
	const currentEmailId = email?.id;
	useEffect(() => { if (allMessages.length > 1) setExpandedMessages(new Set([allMessages[0].id])); }, [currentEmailId]); // eslint-disable-line react-hooks/exhaustive-deps

	const toggleExpand = (msgId: string) => { setExpandedMessages((prev) => { const next = new Set(prev); if (next.has(msgId)) next.delete(msgId); else next.add(msgId); return next; }); };

	const draftMessageIds = useMemo(() => {
		const ids = new Set<string>();
		for (const msg of allMessages) { if (msg.folder_id === Folders.DRAFT) ids.add(msg.id); else if (isDraftFolder && msg.id === emailId) ids.add(msg.id); }
		return ids;
	}, [allMessages, isDraftFolder, emailId]);

	const lastReceivedMessage = useMemo(() => {
		const ce = currentMailbox?.email;
		const received = allMessages.filter((msg) => !draftMessageIds.has(msg.id) && msg.sender !== ce);
		if (received.length > 0) return received[0];
		const nonDrafts = allMessages.filter((msg) => !draftMessageIds.has(msg.id));
		return nonDrafts.length > 0 ? nonDrafts[0] : email;
	}, [allMessages, draftMessageIds, currentMailbox?.email, email]);

	const moveToFolders = useMemo(() => { const cur = folder || email?.folder_id; return folders.filter((f) => f.id !== cur && !NOT_MOVE_TARGETS.includes(f.id)); }, [folders, folder, email?.folder_id]);

	// Mail App: keyboard shortcuts for the open email (see SHORTCUT_LIST).
	const replyTo = lastReceivedMessage ?? email;
	const canArchive = !!email && !isDraftFolder && (folder || email.folder_id) !== Folders.ARCHIVE;
	useShortcuts({
		r: () => { if (replyTo) startCompose({ mode: "reply", originalEmail: replyTo }); },
		a: () => { if (replyTo) startCompose({ mode: "reply-all", originalEmail: replyTo }); },
		f: () => { if (email) startCompose({ mode: "forward", originalEmail: email }); },
		e: () => { if (canArchive) archive(); },
		s: () => { if (email && mailboxId) updateEmail.mutate({ mailboxId, id: email.id, data: { starred: !email.starred } }); },
		u: () => { if (email && mailboxId) { updateEmail.mutate({ mailboxId, id: email.id, data: { read: false } }); closePanel(); } },
		Escape: () => closePanel(),
	}, !!email && !isDraftFolder);

	function archive() {
		if (!email || !mailboxId) return;
		// The whole conversation goes, so an earlier message in it doesn't stay behind in the inbox.
		conversationsMut.mutate({ mailboxId, ids: [email.id], action: "move", folderId: Folders.ARCHIVE, fromFolder: folder });
		closePanel();
		toastManager.add({ title: "Moved to Archive" });
	}

	if (!email) return <EmailPanelSkeleton />;

	const toggleStar = () => { if (mailboxId) updateEmail.mutate({ mailboxId, id: email.id, data: { starred: !email.starred } }); };
	const handleMove = (folderId: string) => {
		if (!mailboxId) return;
		if (isNoReplyInInbox) conversationsMut.mutate({ mailboxId, ids: [email.id], action: "move", folderId, fromFolder: folder });
		else moveEmailMut.mutate({ mailboxId, id: email.id, folderId });
		closePanel();
	};
	// Mail App: Snooze from anywhere but Drafts, Spam and the Bin.
	const canSnooze = !isDraftFolder && folder !== Folders.SPAM && folder !== Folders.TRASH;
	const sentByMe = email.folder_id === Folders.SENT;
	// Mail App: "Block sender" and "Not spam". Only offered on mail someone else sent.
	const isSpamFolder = (folder || email.folder_id) === Folders.SPAM;
	const canFlag = !isDraftFolder && folder !== Folders.SENT && !!email.sender && email.sender !== currentMailbox?.email?.toLowerCase();
	const handleSpam = (action: "block" | "not-spam") => {
		if (!mailboxId) return;
		if (action === "block" && !window.confirm(`Block ${email.sender}? Their mail will go straight to Spam. You can unblock them in Settings.`)) return;
		spamMut.mutate({ mailboxId, action, sender: email.sender, emailId: email.id }, {
			onSuccess: () => toastManager.add({ title: action === "block" ? `Blocked ${email.sender}` : "Moved to Inbox. Mail from this sender won't go to Spam." }),
			onError: () => toastManager.add({ title: "That didn't work. Please try again.", variant: "error" }),
		});
		closePanel();
	};
	// Mail App: "Make a rule" opens Settings > Rules with a new rule for mail from this sender.
	const handleMakeRule = () => { if (mailboxId) navigate(`/mailbox/${encodeURIComponent(mailboxId)}/settings?tab=rules&from=${encodeURIComponent(email.sender)}`); };
	const handleDelete = () => {
		if (!mailboxId) return;
		if (isNoReplyInInbox) { handleMove(Folders.TRASH); return; }
		if (!window.confirm("Are you sure you want to delete this email?")) return;
		deleteEmailMut.mutate({ mailboxId, id: email.id });
		closePanel();
	};

	const handleEditDraft = (draftMsg?: Email) => {
		const target = draftMsg || email;
		if (target.in_reply_to) { startCompose({ mode: "reply", originalEmail: allMessages.find((msg) => msg.id === target.in_reply_to), draftEmail: target }); }
		else { startCompose({ mode: "new", originalEmail: undefined, draftEmail: target }); }
	};

	const handleDeleteDraft = async (draftMsg?: Email) => {
		const target = draftMsg || email;
		if (!mailboxId) return;
		if (!window.confirm("Discard this draft?")) return;
		deleteEmailMut.mutate({ mailboxId, id: target.id });
		toastManager.add({ title: "Draft discarded" });
		if (target.id === emailId) closePanel();
	};

	const handleSendDraft = async (draftMsg?: Email) => {
		let target = draftMsg || email;
		if (!mailboxId || !currentMailbox) return;
		setIsSending(true);
		try {
			if (!target.recipient || !target.subject || !target.attachments) { try { const fresh = await api.getEmail(mailboxId, target.id) as Email; if (fresh) target = fresh; } catch {} }
			if (!target.recipient) { toastManager.add({ title: "Cannot send: no recipient set on this draft.", variant: "error" }); return; }
			const toRecipients = splitEmailList(target.recipient);
			if (toRecipients.length === 0) { toastManager.add({ title: "Cannot send: no valid recipient set on this draft.", variant: "error" }); return; }
			const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
			const from = fromName && fromName !== currentMailbox.email ? { email: currentMailbox.email, name: fromName } : currentMailbox.email;
			const originalEmail = target.in_reply_to ? allMessages.find((msg) => msg.id === target.in_reply_to) : undefined;
			// Mail App: pictures in the message go as inline attachments, as from the composer.
			const { html, attachments: outgoing } = withInlinePictures(target.body || "", target.attachments?.length ? await storedToOutgoing(mailboxId, target.id, target.attachments) : []);
			const emailData = {
				to: toEmailListValue(toRecipients),
				cc: toEmailListValue(splitEmailList(target.cc)),
				bcc: toEmailListValue(splitEmailList(target.bcc)),
				from,
				subject: target.subject || "(no subject)",
				html,
				text: html ? html.replace(/<[^>]*>/g, "").trim() : "",
				...(outgoing.length ? { attachments: outgoing } : {}),
			};
			if (originalEmail) await replyMut.mutateAsync({ mailboxId, emailId: originalEmail.id, email: emailData }); else await sendEmailMut.mutateAsync({ mailboxId, email: emailData });
			await deleteEmailMut.mutateAsync({ mailboxId, id: target.id });
			toastManager.add({ title: "Email sent!" });
			if (isDraftFolder) closePanel();
		} catch (err) {
			const message = (err instanceof Error ? err.message : null) || "Failed to send email.";
			toastManager.add({ title: message, variant: "error" });
		} finally { setIsSending(false); }
	};

	const hasThread = allMessages.length > 1;

	return (
		// Mail App: a label dragged from the sidebar can be dropped anywhere on the open email.
		<div {...labelDrop.props} className={`flex flex-col h-full ${labelDrop.over ? "outline-2 -outline-offset-4 outline-dashed outline-kumo-brand" : ""}`}>
			<EmailPanelToolbar
				email={email}
				mailboxId={mailboxId}
				isDraftFolder={isDraftFolder}
				isSending={isSending}
				moveToFolders={moveToFolders}
				onBack={closePanel}
				onSendDraft={() => handleSendDraft()}
				onEditDraft={() => handleEditDraft()}
				onReply={() =>
					startCompose({ mode: "reply", originalEmail: lastReceivedMessage })
				}
				onReplyAll={() =>
					startCompose({
						mode: "reply-all",
						originalEmail: lastReceivedMessage,
					})
				}
				onForward={() => startCompose({ mode: "forward", originalEmail: email })}
				onToggleStar={toggleStar}
				onToggleRead={() => {
					if (mailboxId) {
						updateEmail.mutate({
							mailboxId,
							id: email.id,
							data: { read: !email.read },
						});
					}
				}}
				onMove={handleMove}
				onArchive={canArchive ? archive : undefined}
				onSnooze={canSnooze ? () => setSnoozing(true) : undefined}
				remindMenu={mailboxId && sentByMe ? <RemindMenu mailboxId={mailboxId} email={email} /> : undefined}
				spamAction={canFlag ? (isSpamFolder ? "not-spam" : "block") : undefined}
				onSpam={handleSpam}
				onMakeRule={canFlag ? handleMakeRule : undefined}
				onViewSource={() => setSourceViewEmail(email)}
				onPrint={mailboxId ? () => {
					printEmails(allMessages.filter((m) => !draftMessageIds.has(m.id)), mailboxId)
						.catch(() => toastManager.add({ title: "That didn't print. Please try again.", variant: "error" }));
				} : undefined}
				onDelete={handleDelete}
				labelMenu={mailboxId && !isDraftFolder ? <LabelMenu mailboxId={mailboxId} email={email} /> : undefined}
			/>

			<EmailPanelHeader
				subject={email.subject}
				messageCount={allMessages.length}
				showThreadCount={hasThread}
				labels={(email.labels?.length ?? 0) > 0 && mailboxId ? (
					<LabelChips
						ids={email.labels}
						labels={labels}
						size="md"
						onRemove={(label) => setLabels.mutate({ mailboxId, email, remove: [label.id] })}
					/>
				) : undefined}
			/>

			{mailboxId && <ReminderNote mailboxId={mailboxId} email={email} folder={folder} onDone={closePanel} />}
			{mailboxId && (folder ?? email.folder_id) === Folders.SCHEDULED && <ScheduledNote mailboxId={mailboxId} email={email} onDone={closePanel} />}
			{isSpamFolder && <SpamReason messages={allMessages.length ? allMessages : [email]} />}
			<MaskedNote mailboxId={mailboxId} messages={allMessages.length ? allMessages : [email]} />

			<div className="flex-1 overflow-y-auto">
				{hasThread ? (
					allMessages.map((msg, idx) => {
						const isDraft = draftMessageIds.has(msg.id);
						return (
							<ThreadMessage
								key={msg.id}
								email={msg}
								mailboxId={mailboxId}
								mailboxEmail={currentMailbox?.email}
								isLast={idx === allMessages.length - 1}
								isDraft={isDraft}
								isSending={isDraft ? isSending : false}
								isExpanded={expandedMessages.has(msg.id)}
								onToggleExpand={() => toggleExpand(msg.id)}
								onSendDraft={isDraft ? () => handleSendDraft(msg) : undefined}
								onEditDraft={isDraft ? () => handleEditDraft(msg) : undefined}
								onDeleteDraft={isDraft ? () => handleDeleteDraft(msg) : undefined}
								onViewSource={() => setSourceViewEmail(msg)}
								onPreviewImage={(url, filename) =>
									setPreviewImage({ url, filename })
								}
							/>
						);
					})
				) : (
					<SingleMessageView
						email={email}
						mailboxId={mailboxId}
						onPreviewImage={(url, filename) =>
							setPreviewImage({ url, filename })
						}
					/>
				)}
			</div>

			{snoozing && mailboxId && (
				<SnoozeDialog mailboxId={mailboxId} ids={[email.id]} fromFolder={folder} onClose={() => setSnoozing(false)} onSnoozed={closePanel} />
			)}

			<EmailPanelDialogs
				sourceViewEmail={sourceViewEmail}
				previewImage={previewImage}
				onCloseSource={() => setSourceViewEmail(null)}
				onClosePreview={() => setPreviewImage(null)}
			/>
		</div>
	);
}
