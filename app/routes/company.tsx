// Mail App addition (not part of upstream Agentic Inbox).
// Admin > Email disclaimer (admins only): one box the admin pastes their disclaimer into, added to the end
// of every email anyone sends from this install, with a preview on an example email beside it. How the
// footer is made and where it goes is in shared/company.ts. Wording in app/copy/company.en-GB.json.

import { Button, Loader, Switch, Text, useKumoToastManager } from "@cloudflare/kumo";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { MAX_DISCLAIMER, cleanCompany, companyFooterLines, type CompanyDetails } from "shared/company";
import AdminShell, { PageHeading } from "~/components/AdminShell";
import adminCopy from "~/copy/admin.en-GB.json";
import copy from "~/copy/company.en-GB.json";
import peopleCopy from "~/copy/people.en-GB.json";
import { useMe } from "~/queries/people";
import api from "~/services/api";
import { pageTitle } from "~/lib/brand";

const KEY = ["company"];
const areaClass = "w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm leading-relaxed text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring";

export function meta({ matches }: { matches: readonly unknown[] }) {
	return [{ title: pageTitle(matches, adminCopy.nav.company) }];
}

export default function CompanyRoute() {
	const { data: me } = useMe();
	const isAdmin = me?.role === "admin";
	const qc = useQueryClient();
	const toast = useKumoToastManager();
	const { data, isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.getCompany(), enabled: isAdmin });
	const [enabled, setEnabled] = useState(false);
	const [text, setText] = useState("");

	useEffect(() => {
		if (!data) return;
		setEnabled(data.enabled);
		setText(data.disclaimer);
	}, [data]);

	const details: CompanyDetails = cleanCompany({ enabled, disclaimer: text });
	const lines = companyFooterLines(details);

	const save = useMutation({
		mutationFn: () => api.saveCompany({ enabled, disclaimer: text }),
		onSuccess: (next) => {
			qc.setQueryData(KEY, next);
			toast.add({ title: next.enabled ? copy.saved : copy.savedOff });
		},
		onError: () => toast.add({ title: copy.failed, variant: "error" }),
	});
	const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };

	const loading = !me || (isAdmin && (isLoading || !data));
	return (
		<AdminShell isAdmin={isAdmin}>
			<PageHeading title={adminCopy.nav.company} intro={copy.intro} />
			{loading ? (
				<div className="flex justify-center py-20"><Loader size="lg" /></div>
			) : !isAdmin ? (
				<Text>{peopleCopy.adminOnly}</Text>
			) : (
				<div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
					<form onSubmit={submit} className="self-start rounded-2xl border border-kumo-line bg-kumo-base p-5 shadow-sm sm:p-6">
						<Switch label={copy.switchLabel} checked={enabled} onCheckedChange={setEnabled} />
						<label className="mt-5 block">
							<span className="mb-1.5 block text-base font-medium text-kumo-default">{copy.label}</span>
							<textarea value={text} rows={8} maxLength={MAX_DISCLAIMER} placeholder={copy.placeholder} onChange={(e) => setText(e.target.value)} className={areaClass} />
							<span className="mt-1 block text-xs text-kumo-subtle">{copy.hint}</span>
						</label>
						<div className="mt-6">
							<Button type="submit" variant="primary" loading={save.isPending}>{copy.save}</Button>
						</div>
					</form>

					<div className="space-y-4">
						<div className="rounded-2xl border border-kumo-line bg-kumo-base p-5 shadow-sm sm:p-6">
							<div className="mb-3 flex items-center gap-2">
								<EnvelopeSimpleIcon size={18} weight="duotone" className="text-kumo-subtle" />
								<span className="text-sm font-semibold text-kumo-default">{copy.preview}</span>
							</div>
							<div className="overflow-hidden rounded-lg bg-white text-[13px] text-neutral-800 shadow-inner ring-1 ring-black/5">
								<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-b border-neutral-200 bg-neutral-50 px-4 py-3 text-xs">
									<dt className="text-neutral-500">{copy.fromLabel}</dt><dd>{copy.example.from}</dd>
									<dt className="text-neutral-500">{copy.toLabel}</dt><dd>{copy.example.to}</dd>
									<dt className="text-neutral-500">{copy.subjectLabel}</dt><dd className="font-medium">{copy.example.subject}</dd>
								</dl>
								<div className="p-4">
									<p className="whitespace-pre-line">{copy.example.body}</p>
									<p className="mt-3 whitespace-pre-line">{copy.example.signOff}</p>
									<div className="mt-4 border-t border-neutral-200 pt-2 text-xs leading-relaxed text-neutral-500">
										{lines.length
											? lines.map((l, i) => <div key={i}>{l || "\u00a0"}</div>)
											: <span className="italic">{copy.previewEmpty}</span>}
									</div>
								</div>
							</div>
						</div>
						<p className="px-1 text-sm text-kumo-subtle">{copy.covers}</p>
					</div>
				</div>
			)}
		</AdminShell>
	);
}
