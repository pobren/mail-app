// Mail App 2.3: light and dark mode. "auto" follows the computer or phone's own setting. The choice is
// kept in this browser (Settings > Account > Appearance), and the page sets data-mode on <html>, which
// Kumo and app/index.css use for their dark colours.

import { useEffect, useState } from "react";

export type Appearance = "auto" | "light" | "dark";
export const APPEARANCE_KEY = "mail-app-appearance";

/** Runs in the page head before anything draws, so a dark page never flashes white. */
export const APPEARANCE_SCRIPT = `(function(){try{var a=localStorage.getItem("${APPEARANCE_KEY}")||"auto";var d=a==="dark"||(a==="auto"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-mode",d?"dark":"light");document.documentElement.style.colorScheme=d?"dark":"light"}catch(e){}})()`;

export function getAppearance(): Appearance {
	try {
		const v = localStorage.getItem(APPEARANCE_KEY);
		return v === "light" || v === "dark" ? v : "auto";
	} catch {
		return "auto";
	}
}

function systemDark(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyAppearance(a: Appearance = getAppearance()): void {
	if (typeof document === "undefined") return;
	const dark = a === "dark" || (a === "auto" && systemDark());
	document.documentElement.setAttribute("data-mode", dark ? "dark" : "light");
	document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function setAppearance(a: Appearance): void {
	try {
		if (a === "auto") localStorage.removeItem(APPEARANCE_KEY);
		else localStorage.setItem(APPEARANCE_KEY, a);
	} catch {
		// Private windows can refuse storage; the choice still applies until the page is closed.
	}
	applyAppearance(a);
}

/** Follows the computer's setting while it changes (sunset, for example). Returns a stop function. */
export function watchSystemAppearance(): () => void {
	if (typeof matchMedia !== "function") return () => {};
	const mq = matchMedia("(prefers-color-scheme: dark)");
	const on = () => { if (getAppearance() === "auto") applyAppearance("auto"); };
	mq.addEventListener("change", on);
	return () => mq.removeEventListener("change", on);
}

/** True while the page is dark, following changes. */
export function useIsDark(): boolean {
	const [dark, setDark] = useState(false);
	useEffect(() => {
		const el = document.documentElement;
		const read = () => setDark(el.getAttribute("data-mode") === "dark");
		read();
		const obs = new MutationObserver(read);
		obs.observe(el, { attributes: true, attributeFilter: ["data-mode"] });
		return () => obs.disconnect();
	}, []);
	return dark;
}
