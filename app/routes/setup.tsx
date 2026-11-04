// Copyright (c) 2026 Paul O'Brien. Licensed under the GNU AGPL 3.0 (see LICENSE).
// Added for Mail App: the setup wizard's checks. All wording lives in app/copy/setup.en-GB.json.

import { Badge, Button, Loader } from "@cloudflare/kumo";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link as RouterLink } from "react-router";
import type { CheckStatus, DnsFix, SetupCheck } from "shared/setup";
import copy from "~/copy/setup.en-GB.json";
import api from "~/services/api";

type CheckId = keyof typeof copy.checks;

const fill = (text: string, values: Record<string, string>) =>
	text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`);

export function meta() {
	return [{ title: copy.title }];
}

const BADGE: Record<CheckStatus, "success" | "destructive" | "secondary"> = {
	ok: "success",
	fix: "destructive",
	unknown: "secondary",
};

function CopyValue({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<span className="flex flex-wrap items-center gap-2">
			<code className="break-all rounded border border-kumo-line bg-kumo-base px-2 py-1 font-mono text-xs text-kumo-default">{value}</code>
			<Button
				size="sm"
				variant="secondary"
				onClick={async () => {
					try {
						await navigator.clipboard.writeText(value);
						setCopied(true);
					} catch {
						/* clipboard blocked: the value is still selectable */
					}
				}}
			>
				{copied ? copy.fix.copied : copy.fix.copy}
			</Button>
		</span>
	);
}

function FixRecord({ fix, domain }: { fix: DnsFix; domain: string }) {
	return (
		<div className="mt-3 space-y-2 rounded-lg bg-kumo-tint p-3 text-sm text-kumo-default">
			<p>{fill(copy.fix.how, { domain })}</p>
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
				<dt className="text-kumo-subtle">{copy.fix.type}</dt>
				<dd>{fix.type}</dd>
				<dt className="text-kumo-subtle">{copy.fix.name}</dt>
				<dd><CopyValue value={fix.name} /></dd>
				<dt className="text-kumo-subtle">{copy.fix.value}</dt>
				<dd><CopyValue value={fix.value} /></dd>
			</dl>
		</div>
	);
}

function CheckRow({ check, domain }: { check: SetupCheck; domain?: string }) {
	const words = copy.checks[check.id as CheckId];
	if (!words) return null;
	return (
		<li className="px-5 py-4">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<div className="text-sm font-medium text-kumo-default">{words.label}</div>
					<p className="mt-0.5 text-sm text-kumo-subtle">{words[check.status]}</p>
					{check.found && check.status !== "ok" && (
						<p className="mt-1 break-all font-mono text-xs text-kumo-subtle">{fill(copy.found, { value: check.found })}</p>
					)}
				</div>
				<Badge variant={BADGE[check.status]}>{copy.status[check.status]}</Badge>
			</div>
			{check.status === "fix" && check.fix && domain && <FixRecord fix={check.fix} domain={domain} />}
		</li>
	);
}

function Section({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
	return (
		<section className="mb-8">
			<h2 className="text-base font-semibold text-kumo-default">{title}</h2>
			<p className="mb-3 mt-1 text-sm text-kumo-subtle">{intro}</p>
			<ul className="divide-y divide-kumo-line overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">{children}</ul>
		</section>
	);
}

export default function SetupRoute() {
	const { data, isLoading, isFetching, isError, refetch } = useQuery({
		queryKey: ["setup-status"],
		queryFn: () => api.getSetupStatus(),
	});

	const allOk = data && [...data.app, ...data.domains.flatMap((d) => d.checks)].every((c) => c.status === "ok");

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				<div className="mb-8 flex flex-wrap items-start justify-between gap-4">
					<div>
						<h1 className="text-2xl font-bold text-kumo-default">{copy.title}</h1>
						<p className="mt-1 max-w-prose text-sm text-kumo-subtle">{copy.intro}</p>
					</div>
					<Button variant="secondary" icon={ArrowClockwiseIcon} loading={isFetching} onClick={() => refetch()}>
						{isFetching ? copy.checking : copy.checkAgain}
					</Button>
				</div>

				{isLoading && (
					<div className="flex justify-center py-20"><Loader /></div>
				)}

				{isError && !data && <p className="text-sm text-kumo-default">{copy.loadError}</p>}

				{data && (
					<>
						<Section title={copy.sections.app.title} intro={copy.sections.app.intro}>
							{data.app.map((check) => <CheckRow key={check.id} check={check} />)}
						</Section>

						{data.domains.length === 0 && <p className="mb-8 text-sm text-kumo-default">{copy.noDomains}</p>}

						{data.domains.map(({ domain, checks }) => (
							<Section key={domain} title={fill(copy.sections.domain.title, { domain })} intro={copy.sections.domain.intro}>
								{checks.map((check) => <CheckRow key={check.id} check={check} domain={domain} />)}
							</Section>
						))}

						{allOk && (
							<div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-kumo-line bg-kumo-base px-5 py-4">
								<p className="text-sm font-medium text-kumo-default">{copy.allGood}</p>
								<RouterLink to="/"><Button variant="primary">{copy.openInbox}</Button></RouterLink>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
