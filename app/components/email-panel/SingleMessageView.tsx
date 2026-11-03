// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: in a shared mailbox, a sent email shows which team member sent it; calendar invites show a card to answer them.

import { Badge } from "@cloudflare/kumo";
import EmailAttachmentList from "~/components/EmailAttachmentList";
import EmailIframe from "~/components/EmailIframe";
import InviteCard from "~/components/InviteCard";
import { formatDetailDate, rewriteInlineImages } from "~/lib/utils";
import type { Email } from "~/types";
import { initials } from "shared/contacts";
import mailboxCopy from "~/copy/mailboxes.en-GB.json";

interface SingleMessageViewProps {
	email: Email;
	mailboxId?: string;
	onPreviewImage: (url: string, filename: string) => void;
}

export default function SingleMessageView({
	email,
	mailboxId,
	onPreviewImage,
}: SingleMessageViewProps) {
	return (
		<div className="flex flex-col h-full">
			<div className="px-4 py-4 border-b border-kumo-line md:px-6">
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-2.5 min-w-0">
						<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-xs font-bold text-kumo-default">
							{initials({ name: email.sender_name ?? "", email: email.sender })}
						</div>
						<div className="min-w-0">
							<div className="flex items-center gap-2 min-w-0">
								<span className="text-sm font-medium text-kumo-default truncate">{email.sender_name || email.sender}</span>
								{email.sender_name && <span className="text-xs text-kumo-subtle truncate">{email.sender}</span>}
								{email.sent_by_name && <Badge variant="outline">{mailboxCopy.sentBy} {email.sent_by_name}</Badge>}
							</div>
							<div className="text-xs text-kumo-subtle">To: {email.recipient}</div>
						</div>
					</div>
					<span className="text-xs text-kumo-subtle shrink-0">
						{formatDetailDate(email.date)}
					</span>
				</div>
			</div>

			<InviteCard mailboxId={mailboxId} emailId={email.id} attachments={email.attachments} className="mx-4 mt-4 shrink-0 md:mx-6" />
			<div className="flex-1 min-h-0">
				<EmailIframe
					body={rewriteInlineImages(
						email.body || "",
						mailboxId || "",
						email.id,
						email.attachments,
					)}
				/>
			</div>

			<EmailAttachmentList
				mailboxId={mailboxId}
				emailId={email.id}
				attachments={email.attachments}
				onPreviewImage={onPreviewImage}
				className="px-4 py-3 border-t border-kumo-line shrink-0 md:px-6"
				showHeading
			/>
		</div>
	);
}
