// Mail App addition (not part of upstream Agentic Inbox).
// Settings > Account > Passkeys: add one on each device, then choose Passkey on Cloudflare's sign-in
// page instead of waiting for an email code. See shared/passkeys.ts for how it works.
import { Button, Input, useKumoToastManager } from "@cloudflare/kumo";
import { TrashIcon } from "@phosphor-icons/react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import type { PasskeyView } from "shared/passkeys";
import { PASSKEY_MARK_BLACK, PASSKEY_MARK_WHITE, markSrc } from "shared/passkey-mark";
import copy from "~/copy/settings.en-GB.json";
import { fill } from "~/lib/attachments";
import api, { ApiError, type PasskeysView } from "~/services/api";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default function Passkeys() {
	const c = copy.passkeys;
	const toastManager = useKumoToastManager();
	const [view, setView] = useState<PasskeysView | null>(null);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [supported, setSupported] = useState(true);

	useEffect(() => {
		setSupported(browserSupportsWebAuthn());
		api.getPasskeys().then((v) => { setView(v); setName(v.suggestedName); }).catch(() => setView(null));
	}, []);

	if (!view) return null;

	const add = async () => {
		setBusy(true);
		try {
			const { options, state } = await api.passkeyOptions();
			const response = await startRegistration({ optionsJSON: options });
			const added = await api.addPasskey({ state, name, response });
			setView({ ...view, passkeys: [...view.passkeys, added] });
			toastManager.add({ title: c.saved });
		} catch (e) {
			const cancelled = e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError");
			const message = e instanceof ApiError && typeof e.body.error === "string" ? e.body.error : cancelled ? c.cancelled : c.error;
			toastManager.add({ title: message, variant: cancelled ? undefined : "error" });
		} finally {
			setBusy(false);
		}
	};

	const remove = async (p: PasskeyView) => {
		if (!window.confirm(fill(c.removeConfirm, { name: p.name }))) return;
		try {
			await api.deletePasskey(p.id);
			setView({ ...view, passkeys: view.passkeys.filter((x) => x.id !== p.id) });
			toastManager.add({ title: c.removed });
		} catch {
			toastManager.add({ title: c.error, variant: "error" });
		}
	};

	const full = view.passkeys.length >= view.max;

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-2">
				<img src={markSrc(PASSKEY_MARK_BLACK)} alt="" width={22} height={22} />
				<span className="text-sm font-medium text-kumo-default">{c.title}</span>
			</div>
			<p className="text-sm text-kumo-default mb-1">{c.intro}</p>
			<p className="text-xs text-kumo-subtle mb-4">{c.how}</p>

			{view.passkeys.length === 0 ? (
				view.on && <p className="text-sm text-kumo-subtle mb-4">{c.none}</p>
			) : (
				<ul className="mb-4 divide-y divide-kumo-line rounded-md border border-kumo-line">
					{view.passkeys.map((p) => (
						<li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
							<div className="min-w-0">
								<div className="truncate text-sm font-medium text-kumo-default">{p.name}</div>
								<div className="text-xs text-kumo-subtle">
									{fill(c.added, { date: day(p.created) })}
									{p.lastUsed ? `, ${fill(c.used, { date: day(p.lastUsed) })}` : ""}
								</div>
							</div>
							<Button variant="ghost" size="sm" icon={<TrashIcon size={14} />} onClick={() => void remove(p)}>{c.remove}</Button>
						</li>
					))}
				</ul>
			)}

			{!view.on ? (
				<p className="text-sm text-kumo-subtle">{c.off}</p>
			) : !supported ? (
				<p className="text-sm text-kumo-subtle">{c.unsupported}</p>
			) : full ? (
				<p className="text-sm text-kumo-subtle">{c.full}</p>
			) : (
				<div className="flex flex-wrap items-end gap-3">
					<div className="w-full max-w-xs">
						<Input label={c.name} value={name} placeholder={c.namePlaceholder} maxLength={60} onChange={(e) => setName(e.target.value)} />
					</div>
					<Button variant="primary" icon={<img src={markSrc(PASSKEY_MARK_WHITE)} alt="" width={22} height={22} />} disabled={busy} onClick={() => void add()}>
						{busy ? c.adding : c.add}
					</Button>
				</div>
			)}
		</div>
	);
}
