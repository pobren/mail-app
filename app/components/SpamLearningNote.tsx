// Mail App: Settings › Spam. How much this mailbox's spam filter has learnt from Spam and Not spam
// (see shared/spam-learning.ts). Words are in app/copy/spam-filter.en-GB.json.

import { BrainIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { MIN_LEARNT } from "shared/spam-learning";
import { fill } from "~/lib/attachments";
import api from "~/services/api";
import copy from "~/copy/spam-filter.en-GB.json";

export default function SpamLearningNote({ mailboxId }: { mailboxId: string }) {
	const { data } = useQuery({ queryKey: ["spam-learning", mailboxId], queryFn: () => api.getSpamLearning(mailboxId) });
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="mb-2 flex items-center gap-2">
				<BrainIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{copy.learningTitle}</span>
			</div>
			<p className="text-sm text-kumo-default">{copy.learningHow}</p>
			{data && (
				<p className="mt-2 text-xs text-kumo-subtle">
					{fill(copy.learning, { spam: data.spam.toLocaleString("en-GB"), ham: data.ham.toLocaleString("en-GB") })}
					{(data.spam < MIN_LEARNT || data.ham < MIN_LEARNT) && ` ${fill(copy.learningSoon, { min: MIN_LEARNT })}`}
				</p>
			)}
		</div>
	);
}
