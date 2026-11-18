// Mail App 2.3: Settings › Account › Appearance. Light, dark or match the device (app/lib/appearance.ts).

import { DesktopIcon, MoonIcon, PaletteIcon, SunIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { getAppearance, setAppearance, type Appearance } from "~/lib/appearance";
import t from "~/copy/appearance.en-GB.json";

const CHOICES: { value: Appearance; icon: React.ReactNode }[] = [
	{ value: "auto", icon: <DesktopIcon size={16} /> },
	{ value: "light", icon: <SunIcon size={16} /> },
	{ value: "dark", icon: <MoonIcon size={16} /> },
];

export default function AppearanceSettings() {
	const [current, setCurrent] = useState<Appearance>("auto");
	useEffect(() => setCurrent(getAppearance()), []);
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="mb-2 flex items-center gap-2">
				<PaletteIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{t.title}</span>
			</div>
			<p className="mb-3 text-xs text-kumo-subtle">{t.intro}</p>
			<div role="radiogroup" aria-label={t.title} className="inline-flex rounded-lg bg-kumo-tint p-1 gap-1">
				{CHOICES.map((c) => {
					const on = current === c.value;
					return (
						<button
							key={c.value}
							type="button"
							role="radio"
							aria-checked={on}
							onClick={() => { setAppearance(c.value); setCurrent(c.value); }}
							className={`flex items-center gap-2 rounded-md border-0 px-3 py-1.5 text-sm cursor-pointer ${on ? "bg-kumo-base text-kumo-default font-medium shadow-sm" : "bg-transparent text-kumo-strong hover:text-kumo-default"}`}
						>
							{c.icon}
							{t[c.value]}
						</button>
					);
				})}
			</div>
		</div>
	);
}
