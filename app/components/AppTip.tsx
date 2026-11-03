// Mail App, 2026: a tip above the inbox suggesting Mail App on the Dock or home screen. One click
// installs it where the browser allows; elsewhere it shows the steps. Hidden for good once hidden,
// and never shown inside the installed app or in browsers that can't install it.

import { AppWindowIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { installHint, useInstallPrompt, type InstallHint } from "~/lib/app-mode";
import copy from "~/copy/app-tip.en-GB.json";
import settingsCopy from "~/copy/settings.en-GB.json";

const HIDE_KEY = "app-hide-app-tip";

export default function AppTip() {
	const [hint, setHint] = useState<InstallHint | null>(null);
	const [hidden, setHidden] = useState(true);
	const [open, setOpen] = useState(false);
	const [done, setDone] = useState(false);
	const install = useInstallPrompt();

	useEffect(() => {
		setHint(installHint());
		try { setHidden(localStorage.getItem(HIDE_KEY) === "1"); } catch { setHidden(false); }
	}, []);

	if (!hint || hidden || hint === "installed" || (hint === "installOther" && !install)) return null;

	const hide = () => {
		try { localStorage.setItem(HIDE_KEY, "1"); } catch { /* private window: hidden until reload */ }
		setHidden(true);
	};

	return (
		<div className="mx-3 mt-3 flex items-start gap-3 rounded-lg border border-kumo-line bg-kumo-base px-3.5 py-3 text-sm text-kumo-default md:mx-4" role="note">
			<AppWindowIcon size={22} weight="duotone" className="mt-0.5 shrink-0" style={{ color: "var(--brand)" }} />
			<div className="min-w-0 flex-1">
				<b>{copy.title}</b>{" "}
				<span className="text-kumo-subtle">{done ? copy.installed : copy.text}</span>
				{!done && (
					<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
						{install ? (
							<Button variant="primary" size="sm" onClick={() => void install().then((ok) => ok && setDone(true)).catch(() => setOpen(true))}>
								{copy.install}
							</Button>
						) : (
							<Button variant="secondary" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
								{copy.howTo}
							</Button>
						)}
						<a href={copy.guideUrl} target="_blank" rel="noreferrer" className="text-xs text-kumo-subtle underline hover:text-kumo-default">
							{copy.guide}
						</a>
					</div>
				)}
				{open && !install && <p className="mt-2 text-sm text-kumo-default">{settingsCopy.device[hint]}</p>}
			</div>
			<button type="button" onClick={hide} aria-label={copy.hideLabel} title={copy.hideLabel}
				className="-mr-1 -mt-0.5 flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default">
				{copy.hide}
				<XIcon size={12} />
			</button>
		</div>
	);
}
