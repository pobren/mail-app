// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: attachments (attach, drag and drop, paste), kept in drafts and forwards, with a size check; files too big to attach go as encrypted download links; templates; a new email can start with a recipient; pictures in the message are sent as inline attachments; Send waits a few seconds so it can be undone; a From line for the mailbox's extra addresses, each with its own name and signature, and replies come from the address the email came to (a masked address included, without a signature); in a shared mailbox, emails are signed with the sender's own name and signature; a new email can start with files from the Files page; "Remind me if no reply"; scheduled send.

import { useKumoToastManager } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
	buildQuotedReplyBlock,
	escapeHtml,
	formatComposeDate,
	getSignatureBlock,
	signatureContent,
	swapSignature,
	htmlToPlainText,
	splitEmailList,
	stripHtml,
	toEmailListValue,
} from "~/lib/utils";
import { useDeleteEmail, useForwardEmail, useReplyToEmail, useSaveDraft, useSendEmail } from "~/queries/emails";
import { applyTemplate, cleanTemplates, type EmailTemplate } from "shared/templates";
import { useMailbox } from "~/queries/mailboxes";
import { useAddresses, useMasked } from "~/queries/addresses";
import { useMe } from "~/queries/people";
import { sharedFromName } from "shared/people";
import { deliveredTo, replyFromSetting, sendableAddresses, type AddressBook } from "shared/addresses";
import { useUIStore } from "~/hooks/useUIStore";
import {
	type ComposeAttachment,
	bytesOf,
	fill,
	placeholderFor,
	placeholderForStored,
	readFile,
	readStored,
	toOutgoing,
	withInlinePictures,
} from "~/lib/attachments";
import { inlineImageBytes, withoutInlineImages } from "shared/inline-images";
import { getNonInlineAttachments } from "~/lib/utils";
import { MAX_MESSAGE_BYTES, attachmentAllowance, formatSize, isTooLarge, splitForLinks } from "shared/attachments";
import { MAX_LINK_BYTES } from "shared/links";
import { linksBlock, uploadLink, type SharedLink } from "~/lib/links";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";
import copy from "~/copy/compose.en-GB.json";
import { formatWhen, noReplyDueAt } from "shared/reminders";
import scheduledCopy from "~/copy/scheduled.en-GB.json";

/** Mail App: how long Send waits, so the email can be called back with Undo. */
const UNDO_SEND_SECONDS = 5;

function appendUniqueAddress(
	addresses: string[],
	seen: Set<string>,
	address: string,
	exclude?: string,
) {
	const trimmed = address.trim();
	if (!trimmed) return;

	const normalized = trimmed.toLowerCase();
	if (normalized === exclude || seen.has(normalized)) return;

	seen.add(normalized);
	addresses.push(trimmed);
}

interface ComposeFormFields {
	to: string;
	cc: string;
	bcc: string;
	showCcBcc: boolean;
	subject: string;
	body: string;
}

const EMPTY_FIELDS: ComposeFormFields = {
	to: "",
	cc: "",
	bcc: "",
	showCcBcc: false,
	subject: "",
	body: "",
};

function getPrefixedSubject(subject: string, prefix: "Re" | "Fwd") {
	const expectedPrefix = `${prefix}: `;
	return subject.startsWith(expectedPrefix)
		? subject
		: `${expectedPrefix}${subject}`;
}

function buildForwardBody(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	sigBlock: string,
) {
	const safeSender = escapeHtml(original.sender);
	const safeSubject = escapeHtml(original.subject);
	const safeBody = escapeHtml(stripHtml(original.body || "")).replace(/\n/g, "<br>");

	return `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}<div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>Forwarded message:</strong><br><strong>From:</strong> ${safeSender}<br><strong>Date:</strong> ${formatComposeDate(original.date)}<br><strong>Subject:</strong> ${safeSubject}<br><br>${safeBody}</div>`;
}

