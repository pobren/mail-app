// Mail App: the plain-words reason shown on a message in Spam. Words are in app/copy/spam-reasons.en-GB.json.

import { WarningCircleIcon } from "@phosphor-icons/react";
import { reasonFromHeaders } from "shared/spam-checks";
import copy from "~/copy/spam-reasons.en-GB.json";
import type { Email } from "~/types";

export default function SpamReason({ messages }: { messages: Email[] }) {
	const message = messages.find((m) => reasonFromHeaders(m.raw_headers).length > 0);
	if (!message) return null;
	const domain = message.sender.split("@")[1] ?? message.sender;
	const reasons = reasonFromHeaders(message.raw_headers).filter((r) => r.check in copy);
	const lines = reasons
		.map((r) => (copy as Record<string, string>)[r.check])
		.map((line, i) => line
			.replaceAll("{domain}", domain)
			.replaceAll("{detail}", reasons[i].detail ?? domain));
	if (!lines.length) return null;
	return (
		<div className="mx-4 mt-3 rounded-lg border border-kumo-warning/40 bg-kumo-warning/10 px-4 py-3 md:mx-6">
			<div className="flex items-center gap-2 text-sm font-medium text-kumo-default">
				<WarningCircleIcon size={16} weight="duotone" className="text-kumo-warning" />
				{copy.title}
			</div>
			<ul className="mt-1.5 list-disc space-y-0.5 pl-6 text-sm text-kumo-default">
				{lines.map((l) => <li key={l}>{l}</li>)}
			</ul>
			<p className="mt-2 text-xs text-kumo-subtle">{copy.notSpam}</p>
		</div>
	);
}
