// Mail App: Settings › Spam. Auto-empty the Bin and Spam after a set number of days
// (see workers/durableObject/auto-empty.ts). Words are in app/copy/spam-filter.en-GB.json.

import { useKumoToastManager } from "@cloudflare/kumo";
import { BroomIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AUTO_EMPTY_CHOICES, type AutoEmptySettings as Settings } from "shared/auto-empty";
import { fill } from "~/lib/attachments";
import api from "~/services/api";
import copy from "~/copy/spam-filter.en-GB.json";

const t = copy.autoEmpty;

export default function AutoEmptySettings({ mailboxId }: { mailboxId: string }) {
	const key = ["auto-empty", mailboxId];
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const { data } = useQuery({ queryKey: key, queryFn: () => api.getAutoEmpty(mailboxId) });
	const save = useMutation({
		mutationFn: (change: Partial<Settings>) => api.setAutoEmpty(mailboxId, change),
		onSuccess: (next) => { queryClient.setQueryData(key, next); toastManager.add({ title: t.saved }); },
		onError: () => toastManager.add({ title: t.failed, variant: "error" }),
	});
	const choice = (field: keyof Settings, label: string) => (
		<label className="flex items-center justify-between gap-3 text-sm text-kumo-default">
			<span>{label}</span>
			<select
				value={data?.[field] ?? 0}
				disabled={!data || save.isPending}
				onChange={(e) => save.mutate({ [field]: Number(e.target.value) })}
				className="rounded-md border border-kumo-line bg-kumo-recessed px-2 py-1 text-sm"
			>
				{AUTO_EMPTY_CHOICES.map((n) => <option key={n} value={n}>{n === 0 ? t.never : fill(t.after, { n })}</option>)}
			</select>
		</label>
	);
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="mb-2 flex items-center gap-2">
				<BroomIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{t.title}</span>
			</div>
			<p className="mb-3 text-xs text-kumo-subtle">{t.intro}</p>
			<div className="flex max-w-md flex-col gap-2">
				{choice("trashDays", t.trash)}
				{choice("spamDays", t.spam)}
			</div>
		</div>
	);
}
