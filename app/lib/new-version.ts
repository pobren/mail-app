// Mail App, 2026: an app window (or tab) left open across an update keeps running the old version,
// which can trip over the new server ("Request failed: 500" on Send). Every API answer says which
// build sent it; when that isn't the build this window is running, the window reloads the next time
// you come back to it, unless you're in the middle of writing an email.

import { useUIStore } from "~/hooks/useUIStore";

let newer = false;
let listening = false;

/** Called with the App-Build header of each API answer. */
export function noteServerBuild(build: string | null): void {
	if (!build || typeof __APP_BUILD__ === "undefined" || build === __APP_BUILD__ || newer) return;
	newer = true;
	listen();
}

function reloadIfSafe(): void {
	if (!newer || document.visibilityState !== "visible") return;
	if (useUIStore.getState().isComposing) return;
	window.location.reload();
}

function listen(): void {
	if (listening || typeof window === "undefined") return;
	listening = true;
	document.addEventListener("visibilitychange", reloadIfSafe);
	window.addEventListener("focus", reloadIfSafe);
	// Writing an email when the update was noticed: reload once it's sent or closed, if the window is
	// in the background by then. Otherwise the next return to the window does it.
	useUIStore.subscribe((state, prev) => {
		if (prev.isComposing && !state.isComposing && document.visibilityState !== "visible") reloadIfSafe();
	});
}

/**
 * Checks for a newer build each time you come back to the window, so one left open overnight
 * reloads before you use it, not after something fails.
 */
export function watchForNewVersion(): () => void {
	const check = () => {
		if (document.visibilityState !== "visible") return;
		fetch("/api/v1/config", { cache: "no-store" })
			.then((res) => { noteServerBuild(res.headers.get("App-Build")); reloadIfSafe(); })
			.catch(() => { /* offline: try again next time */ });
	};
	document.addEventListener("visibilitychange", check);
	return () => document.removeEventListener("visibilitychange", check);
}
