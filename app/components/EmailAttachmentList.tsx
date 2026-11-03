// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: each attachment can be saved to Files.

import { useKumoToastManager } from "@cloudflare/kumo";
import { CheckIcon, CircleNotchIcon, FolderSimplePlusIcon, PaperclipIcon, FileIcon, ImageIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { formatBytes, getAttachmentUrl, getNonInlineAttachments } from "~/lib/utils";
import { fill } from "~/lib/attachments";
import filesCopy from "~/copy/files.en-GB.json";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";
import type { Attachment } from "~/types";

/** Mail App: copies one attachment into Files, in the Email attachments folder. */
function SaveToFiles({ mailboxId, emailId, attachment }: { mailboxId: string; emailId: string; attachment: Attachment }) {
	const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
	const toast = useKumoToastManager();
	const qc = useQueryClient();
	const save = () => {
		setState("saving");
		api.saveAttachmentToFiles(mailboxId, emailId, attachment.id)
			.then(() => { setState("saved"); toast.add({ title: filesCopy.savedToFiles }); qc.invalidateQueries({ queryKey: queryKeys.files(mailboxId) }); })
			.catch(() => { setState("idle"); toast.add({ title: filesCopy.failed, variant: "error" }); });
	};
	const label = fill(filesCopy.saveToFiles, { name: attachment.filename });
	return (
		<button type="button" onClick={save} disabled={state !== "idle"} title={label} aria-label={label}
			className="flex items-center self-stretch border-l border-kumo-line px-2 text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default disabled:hover:bg-transparent">
			{state === "saving" ? <CircleNotchIcon size={16} className="animate-spin" /> : state === "saved" ? <CheckIcon size={16} /> : <FolderSimplePlusIcon size={16} />}
		</button>
	);
}

interface EmailAttachmentListProps {
	mailboxId?: string;
	emailId: string;
	attachments?: Attachment[];
	onPreviewImage?: (url: string, filename: string) => void;
	className?: string;
	showHeading?: boolean;
}

export default function EmailAttachmentList({
	mailboxId,
	emailId,
	attachments,
	onPreviewImage,
	className,
	showHeading = false,
}: EmailAttachmentListProps) {
	if (!mailboxId) return null;

	const files = getNonInlineAttachments(attachments);
	if (files.length === 0) return null;

	return (
		<div className={className}>
			{showHeading && (
				<div className="flex items-center gap-2 mb-2">
					<PaperclipIcon size={14} className="text-kumo-subtle" />
					<span className="text-sm font-medium text-kumo-default">
						{files.length} attachment{files.length !== 1 ? "s" : ""}
					</span>
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				{files.map((attachment) => {
					const url = getAttachmentUrl(mailboxId, emailId, attachment.id);
					const isImage = attachment.mimetype?.startsWith("image/");

					if (isImage && onPreviewImage) {
						return (
							<div key={attachment.id} className="flex overflow-hidden rounded-md border border-kumo-line">
							<button
								type="button"
								onClick={() => onPreviewImage(url, attachment.filename)}
								className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-kumo-tint text-sm text-left"
							>
								<ImageIcon size={16} className="text-kumo-subtle shrink-0" />
								<span className="text-kumo-default font-medium truncate max-w-[140px]">
									{attachment.filename}
								</span>
								<span className="text-kumo-subtle">{formatBytes(attachment.size)}</span>
							</button>
							<SaveToFiles mailboxId={mailboxId} emailId={emailId} attachment={attachment} />
							</div>
						);
					}

					return (
						<div key={attachment.id} className="flex overflow-hidden rounded-md border border-kumo-line">
						<a
							href={url}
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-center gap-2 px-3 py-2 no-underline transition-colors hover:bg-kumo-tint text-sm"
						>
							<FileIcon size={16} className="text-kumo-subtle shrink-0" />
							<span className="text-kumo-default font-medium truncate max-w-[140px]">
								{attachment.filename}
							</span>
							<span className="text-kumo-subtle">{formatBytes(attachment.size)}</span>
						</a>
						<SaveToFiles mailboxId={mailboxId} emailId={emailId} attachment={attachment} />
						</div>
					);
				})}
			</div>
		</div>
	);
}
