// Mail App: on an email that came to a masked address, Keep or Block a new one, or a warning when it
// came from a different website than the address was for. Words are in app/copy/settings.en-GB.json.

import { Button, useKumoToastManager } from "@cloudflare/kumo";
import { MaskHappyIcon, WarningIcon } from "@phosphor-icons/react";
import { Link } from "react-router";
import { deliveredTo } from "shared/addresses";
import { leakFromHeaders } from "shared/masked";
import { fill } from "~/lib/attachments";
import { useChangeMasked, useMasked } from "~/queries/addresses";
import { shortList } from "~/components/ShowMore";
import copy from "~/copy/settings.en-GB.json";
import type { Email } from "~/types";

const t = copy.masked;

export default function MaskedNote({ mailboxId, messages }: { mailboxId?: string; messages: Email[] }) {
	// Only worth asking the server when one of the messages came in on an address other than the mailbox's own.
	const arrivals = messages.map((m) => ({ to: deliveredTo(m.raw_headers), leak: leakFromHeaders(m.raw_headers) })).filter((a) => a.to && a.to !== mailboxId?.toLowerCase());
	const { data } = useMasked(mailboxId, arrivals.length > 0);
	const change = useChangeMasked();
	const toastManager = useKumoToastManager();
	if (!mailboxId || !data || arrivals.length === 0) return null;

	// The newest message to a masked address decides what to show.
	const arrival = [...arrivals].reverse().find((a) => data.addresses.some((m) => m.address === a.to));
	const m = arrival && data.addresses.find((x) => x.address === arrival.to);
	if (!arrival || !m) return null;
	const leak = arrival.leak && m.status !== "off" && !m.sites.includes(arrival.leak) ? arrival.leak : null;
	if (m.status !== "waiting" && !leak) return null;

	const set = (c: { status?: "on" | "off"; trustSite?: string }, done?: string) => change.mutate({ mailboxId, address: m.address, change: c }, {
		onSuccess: () => done && toastManager.add({ title: done }),
		onError: () => toastManager.add({ title: t.failed, variant: "error" }),
	});
	const settingsLink = `/mailbox/${encodeURIComponent(mailboxId)}/settings?tab=masked`;

	if (leak) {
		return (
			<div className="mx-4 mt-3 rounded-lg border border-kumo-warning/40 bg-kumo-warning/10 px-4 py-3 md:mx-6">
				<div className="flex items-center gap-2 text-sm font-medium text-kumo-default">
					<WarningIcon size={16} weight="fill" className="text-kumo-warning" />
					{fill(t.bannerLeakTitle, { address: m.address })}
				</div>
				<p className="mt-1 text-sm text-kumo-default">{fill(t.bannerLeak, { site: leak, sites: shortList(m.sites) || m.label || m.address })}</p>
				<div className="mt-2 flex flex-wrap gap-2">
					<Button size="sm" variant="primary" onClick={() => set({ status: "off" }, fill(t.bannerBlocked, { address: m.address }))}>{t.switchOff}</Button>
					<Button size="sm" variant="secondary" onClick={() => set({ trustSite: leak })}>{t.trust}</Button>
				</div>
			</div>
		);
	}
	return (
		<div className="mx-4 mt-3 rounded-lg border border-kumo-brand/40 bg-kumo-brand/5 px-4 py-3 md:mx-6">
			<div className="flex items-center gap-2 text-sm font-medium text-kumo-default">
				<MaskHappyIcon size={16} weight="duotone" className="text-kumo-brand" />
				{fill(t.bannerWaitingTitle, { address: m.address })}
			</div>
			<p className="mt-1 text-sm text-kumo-default">{t.bannerWaiting}</p>
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<Button size="sm" variant="primary" onClick={() => set({ status: "on" }, fill(t.bannerKept, { address: m.address }))}>{t.keep}</Button>
				<Button size="sm" variant="secondary" onClick={() => set({ status: "off" }, fill(t.bannerBlocked, { address: m.address }))}>{t.block}</Button>
				<Link to={settingsLink} className="text-xs text-kumo-link underline">{t.manage}</Link>
			</div>
		</div>
	);
}
