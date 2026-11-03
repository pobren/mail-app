// Mail App addition (not part of upstream Agentic Inbox).
// The list of files attached to the email being written, with a size meter. Files too big to attach are
// marked as download links, with the option to protect them with a password.
import { ChatTextIcon, CheckIcon, CircleNotchIcon, CopyIcon, FileIcon, ImageIcon, LinkSimpleIcon, ShareNetworkIcon, WarningCircleIcon, WhatsappLogoIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { formatSize } from "shared/attachments";
import { type ComposeAttachment, fill } from "~/lib/attachments";
import { type ShareDevice, type ShareOption, shareDevice, shareOptions, smsUrl, whatsappUrl } from "~/lib/share-password";
import copy from "~/copy/compose.en-GB.json";

interface Props {
	attachments: ComposeAttachment[];
	usedBytes: number;
	limitBytes: number;
	tooBig: boolean;
	tooBigText: string;
	isForward: boolean;
	onRemove: (key: string) => void;
	linkKeys: Set<string>;
	linksOn: boolean;
	protectLinks: boolean;
	onProtectLinks: (on: boolean) => void;
	linkPassword: string;
	onLinkPassword: (text: string) => void;
}

export default function ComposeAttachments({ attachments, usedBytes, limitBytes, tooBig, tooBigText, isForward, onRemove, linkKeys, linksOn, protectLinks, onProtectLinks, linkPassword, onLinkPassword }: Props) {
	const linkCount = linkKeys.size;
	if (attachments.length === 0) return null;
	const share = limitBytes > 0 ? Math.min(1, usedBytes / limitBytes) : 1;

	return (
		<div className="space-y-2" aria-live="polite">
			{isForward && <p className="text-xs text-kumo-subtle">{copy.forwardedNote}</p>}
			<ul className="flex flex-wrap gap-2">
				{attachments.map((att) => {
					const Icon = att.status === "loading" ? CircleNotchIcon : att.status === "error" ? WarningCircleIcon : att.type.startsWith("image/") ? ImageIcon : FileIcon;
					return (
						<li
							key={att.key}
							className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm max-w-full ${att.status === "error" ? "border-kumo-danger text-kumo-danger" : "border-kumo-line"}`}
						>
							<Icon size={16} className={`shrink-0 ${att.status === "loading" ? "animate-spin text-kumo-subtle" : att.status === "error" ? "" : "text-kumo-subtle"}`} />
							<span className="font-medium truncate max-w-[180px]" title={att.filename}>{att.filename}</span>
							<span className="text-kumo-subtle shrink-0">
								{att.status === "loading" ? copy.loading : att.status === "error" ? copy.loadFailed : formatSize(att.size)}
							</span>
							{linkKeys.has(att.key) && linksOn && (
								<span className="flex items-center gap-1 shrink-0 rounded bg-kumo-tint px-1.5 py-0.5 text-xs text-kumo-subtle" title={copy.linkBadgeTitle}>
									<LinkSimpleIcon size={12} />
									{copy.linkBadge}
								</span>
							)}
							<button
								type="button"
								onClick={() => onRemove(att.key)}
								className="shrink-0 rounded p-0.5 text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint"
								aria-label={fill(copy.remove, { name: att.filename })}
							>
								<XIcon size={14} />
							</button>
						</li>
					);
				})}
			</ul>
			<div className="flex items-center gap-2 text-xs text-kumo-subtle">
				<div className="h-1.5 w-24 rounded-full bg-kumo-fill overflow-hidden" aria-hidden="true">
					<div className={`h-full rounded-full ${tooBig ? "bg-kumo-danger" : "bg-kumo-brand"}`} style={{ width: `${Math.round(share * 100)}%` }} />
				</div>
				<span className={tooBig ? "text-kumo-danger font-medium" : ""}>
					{fill(copy.usage, { used: formatSize(usedBytes), limit: formatSize(limitBytes) })}
				</span>
			</div>
			{tooBig && <p className="text-sm text-kumo-danger">{tooBigText}</p>}
			{!tooBig && linksOn && linkCount > 0 && (
				<div className="space-y-2 rounded-md border border-kumo-line p-3 text-sm">
					<p>{linkCount === 1 ? copy.linksNoteOne : fill(copy.linksNote, { count: linkCount })}</p>
					<label className="flex items-center gap-2">
						<input type="checkbox" checked={protectLinks} onChange={(e) => onProtectLinks(e.target.checked)} />
						{copy.linksProtect}
					</label>
					{protectLinks && (
						<div className="space-y-1">
							<input
								type="password"
								autoComplete="new-password"
								aria-label={copy.linksPassword}
								placeholder={copy.linksPassword}
								value={linkPassword}
								onChange={(e) => onLinkPassword(e.target.value)}
								className="w-full max-w-xs rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5"
							/>
							<p className="text-xs text-kumo-subtle">{copy.linksPasswordHint}</p>
							{linkPassword.length >= 8 && <SharePassword password={linkPassword} />}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** Mail App: buttons that send the password with the sender's own apps, already typed in a message. */
function SharePassword({ password }: { password: string }) {
	// Worked out after the page loads, because the server can't tell which device this is.
	const [device, setDevice] = useState<{ kind: ShareDevice; options: ShareOption[] } | null>(null);
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		const kind = shareDevice(navigator.userAgent, navigator.maxTouchPoints);
		setDevice({ kind, options: shareOptions(kind, typeof navigator.share === "function") });
	}, []);
	useEffect(() => setCopied(false), [password]);
	if (!device) return null;
	const text = fill(copy.linksShareMessage, { password });
	const button = "inline-flex items-center gap-1.5 rounded-md border border-kumo-line px-2.5 py-1 text-xs hover:bg-kumo-tint";

	const share = () => navigator.share({ title: copy.linksShareTitle, text }).catch(() => {});
	const copyText = () => navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => {});

	return (
		<div className="flex flex-wrap items-center gap-2 pt-1">
			<span className="text-xs text-kumo-subtle">{copy.linksShareLabel}</span>
			{device.options.map((option) => {
				if (option === "share") return <button key={option} type="button" className={button} onClick={share}><ShareNetworkIcon size={14} />{copy.linksShare}</button>;
				if (option === "whatsapp") return <a key={option} className={button} href={whatsappUrl(text)} target="_blank" rel="noopener noreferrer"><WhatsappLogoIcon size={14} />{copy.linksShareWhatsApp}</a>;
				if (option === "sms") return <a key={option} className={button} href={smsUrl(text, device.kind)}><ChatTextIcon size={14} />{copy.linksShareText}</a>;
				return <button key={option} type="button" className={button} onClick={copyText}>{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}{copied ? copy.linksShareCopied : copy.linksShareCopy}</button>;
			})}
		</div>
	);
}
