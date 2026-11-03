// Mail App addition (not part of upstream Agentic Inbox).
// Admin > Spam filter (admins only): what the free checks do, and the optional AI check with its daily
// limit and a link to Cloudflare's prices, as Cloudflare charges for it. How the checks work is in
// shared/spam-checks.ts, shared/spam-learning.ts and shared/spam-ai.ts. Wording in app/copy/spam-filter.en-GB.json.

import { Button, Input, Loader, Switch, Text, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, CheckCircleIcon, InfoIcon, ShieldCheckIcon, SparkleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { DEFAULT_DAILY_LIMIT, FREE_CHECKS_PER_DAY, MAX_DAILY_LIMIT, WORKERS_AI_PRICING_URL, cleanSpamFilterSettings, type SpamFilterSettings } from "shared/spam-ai";
import AdminShell, { PageHeading } from "~/components/AdminShell";
import adminCopy from "~/copy/admin.en-GB.json";
import peopleCopy from "~/copy/people.en-GB.json";
import copy from "~/copy/spam-filter.en-GB.json";
import { fill } from "~/lib/attachments";
import { useMe } from "~/queries/people";
import api from "~/services/api";

const KEY = ["spam-filter"];
const number = (n: number) => n.toLocaleString("en-GB");

export function meta() {
	return [{ title: `${adminCopy.nav.spamFilter} · Mail App` }];
}

export default function SpamFilterRoute() {
	const { data: me } = useMe();
	const isAdmin = me?.role === "admin";
	const qc = useQueryClient();
	const toast = useKumoToastManager();
	const { data, isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.getSpamFilter(), enabled: isAdmin });
	const [form, setForm] = useState<SpamFilterSettings>(() => cleanSpamFilterSettings(null));
	const [limit, setLimit] = useState(String(DEFAULT_DAILY_LIMIT));

	useEffect(() => {
		if (!data) return;
		setForm(data.settings);
		setLimit(String(data.settings.aiDailyLimit));
	}, [data]);

	const save = useMutation({
		mutationFn: () => api.saveSpamFilter(cleanSpamFilterSettings({ ...form, aiDailyLimit: Number(limit) })),
		onSuccess: (next) => {
			qc.setQueryData(KEY, next);
			toast.add({ title: next.settings.ai ? copy.saved : copy.savedOff });
		},
		onError: () => toast.add({ title: copy.failed, variant: "error" }),
	});
	const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };

	const loading = !me || (isAdmin && (isLoading || !data));
	const used = data?.checksToday ?? 0;
	return (
		<AdminShell isAdmin={isAdmin}>
			<PageHeading title={adminCopy.nav.spamFilter} intro={copy.intro} />
			{loading ? (
				<div className="flex justify-center py-20"><Loader size="lg" /></div>
			) : !isAdmin ? (
				<Text>{peopleCopy.adminOnly}</Text>
			) : (
				<div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
					<div className="space-y-5">
						<section className="rounded-2xl border border-kumo-line bg-kumo-base p-5 shadow-sm sm:p-6">
							<div className="mb-3 flex items-center gap-2">
								<ShieldCheckIcon size={20} weight="duotone" className="text-kumo-success" />
								<h2 className="text-lg font-semibold text-kumo-default">{copy.freeTitle}</h2>
							</div>
							<ul className="space-y-2.5">
								{copy.freeItems.map((item) => (
									<li key={item.label} className="flex items-start gap-2 text-sm text-kumo-default">
										<CheckCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-kumo-success" />
										<span><strong className="font-semibold">{item.label}:</strong> {item.text}</span>
									</li>
								))}
							</ul>
							<p className="mt-4 text-xs text-kumo-subtle">{copy.freeNote}</p>
						</section>

						<section className="rounded-2xl border border-kumo-line bg-kumo-base p-5 shadow-sm sm:p-6">
							<div className="mb-2 flex items-center gap-2">
								<InfoIcon size={18} weight="duotone" className="text-kumo-subtle" />
								<h2 className="text-sm font-semibold text-kumo-default">{copy.trialTitle}</h2>
							</div>
							{copy.trial.map((p) => <p key={p} className="mt-2 text-sm text-kumo-default first:mt-0">{p}</p>)}
						</section>
					</div>

					<form onSubmit={submit} className="self-start rounded-2xl border border-kumo-line bg-kumo-base p-5 shadow-sm sm:p-6">
						<div className="mb-3 flex items-center gap-2">
							<SparkleIcon size={20} weight="duotone" className="text-kumo-brand" />
							<h2 className="text-lg font-semibold text-kumo-default">{copy.aiTitle}</h2>
						</div>
						<Switch label={copy.aiSwitch} checked={form.ai} onCheckedChange={(ai) => setForm((f) => ({ ...f, ai }))} />
						{copy.aiAbout.map((p) => <p key={p} className="mt-3 text-sm text-kumo-default">{p}</p>)}
						<p className="mt-3 text-sm text-kumo-default">{fill(copy.aiCost, { free: number(FREE_CHECKS_PER_DAY) })}</p>
						<a href={WORKERS_AI_PRICING_URL} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-kumo-link underline">
							{copy.aiPricing}
							<ArrowSquareOutIcon size={14} />
						</a>
						{form.ai && (
							<div className="mt-5 [&_input]:w-40">
								<Input label={copy.limit} type="number" inputMode="numeric" min={0} max={MAX_DAILY_LIMIT} step={100} value={limit} onChange={(e) => setLimit(e.target.value)} />
								<p className="mt-1 text-xs text-kumo-subtle">{fill(copy.limitHint, { free: number(FREE_CHECKS_PER_DAY) })}</p>
							</div>
						)}
						{data?.settings.ai && (
							<p className="mt-4 text-sm text-kumo-subtle">
								{fill(copy.today, { n: number(used), limit: number(data.settings.aiDailyLimit) })}
							</p>
						)}
						<div className="mt-6">
							<Button type="submit" variant="primary" icon={<CheckCircleIcon size={16} />} loading={save.isPending}>{copy.save}</Button>
						</div>
					</form>
				</div>
			)}
		</AdminShell>
	);
}
