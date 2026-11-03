// Mail App addition (not part of upstream Agentic Inbox).
// Settings > Writing in a shared mailbox: your own name and signature, so the people you write to
// (and your team) can see who on the team sent each email.
import { Button, Input, useKumoToastManager } from "@cloudflare/kumo";
import { UsersThreeIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { MAX_NAME, MAX_SIGNATURE, sharedFromName } from "shared/people";
import { useMe, useUpdateMe } from "~/queries/people";
import copy from "~/copy/mailboxes.en-GB.json";

export default function PersonalSignOff({ mailboxName }: { mailboxName: string }) {
	const { data: me } = useMe();
	const save = useUpdateMe();
	const toast = useKumoToastManager();
	const [name, setName] = useState("");
	const [signature, setSignature] = useState("");

	useEffect(() => {
		if (!me) return;
		setName(me.name);
		setSignature(me.signature ?? "");
	}, [me]);

	if (!me) return null;
	const changed = name.trim() !== me.name || signature.trim() !== (me.signature ?? "").trim();
	const example = sharedFromName(name || me.name, mailboxName);

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-2">
				<UsersThreeIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{copy.signOffTitle}</span>
			</div>
			<p className="text-xs text-kumo-subtle mb-3">{copy.signOffIntro.replace("{example}", example)}</p>
			<div className="space-y-3">
				<Input label={copy.nameLabel} value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} />
				<label className="block">
					<span className="block text-base font-medium text-kumo-default mb-1.5">{copy.signatureLabel}</span>
					<textarea
						value={signature}
						onChange={(e) => setSignature(e.target.value)}
						maxLength={MAX_SIGNATURE}
						rows={4}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring"
					/>
					<span className="block text-xs text-kumo-subtle mt-1">{copy.signatureHint}</span>
				</label>
				<div className="flex justify-end">
					<Button
						variant="primary"
						size="sm"
						disabled={!changed || !name.trim()}
						loading={save.isPending}
						onClick={() => save.mutate({ name, signature }, {
							onSuccess: () => toast.add({ title: copy.saved }),
							onError: (e) => toast.add({ title: (e as Error).message, variant: "error" }),
						})}
					>
						{copy.save}
					</Button>
				</div>
			</div>
		</div>
	);
}
