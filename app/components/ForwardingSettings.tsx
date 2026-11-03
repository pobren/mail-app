// Mail App: Settings › Forwarding. Pass every new email on to another address, with or without a copy
// left in the inbox (and spam too, if chosen), and see how the last one went. Words are in app/copy/forwarding.en-GB.json; how it
// works is in shared/forwarding.ts.

import { Button, Input, Loader, Switch, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowBendUpRightIcon, CheckCircleIcon, InfoIcon, WarningIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ForwardingStatus } from "shared/forwarding";
import { fill } from "~/lib/attachments";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";
import copy from "~/copy/forwarding.en-GB.json";

const when = (iso: string) => {
	const d = new Date(iso);
	return `${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} on ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
};

export default function ForwardingSettings({ mailboxId }: { mailboxId: string }) {
	const qc = useQueryClient();
	const toast = useKumoToastManager();
	const key = ["forwarding", mailboxId];
	const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.getForwarding(mailboxId) });
	const [enabled, setEnabled] = useState(false);
	const [email, setEmail] = useState("");
	const [keepCopy, setKeepCopy] = useState(true);
	const [includeSpam, setIncludeSpam] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	useEffect(() => {
		if (!data) return;
		setEnabled(data.forwarding.enabled);
		setEmail(data.forwarding.email);
		setKeepCopy(data.forwarding.keepCopy);
		setIncludeSpam(data.forwarding.includeSpam);
	}, [data]);

	const save = useMutation({
		mutationFn: () => api.saveForwarding(mailboxId, { enabled, email: email.trim(), keepCopy, includeSpam }),
		onSuccess: (next) => {
			setProblem(null);
			qc.setQueryData(key, next);
			// The rest of Settings saves the whole settings file, so it needs the new forwarding too.
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
			toast.add({ title: next.forwarding.enabled ? copy.saved : copy.turnedOff });
		},
		onError: (e) => setProblem((e as Error)?.message || copy.failed),
	});

	const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };

	if (isLoading || !data) return <div className="flex justify-center py-8"><Loader size="sm" /></div>;
	const status = data.status && data.status.to === data.forwarding.email ? data.status : null;

	return (<>
		<form onSubmit={submit} className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-2">
				<ArrowBendUpRightIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{copy.title}</span>
			</div>
			<p className="text-xs text-kumo-subtle mb-3">{copy.intro}</p>
			<Switch label={copy.switchLabel} checked={enabled} onCheckedChange={setEnabled} />
			{enabled && (
				<div className="mt-4 space-y-4">
					<Input label={copy.to} type="email" value={email} placeholder={copy.toPlaceholder} autoComplete="email"
						onChange={(e) => { setEmail(e.target.value); setProblem(null); }} />
					<div>
						<Switch label={copy.keepCopy} checked={keepCopy} onCheckedChange={setKeepCopy} />
						{!keepCopy && <p className="mt-1.5 text-xs text-kumo-subtle">{copy.keepCopyOff}</p>}
					</div>
					<div>
						<Switch label={copy.includeSpam} checked={includeSpam} onCheckedChange={setIncludeSpam} />
						{includeSpam && <p className="mt-1.5 text-xs text-kumo-subtle">{copy.includeSpamHint}</p>}
					</div>
				</div>
			)}
			{problem && <p role="alert" className="mt-3 text-sm text-kumo-danger">{problem}</p>}
			<div className="mt-4">
				<Button type="submit" variant="primary" size="sm" loading={save.isPending}>{copy.save}</Button>
			</div>
			{data.forwarding.enabled && <Status status={status} />}
		</form>

		{enabled && (
			<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
				<div className="flex items-center gap-2 mb-2">
					<InfoIcon size={16} weight="duotone" className="text-kumo-subtle" />
					<span className="text-sm font-medium text-kumo-default">{copy.howTitle}</span>
				</div>
				<ol className="list-decimal space-y-1 pl-5 text-sm text-kumo-default">
					{copy.howSteps.map((s) => <li key={s}>{s}</li>)}
				</ol>
				<p className="mt-3 text-xs text-kumo-subtle">{copy.howVerified}</p>
				<p className="mt-2 text-xs text-kumo-subtle">{copy.howCopy}</p>
				<a href={copy.dashboardUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm text-kumo-link underline">{copy.dashboardLink}</a>
			</div>
		)}
	</>);
}

function Status({ status }: { status: ForwardingStatus | null }) {
	if (!status) return <p className="mt-4 text-xs text-kumo-subtle">{copy.statusNone}</p>;
	if (!status.ok) return (
		<p className="mt-4 flex items-start gap-1.5 text-sm text-kumo-default">
			<WarningIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-kumo-warning" />
			<span>{fill(copy.statusFailed, { when: when(status.at), error: status.error ?? "" })}</span>
		</p>
	);
	return (
		<p className="mt-4 flex items-start gap-1.5 text-sm text-kumo-default">
			<CheckCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-kumo-success" />
			<span>{fill(status.how === "copy" ? copy.statusCopy : copy.statusForward, { when: when(status.at) })}</span>
		</p>
	);
}