function buildReplyAllFields(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	selfAddresses: Set<string>,
) {
	const toRecipients: string[] = [];
	// Mail App: none of your own addresses go in the reply, so you don't email yourself.
	const toSeen = new Set<string>(selfAddresses);
	appendUniqueAddress(toRecipients, toSeen, original.sender);

	for (const recipient of splitEmailList(original.recipient)) {
		appendUniqueAddress(toRecipients, toSeen, recipient);
	}

	const ccRecipients: string[] = [];
	const ccSeen = new Set<string>();
	for (const recipient of splitEmailList(original.cc)) {
		const normalized = recipient.toLowerCase();
		if (
			toSeen.has(normalized) ||
			ccSeen.has(normalized)
		) {
			continue;
		}
		ccSeen.add(normalized);
		ccRecipients.push(recipient);
	}

	return {
		to: toRecipients.join(", "),
		cc: ccRecipients.join(", "),
		showCcBcc: ccRecipients.length > 0,
	};
}

function buildInitialComposeFields(
	composeOptions: ReturnType<typeof useUIStore.getState>["composeOptions"],
	selfAddresses: Set<string>,
	sigBlock: string,
): ComposeFormFields {
	const { draftEmail: draft, originalEmail: original, mode } = composeOptions;

	if (draft) {
		return {
			to: draft.recipient || "",
			cc: draft.cc || "",
			bcc: draft.bcc || "",
			showCcBcc: Boolean(draft.cc || draft.bcc),
			subject: draft.subject || "",
			body: draft.body || "",
		};
	}

	if (!original) {
		return {
			...EMPTY_FIELDS,
			to: composeOptions.to ? `${composeOptions.to}, ` : "",
			cc: composeOptions.cc || "",
			showCcBcc: Boolean(composeOptions.cc),
			subject: composeOptions.subject || "",
			body: `${composeOptions.text ? textToHtml(composeOptions.text) : ""}${sigBlock ? `<p><br></p>${sigBlock}` : ""}`,
		};
	}

	if (mode === "reply") {
		return {
			...EMPTY_FIELDS,
			to: original.sender,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, original.body || "")}`,
		};
	}

	if (mode === "reply-all") {
		const recipients = buildReplyAllFields(original, selfAddresses);
		return {
			...EMPTY_FIELDS,
			...recipients,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, original.body || "")}`,
		};
	}

	if (mode === "forward") {
		return {
			...EMPTY_FIELDS,
			subject: getPrefixedSubject(original.subject, "Fwd"),
			body: buildForwardBody(original, sigBlock),
		};
	}

	return {
		...EMPTY_FIELDS,
		body: sigBlock ? `<p><br></p>${sigBlock}` : "",
	};
}

