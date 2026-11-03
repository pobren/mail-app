// Mail App addition (not part of upstream Agentic Inbox).
// An email opened in a window over another screen (such as a contact's recent emails), so you can read it,
// reply or forward without leaving where you were. "Open in Mail" goes to the full view.
import { Button, Dialog, Loader } from "@cloudflare/kumo";
import { ArrowBendUpLeftIcon, ArrowBendUpRightIcon, ArrowSquareOutIcon, XIcon } from "@phosphor-icons/react";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import SingleMessageView from "~/components/email-panel/SingleMessageView";
import copy from "~/copy/contacts.en-GB.json";
import { useUIStore } from "~/hooks/useUIStore";
import { useEmail, useUpdateEmail } from "~/queries/emails";
import type { Email } from "~/types";

export default function EmailPreview({ mailboxId, emailId, folderId, onClose }: {
	mailboxId: string;
	emailId: string;
	folderId: string;
	onClose: () => void;
}) {
	const { data: email, isLoading } = useEmail(mailboxId, emailId) as { data?: Email; isLoading: boolean };
	const updateEmail = useUpdateEmail();
	const { startCompose } = useUIStore();
	const navigate = useNavigate();

	// Opening it counts as reading it, as it does in Mail.
	useEffect(() => {
		if (email && !email.read) updateEmail.mutate({ mailboxId, id: email.id, data: { read: true } });
	}, [email?.id]); // eslint-disable-line react-hooks/exhaustive-deps

	const write = (mode: "reply" | "forward") => {
		if (!email) return;
		onClose();
		startCompose({ mode, originalEmail: email });
	};

	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="lg" className="flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden p-0">
				<div className="flex items-center gap-2 border-b border-kumo-line px-4 py-3">
					<Dialog.Title className="min-w-0 flex-1 truncate text-lg font-semibold">{email?.subject || copy.noSubject}</Dialog.Title>
					<Button variant="secondary" size="sm" icon={<ArrowBendUpLeftIcon size={16} />} disabled={!email} onClick={() => write("reply")}>{copy.reply}</Button>
					<Button variant="ghost" size="sm" icon={<ArrowBendUpRightIcon size={16} />} disabled={!email} onClick={() => write("forward")}>{copy.forward}</Button>
					<Button variant="ghost" size="sm" icon={<ArrowSquareOutIcon size={16} />}
						onClick={() => { onClose(); navigate(`/mailbox/${encodeURIComponent(mailboxId)}/emails/${folderId}?open=${encodeURIComponent(emailId)}`); }}>
						{copy.openInMail}
					</Button>
					<Button variant="ghost" shape="square" size="sm" icon={<XIcon size={16} />} aria-label={copy.close} onClick={onClose} />
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{isLoading || !email ? (
						<div className="flex justify-center py-16"><Loader size="lg" /></div>
					) : (
						<SingleMessageView email={email} mailboxId={mailboxId} onPreviewImage={(url) => window.open(url, "_blank", "noopener")} />
					)}
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
