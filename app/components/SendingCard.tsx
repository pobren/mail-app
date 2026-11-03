// Mail App addition (not part of upstream Agentic Inbox).
// Tells admins when Mail App can't send email to other people yet (no Workers Paid plan, or the
// domain isn't switched on for sending) and what to do. Hidden once sending works; nobody else sees it.
import { Button, useKumoToastManager } from "@cloudflare/kumo";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import copy from "~/copy/sending.en-GB.json";
import { fill } from "~/lib/attachments";
import { queryKeys } from "~/queries/keys";
import { useMe } from "~/queries/people";
import api from "~/services/api";

export function useSending() {
	const { data: me } = useMe();
	return useQuery({
		queryKey: queryKeys.sending,
		queryFn: () => api.getSending(),
		enabled: me?.role === "admin",
		staleTime: 5 * 60_000,
		retry: false,
	});
}

export default function SendingCard({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
	const { data } = useSending();
	const qc = useQueryClient();
	const toast = useKumoToastManager();
	const [checking, setChecking] = useState(false);
	if (!data || (data.state !== "plan" && data.state !== "domain")) return null;

	const words = data.state === "plan" ? copy.plan : copy.domain;
	const fixUrl = data.state === "plan" ? data.planUrl : data.installerUrl;
	const checkAgain = async () => {
		setChecking(true);
		try {
			const next = await api.checkSending();
			qc.setQueryData(queryKeys.sending, next);
			toast.add(next.state === "ok" ? { title: copy.working } : { title: copy.stillNot, variant: "error" });
		} catch (err) {
			toast.add({ title: err instanceof Error ? err.message : copy.stillNot, variant: "error" });
		} finally {
			setChecking(false);
		}
	};

	if (compact) {
		return (
			<div className={`rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-kumo-default ${className}`}>
				<b>{copy.compact}</b>{" "}
				{/* The Mailboxes page has the full card, with what to do and Check again. */}
				<Link to="/" className="font-semibold underline whitespace-nowrap" style={{ color: "var(--brand)" }}>
					{copy.compactLink}
				</Link>
			</div>
		);
	}

	return (
		<div className={`flex gap-3 rounded-xl border border-kumo-line bg-kumo-base px-4 py-4 text-sm text-kumo-default ${className}`}>
			<PaperPlaneTiltIcon size={20} className="shrink-0 mt-0.5" style={{ color: "var(--brand)" }} />
			<div className="min-w-0 flex-1">
				<p className="font-semibold">
					{fill(words.title, { domain: data.domain ?? "" })}
					{data.state === "plan" && <span className="font-normal text-kumo-subtle"> · {copy.plan.subtitle}</span>}
				</p>
				<p className="mt-1 text-kumo-subtle">{words.text}</p>
				<div className="mt-3 flex flex-wrap items-center gap-2">
					<a href={fixUrl} target="_blank" rel="noreferrer" className="no-underline">
						<Button variant="primary" size="sm">{words.button}</Button>
					</a>

					<Button variant="secondary" size="sm" loading={checking} onClick={checkAgain}>
						{checking ? copy.checking : copy.checkAgain}
					</Button>
				</div>
				{data.detail && <p className="mt-2 text-xs text-kumo-subtle break-words">{fill(copy.detail, { detail: data.detail })}</p>}
			</div>
		</div>
	);
}
