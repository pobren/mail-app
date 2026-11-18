// Mail App: "Summarise" (AI, only when switched on in Settings) and the quick reply box under an open email.
// The quick reply hands what you typed to the full composer, so the right From address, signature and undo
// send all still apply. Words are in app/copy/quick.en-GB.json.

import { Button } from "@cloudflare/kumo";
import { ArrowBendUpLeftIcon, SparkleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { cleanSenderName } from "shared/contacts";
import { fill } from "~/lib/attachments";
import { useUIStore } from "~/hooks/useUIStore";
import api from "~/services/api";
import copy from "~/copy/quick.en-GB.json";
import type { Email } from "~/types";

export function AiSummary({ mailboxId, email }: { mailboxId: string; email: Email }) {
	const [state, setState] = useState<{ status: "idle" | "busy" | "done" | "failed"; text?: string; for?: string }>({ status: "idle" });
	// A different email opened: start again.
	const current = state.for === email.id ? state : { status: "idle" as const };
	const run = async () => {
		setState({ status: "busy", for: email.id });
		try {
			const { summary } = await api.summarise(mailboxId, email.id);
			setState({ status: "done", text: summary, for: email.id });
		} catch {
			setState({ status: "failed", for: email.id });
		}
	};
	if (current.status === "done") {
		return (
			<div className="mx-4 mt-3 rounded-lg bg-kumo-recessed px-4 py-3 md:mx-6">
				<div className="flex items-center gap-2 text-sm font-medium text-kumo-default">
					<SparkleIcon size={16} weight="duotone" className="text-kumo-brand" />{copy.summaryTitle}
				</div>
				<p className="mt-1 text-sm text-kumo-default">{current.text}</p>
				<p className="mt-1 text-xs text-kumo-subtle">{copy.summaryNote}</p>
			</div>
		);
	}
	return (
		<div className="mx-4 mt-3 flex items-center gap-2 md:mx-6">
			<Button size="sm" variant="ghost" icon={<SparkleIcon size={14} />} loading={current.status === "busy"} disabled={current.status === "busy"} onClick={run}>
				{current.status === "busy" ? copy.summarising : copy.summarise}
			</Button>
			{current.status === "failed" && <span className="text-xs text-kumo-danger">{copy.summaryFailed}</span>}
		</div>
	);
}

export function QuickReply({ email }: { email: Email }) {
	const [text, setText] = useState("");
	const { startCompose } = useUIStore();
	const name = cleanSenderName(email.sender_name || "") || email.sender;
	const open = () => { startCompose({ mode: "reply", originalEmail: email, text: text.trim() || undefined }); setText(""); };
	return (
		<form
			className="flex shrink-0 items-end gap-2 border-t border-kumo-line px-4 py-3 md:px-6"
			onSubmit={(e) => { e.preventDefault(); open(); }}
		>
			<label className="sr-only" htmlFor={`quick-reply-${email.id}`}>{copy.replyLabel}</label>
			<textarea
				id={`quick-reply-${email.id}`}
				rows={1}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); open(); } }}
				placeholder={fill(copy.replyPlaceholder, { name })}
				className="min-h-10 max-h-40 flex-1 resize-none rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default outline-none focus:border-kumo-brand field-sizing-content"
			/>
			<Button type="submit" variant="primary" icon={<ArrowBendUpLeftIcon size={14} />}>{copy.replyOpen}</Button>
		</form>
	);
}
