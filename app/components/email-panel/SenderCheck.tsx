// Mail App: the sender check (SPF, DKIM and DMARC as Cloudflare saw them, first email from a sender, lookalike
// domains) and one-click Unsubscribe, shown on each message. Words are in app/copy/sender-check.en-GB.json.

import { Button, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import { EnvelopeOpenIcon, ProhibitIcon, SealCheckIcon, SealWarningIcon, SparkleIcon, WarningIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { senderCheck } from "shared/sender-check";
import { unsubscribeFrom } from "shared/unsubscribe";
import { fill } from "~/lib/attachments";
import { useUIStore } from "~/hooks/useUIStore";
import api from "~/services/api";
import copy from "~/copy/sender-check.en-GB.json";
import type { Email } from "~/types";

export function SenderBadges({ email }: { email: Email }) {
	const check = senderCheck(email.sender, email.raw_headers);
	const domain = email.sender.split("@")[1] ?? email.sender;
	const vars = { domain, spf: check.spf, dkim: check.dkim, dmarc: check.dmarc };
	return (
		<>
			{check.status === "verified" && (
				<Tooltip content={fill(copy.verifiedTip, vars)} side="bottom" asChild>
					<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-kumo-success/10 px-2 py-0.5 text-xs font-medium text-kumo-success">
						<SealCheckIcon size={12} weight="fill" />{copy.verified}
					</span>
				</Tooltip>
			)}
			{check.status === "failed" && (
				<Tooltip content={fill(copy.failedTip, vars)} side="bottom" asChild>
					<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-kumo-danger/10 px-2 py-0.5 text-xs font-medium text-kumo-danger">
						<SealWarningIcon size={12} weight="fill" />{copy.failed}
					</span>
				</Tooltip>
			)}
			{check.firstContact && (
				<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-kumo-fill px-2 py-0.5 text-xs font-medium text-kumo-subtle">
					<SparkleIcon size={12} />{copy.firstContact}
				</span>
			)}
		</>
	);
}

/** A warning above the message when the sender's domain imitates a well-known one. */
export function LookalikeWarning({ email }: { email: Email }) {
	const { lookalike } = senderCheck(email.sender, email.raw_headers);
	if (!lookalike) return null;
	const domain = email.sender.split("@")[1] ?? email.sender;
	return (
		<div className="mb-3 rounded-lg border border-kumo-danger/40 bg-kumo-danger/10 px-4 py-3 md:ml-[42px]">
			<div className="flex items-center gap-2 text-sm font-medium text-kumo-default">
				<WarningIcon size={16} weight="fill" className="text-kumo-danger" />
				{fill(copy.lookalikeTitle, { known: lookalike })}
			</div>
			<p className="mt-1 text-sm text-kumo-default">{fill(copy.lookalike, { domain, known: lookalike })}</p>
		</div>
	);
}

export function UnsubscribeButtons({ email, mailboxId }: { email: Email; mailboxId?: string }) {
	const how = unsubscribeFrom(email.raw_headers);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	const toastManager = useKumoToastManager();
	const { startCompose } = useUIStore();
	if (!how || !mailboxId || done) return null;

	const go = async (block: boolean) => {
		setBusy(true);
		try {
			const res = await api.unsubscribe(mailboxId, email.id, block);
			if (res.status === "unsubscribed") {
				toastManager.add({ title: block ? fill(copy.unsubscribedBlocked, { sender: email.sender }) : copy.unsubscribed });
				setDone(true);
			} else if (res.url) {
				window.open(res.url, "_blank", "noopener,noreferrer");
				toastManager.add({ title: copy.opened });
				setDone(true);
			} else if (res.mailto) {
				startCompose({ mode: "new", to: res.mailto.to, subject: res.mailto.subject, text: res.mailto.body });
				setDone(true);
			}
		} catch {
			toastManager.add({ title: copy.failedUnsubscribe, variant: "error" });
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button size="sm" variant="secondary" icon={<EnvelopeOpenIcon size={14} />} loading={busy} disabled={busy} onClick={() => go(false)}>
				{copy.unsubscribe}
			</Button>
			<Button size="sm" variant="ghost" icon={<ProhibitIcon size={14} />} disabled={busy} onClick={() => go(true)}>
				{copy.unsubscribeBlock}
			</Button>
		</div>
	);
}