export function useComposeForm(mailboxId?: string, _folder?: string) {
	const toastManager = useKumoToastManager();
	const { composeOptions, closePanel, closeCompose } = useUIStore();
	const { data: currentMailbox, isLoading: mailboxLoading } = useMailbox(mailboxId);
	const { data: addresses, isLoading: addressesLoading, isFetching: addressesFetching } = useAddresses(mailboxId);
	const sendEmailMutation = useSendEmail();
	const saveDraftMutation = useSaveDraft();
	const replyMutation = useReplyToEmail();
	const forwardMutation = useForwardEmail();
	const deleteEmailMutation = useDeleteEmail();

	const [to, setTo] = useState("");
	const [cc, setCc] = useState("");
	const [bcc, setBcc] = useState("");
	const [showCcBcc, setShowCcBcc] = useState(false);
	// Mail App: "Remind me if no reply", in days (null: no reminder).
	const [remindDays, setRemindDays] = useState<number | null>(null);
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSavingDraft, setIsSavingDraft] = useState(false);
	const [isSending, setIsSending] = useState(false);
	// Mail App: undo send. Pressing Send waits a few seconds first, so the email can be called back.
	const [countdown, setCountdown] = useState<number | null>(null);
	const pendingSend = useRef<(() => void) | null>(null);
	const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
	const stopCountdown = () => { if (countdownTimer.current) clearInterval(countdownTimer.current); countdownTimer.current = null; };
	const undoSend = () => { stopCountdown(); pendingSend.current = null; setCountdown(null); };
	const sendNow = () => { stopCountdown(); const go = pendingSend.current; pendingSend.current = null; setCountdown(null); go?.(); };
	// Leaving the page while the countdown runs still sends the email, as the person asked.
	useEffect(() => () => { stopCountdown(); const go = pendingSend.current; pendingSend.current = null; go?.(); }, []);
	const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
	const [protectLinks, setProtectLinks] = useState(false);
	const [linkPassword, setLinkPassword] = useState("");
	const { data: config } = useQuery({ queryKey: queryKeys.config, queryFn: () => api.getConfig(), staleTime: Infinity });
	const linksOn = !!config?.downloadLinks;
	const lastInitializedOptionsRef = useRef<typeof composeOptions | null>(null);
	const isDraftEdit = !!composeOptions.draftEmail;

	const formTitle = useMemo(() => {
		if (isDraftEdit) return "Edit Draft";
		switch (composeOptions.mode) { case "reply": return "Reply"; case "reply-all": return "Reply All"; case "forward": return "Forward"; default: return "New Message"; }
	}, [composeOptions.mode, isDraftEdit]);

	const sigBlock = useMemo(() => getSignatureBlock(currentMailbox?.settings), [currentMailbox]);
	// Mail App: the addresses this mailbox can send from, and the name and signature that go with each.
	const book = useMemo<AddressBook>(() => ({ aliases: addresses?.aliases ?? [], catchAll: {} }), [addresses]);
	// Mail App: a reply to mail that came to a masked address comes from that masked address, so the website
	// never sees your real one. Only that one is offered, not every masked address you have.
	const maskedCandidate = (composeOptions.draftEmail?.sender ?? deliveredTo(composeOptions.originalEmail?.raw_headers) ?? "").toLowerCase();
	const maybeMasked = !!mailboxId && !!maskedCandidate && !!addresses && !sendableAddresses(book, mailboxId).includes(maskedCandidate);
	const { data: masked, isLoading: maskedLoading } = useMasked(mailboxId, maybeMasked);
	const replyMasked = maybeMasked && masked?.addresses.some((m) => m.address === maskedCandidate && m.status !== "off") ? maskedCandidate : null;
	const fromOptions = useMemo(() => (mailboxId ? [...sendableAddresses(book, mailboxId), ...(replyMasked ? [replyMasked] : [])] : []), [book, mailboxId, replyMasked]);
	const [fromAddress, setFromAddressState] = useState("");
	const aliasFor = (addr: string) => book.aliases.find((a) => a.address === addr);
	// No signature from a masked address: a signature often carries your real address or phone number.
	const isMasked = (addr: string) => !!replyMasked && addr === replyMasked;
	// Mail App: in a shared mailbox each person signs with their own name and, if they've set one, their own signature.
	const { data: me, isLoading: meLoading } = useMe();
	const shared = !!currentMailbox?.shared;
	const personalSig = shared ? me?.signature?.trim() || "" : "";
	const sigFor = (addr: string) => {
		if (isMasked(addr)) return "";
		const own = personalSig || aliasFor(addr)?.signature;
		return own ? getSignatureBlock({ signature: { enabled: true, text: own } }) : sigBlock;
	};
	/** Choosing another From swaps the signature in the message for that address's one. */
	const sigContentFor = (addr: string) => {
		if (isMasked(addr)) return "";
		const own = personalSig || aliasFor(addr)?.signature;
		return signatureContent(own ? { signature: { enabled: true, text: own } } : currentMailbox?.settings);
	};
	/** The name people see the email come from. In a shared mailbox: "Sam at Acme Sales". */
	const fromNameFor = (addr: string) => {
		const boxName = aliasFor(addr)?.name || currentMailbox?.settings?.fromName || currentMailbox?.name || addr;
		if (!shared || !me?.name) return boxName;
		return sharedFromName(me.name, boxName.toLowerCase() === addr.toLowerCase() ? addr.split("@")[0] : boxName);
	};
	const setFromAddress = (addr: string) => {
		setBody(swapSignature(body, sigContentFor(fromAddress), sigContentFor(addr)));
		setFromAddressState(addr);
	};
	const templates = useMemo(() => cleanTemplates(currentMailbox?.settings?.templates), [currentMailbox]);
	const insertTemplate = (template: EmailTemplate) => {
		const next = applyTemplate(body, subject, template);
		setBody(next.body);
		setSubject(next.subject);
	};

	useEffect(() => {
		if (lastInitializedOptionsRef.current === composeOptions) return;
		// Wait for the mailbox's addresses, so a reply starts from the right one. That includes a refresh
		// of a copy cached earlier, which won't have an address added since (in another window, say).
		if (mailboxId && (mailboxLoading || addressesLoading || addressesFetching || meLoading || (maybeMasked && maskedLoading))) return;
		lastInitializedOptionsRef.current = composeOptions;

		const { draftEmail: draftFrom, originalEmail: originalFrom } = composeOptions;
		const own = (mailboxId ?? "").toLowerCase();
		const initialFrom = draftFrom && fromOptions.includes(draftFrom.sender?.toLowerCase())
			? draftFrom.sender.toLowerCase()
			: originalFrom && replyMasked
			? replyMasked
			: originalFrom && own
			? replyFromSetting(book, own, currentMailbox?.settings?.replyFrom, [deliveredTo(originalFrom.raw_headers), originalFrom.recipient, originalFrom.cc])
			: own;
		setFromAddressState(initialFrom);
		const initialFields = buildInitialComposeFields(
			composeOptions,
			new Set(fromOptions),
			sigFor(initialFrom),
		);
		setError(null);
		setTo(initialFields.to);
		setCc(initialFields.cc);
		setBcc(initialFields.bcc);
		setShowCcBcc(initialFields.showCcBcc);
		setSubject(initialFields.subject);
		setBody(initialFields.body);

		// A saved draft keeps its attachments, and a forward includes the original's.
		const { draftEmail: draft, originalEmail: original, mode } = composeOptions;
		const source = draft ?? (mode === "forward" ? original : null);
		const stored = source ? getNonInlineAttachments(source.attachments) : [];
		const placeholders = stored.map(placeholderForStored);
		setAttachments(placeholders);
		setProtectLinks(false);
		setLinkPassword("");
		if (source && mailboxId) {
			placeholders.forEach((att, i) => {
				readStored(mailboxId, source.id, stored[i])
					.then((content) => update(att.key, { content, status: "ready" }))
					.catch(() => update(att.key, { status: "error" }));
			});
		}
		// Mail App: "Send by email" on the Files page starts with the file attached.
		if (composeOptions.files?.length) addFiles(composeOptions.files);
	}, [composeOptions, currentMailbox?.email, sigBlock, mailboxLoading, addressesLoading, addressesFetching, meLoading, personalSig, fromOptions, maybeMasked, maskedLoading]);

	function update(key: string, change: Partial<ComposeAttachment>) {
		setAttachments((list) => list.map((att) => (att.key === key ? { ...att, ...change } : att)));
	}

	const addFiles = (files: FileList | File[]) => {
		const picked = Array.from(files).filter((file) => file.size > 0);
		if (picked.length === 0) return;
		setError(null);
		// Files too big to attach are kept as they are and only read when they're sent as a link.
		const added = picked.map((file) => ({ file, att: { ...placeholderFor(file), file, ...(file.size > MAX_MESSAGE_BYTES ? { status: "ready" as const } : {}) } }));
		setAttachments((list) => [...list, ...added.map(({ att }) => att)]);
		for (const { file, att } of added) {
			if (att.status === "ready") continue;
			readFile(file)
				.then((content) => update(att.key, { content, status: "ready" }))
				.catch(() => update(att.key, { status: "error" }));
		}
	};

	const removeAttachment = (key: string) => setAttachments((list) => list.filter((att) => att.key !== key));

	// The plain-text copy is never longer than the HTML, so counting the HTML twice is a safe estimate
	// and avoids sanitising on every keystroke (sanitising also fails during server rendering).
	// Pictures in the message are counted once, as the attachments they become when sent.
	const textBody = useMemo(() => withoutInlineImages(body), [body]);
	const pictureBytes = useMemo(() => inlineImageBytes(body), [body]);
	const attachmentLimit = useMemo(() => Math.max(0, attachmentAllowance(textBody, textBody) - pictureBytes), [textBody, pictureBytes]);
	const usable = attachments.filter((att) => att.status !== "error");
	// Which files go as download links: the biggest, until the rest fits in the email.
	const linkKeys = useMemo(() => {
		const plan = splitForLinks(usable.map((att) => att.size), textBody, textBody, pictureBytes ? [pictureBytes] : []);
		return new Set(plan.link.map((i) => usable[i].key));
	}, [usable.map((att) => `${att.key}:${att.size}`).join(","), textBody, pictureBytes]);
	const attachmentBytes = usable.filter((att) => !linkKeys.has(att.key)).reduce((sum, att) => sum + att.size, 0);
	const oversized = usable.find((att) => att.size > MAX_LINK_BYTES);
	// Pictures in the message can't become download links, so they alone can make it too big.
	const picturesTooBig = pictureBytes > 0 && isTooLarge([pictureBytes], textBody, textBody);
	const attachmentsTooBig = (linkKeys.size > 0 && !linksOn) || !!oversized || picturesTooBig;
	const attachmentsLoading = attachments.some((att) => att.status === "loading");
	const tooBigText = picturesTooBig
		? copy.picturesTooBig
		: oversized
		? fill(copy.linkTooBig, { name: oversized.filename, max: formatSize(MAX_LINK_BYTES) })
		: `${fill(copy.tooBig, { limit: formatSize(attachmentLimit) })} ${copy.linksOff}`;

	const handleSaveDraft = async () => {
		if (!mailboxId || isSending) return;
		if (attachmentsLoading) { setError(copy.stillAdding); return; }
		setIsSavingDraft(true); setError(null);
		try {
			await saveDraftMutation.mutateAsync({ mailboxId, draft: {
				to,
				cc: cc || undefined,
				bcc: bcc || undefined,
				subject,
				body,
				in_reply_to: composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to || undefined,
				thread_id: composeOptions.originalEmail?.thread_id || composeOptions.draftEmail?.thread_id || undefined,
				draft_id: composeOptions.draftEmail?.id || undefined,
				from: fromAddress || undefined,
				attachments: toOutgoing(attachments.filter((att) => !linkKeys.has(att.key))),
			} });
			toastManager.add({ title: linkKeys.size ? copy.linksNotInDrafts : "Draft saved!" });
		}
		catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to save draft.";
			setError(message);
			toastManager.add({ title: message, variant: "error" });
		}
		finally { setIsSavingDraft(false); }
	};

	/** Sends the email, or with `sendAt` (ms) schedules it to go then (Mail App: scheduled send). */
	const handleSend = async (e: FormEvent | null, onClose: () => void, sendAt?: number) => {
		e?.preventDefault(); if (isSending) return; setError(null);
		if (!currentMailbox || !mailboxId) { setError("No mailbox selected."); return; }
		const toRecipients = splitEmailList(to);
		if (toRecipients.length === 0) { setError("Add at least one recipient."); return; }
		const ccRecipients = splitEmailList(cc); const bccRecipients = splitEmailList(bcc);
		if (attachmentsLoading) { setError(copy.stillAdding); return; }
		if (attachmentsTooBig) { setError(tooBigText); return; }
		const linked = attachments.filter((att) => linkKeys.has(att.key));
		const password = protectLinks && linked.length ? linkPassword : "";
		if (protectLinks && linked.length && linkPassword.length < 8) { setError(copy.linksPasswordShort); return; }
		const outgoing = toOutgoing(attachments.filter((att) => !linkKeys.has(att.key)));
		const fromEmail = fromOptions.includes(fromAddress) ? fromAddress : currentMailbox.email;
		const fromName = fromNameFor(fromEmail);
		const from = fromName && fromName !== fromEmail ? { email: fromEmail, name: fromName } : fromEmail;
		const draftId = composeOptions.draftEmail?.id; const mode = composeOptions.mode; const originalId = composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to;
		if (countdown !== null) return;
		const go = async () => {
		setIsSending(true);
		try {
			// Big files first: each is encrypted here and uploaded, and the email carries the links.
			const links: SharedLink[] = [];
			if (linked.length) {
				toastManager.add({ title: copy.linksUploading });
				for (const att of linked) {
					links.push(await uploadLink(mailboxId, { bytes: await bytesOf(att), filename: att.filename, type: att.type }, password));
				}
			}
			const { html, attachments: withPictures } = withInlinePictures(`${body}${linksBlock(links, !!password)}`, outgoing);
			const emailData = {
				to: toEmailListValue(toRecipients),
				cc: toEmailListValue(ccRecipients),
				bcc: toEmailListValue(bccRecipients),
				from,
				subject,
				html,
				text: htmlToPlainText(html),
				...(withPictures.length ? { attachments: withPictures } : {}),
				...(remindDays ? { remind_at: noReplyDueAt(remindDays) } : {}),
				...(sendAt ? { send_at: sendAt } : {}),
			};
			if (!sendAt) toastManager.add({ title: "Sending email..." });
			if ((mode === "reply" || mode === "reply-all") && originalId) await replyMutation.mutateAsync({ mailboxId, emailId: originalId, email: emailData });
			else if (mode === "forward" && originalId) await forwardMutation.mutateAsync({ mailboxId, emailId: originalId, email: emailData });
			else await sendEmailMutation.mutateAsync({ mailboxId, email: emailData });
			if (draftId) deleteEmailMutation.mutate({ mailboxId, id: draftId });
			toastManager.add({ title: sendAt ? fill(scheduledCopy.scheduled, { when: formatWhen(sendAt) }) : "Email sent!" });
			onClose();
		} catch (err: unknown) { const message = (err instanceof Error ? err.message : null) || "Failed to send email."; setError(message); toastManager.add({ title: message, variant: "error" }); }
		finally { setIsSending(false); }
		};
		// A scheduled email can be changed or cancelled until it goes, so it needs no countdown.
		if (sendAt) { void go(); return; }
		pendingSend.current = () => { void go(); };
		let left = UNDO_SEND_SECONDS;
		setCountdown(left);
		countdownTimer.current = setInterval(() => { left -= 1; if (left <= 0) sendNow(); else setCountdown(left); }, 1000);
	};

	return {
		to, setTo, cc, setCc, bcc, setBcc, showCcBcc, setShowCcBcc, subject, setSubject, body, setBody, error, setError, isSavingDraft, isSending, formTitle, handleSaveDraft, handleSend, countdown, undoSend, sendNow, closeCompose, closePanel,
		attachments, addFiles, removeAttachment, attachmentBytes, attachmentLimit, attachmentsTooBig, tooBigText,
		linkKeys, linksOn, protectLinks, setProtectLinks, linkPassword, setLinkPassword,
		isForward: composeOptions.mode === "forward" && !isDraftEdit,
		templates, insertTemplate,
		remindDays, setRemindDays,
		fromAddress, setFromAddress, fromOptions,
		/** Shared mailboxes only: how this email will be signed, shown above the To line. */
		sentAs: shared && me?.name ? `${fromNameFor(fromAddress || currentMailbox?.email || "")} <${fromAddress || currentMailbox?.email || ""}>` : null,
	};
}

/** Mail App: plain text (from a mailto: link) as paragraphs for the editor. */
function textToHtml(text: string): string {
	const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return text.split(/\r?\n/).map((line) => `<p>${esc(line) || "<br>"}</p>`).join("");
}
