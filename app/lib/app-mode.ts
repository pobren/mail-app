// Mail App, 2026: Mail App as an app on your Dock or home screen. Registers the service worker, keeps the
// unread count on the app's icon, and switches new-mail notifications on and off for this device.

import { useEffect, useState } from "react";

export const LAST_MAILBOX_KEY = "mailapp.lastMailbox";

/** Registers the service worker once, in the browser only. */
export function registerServiceWorker(): void {
	if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
	navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("Service worker not registered:", e));
}

/** Is Mail App running as an installed app (its own window), rather than in a browser tab? */
export function isInstalled(): boolean {
	if (typeof window === "undefined") return false;
	return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

export type InstallHint = "installed" | "installIphone" | "installAndroid" | "installChrome" | "installMacSafari" | "installOther";

/** Which install steps to show for this browser. */
export function installHint(): InstallHint {
	if (isInstalled()) return "installed";
	const ua = navigator.userAgent;
	if (/iPhone|iPad|iPod/.test(ua)) return "installIphone";
	if (/Android/.test(ua)) return "installAndroid";
	if (/Edg\/|Chrome\//.test(ua)) return "installChrome";
	if (/Mac OS X/.test(ua) && /Safari\//.test(ua)) return "installMacSafari";
	return "installOther";
}

// Chrome, Edge and Android let a page open the browser's own install box, but only after the browser
// says it's allowed (the beforeinstallprompt event, which can come before the page is ready for it).
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
let installPrompt: InstallPromptEvent | null = null;
const promptListeners = new Set<() => void>();
if (typeof window !== "undefined") {
	window.addEventListener("beforeinstallprompt", (e) => {
		e.preventDefault();
		installPrompt = e as InstallPromptEvent;
		promptListeners.forEach((f) => f());
	});
	window.addEventListener("appinstalled", () => {
		installPrompt = null;
		promptListeners.forEach((f) => f());
	});
}

/** A one-click install, where the browser allows it; null elsewhere (Safari, iPhone, Firefox). */
export function useInstallPrompt(): (() => Promise<boolean>) | null {
	const [, setTick] = useState(0);
	useEffect(() => {
		const f = () => setTick((n) => n + 1);
		promptListeners.add(f);
		return () => { promptListeners.delete(f); };
	}, []);
	if (!installPrompt) return null;
	const event = installPrompt;
	return async () => {
		await event.prompt();
		const { outcome } = await event.userChoice;
		installPrompt = null;
		promptListeners.forEach((f) => f());
		return outcome === "accepted";
	};
}

/** Keeps the number on the app's icon in step with unread mail in the inbox. `checkedAt` is when the
 * count was last fetched: the badge is set again every time, because a new-mail notification can change
 * it behind the page's back, and a count that looks unchanged here may not match the icon any more.
 * Once the inbox is all read, notifications still showing are cleared too. */
export function useAppBadge(unread: number | undefined, checkedAt?: number): void {
	useEffect(() => {
		if (unread === undefined || typeof navigator === "undefined") return;
		if ("setAppBadge" in navigator) (unread > 0 ? navigator.setAppBadge(unread) : navigator.clearAppBadge()).catch(() => {});
		if (unread === 0 && "serviceWorker" in navigator) {
			navigator.serviceWorker.getRegistration()
				.then((reg) => reg?.getNotifications())
				.then((shown) => shown?.forEach((n) => n.close()))
				.catch(() => {});
		}
	}, [unread, checkedAt]);
}

/** Runs when a new-mail notification arrives while the app is open, so the inbox can update at once. */
export function useNewMailSignal(onNewMail: () => void): void {
	useEffect(() => {
		if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
		const listen = (e: MessageEvent) => { if (e.data?.type === "new-mail") onNewMail(); };
		navigator.serviceWorker.addEventListener("message", listen);
		return () => navigator.serviceWorker.removeEventListener("message", listen);
	}, [onNewMail]);
}

export type PushState = "unsupported" | "needs-install" | "blocked" | "off" | "on";

/** Can this device have notifications, and are they on for this mailbox? */
export async function pushState(mailboxId: string): Promise<PushState> {
	if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
		// iPhone and iPad only offer notifications once Mail App is on the home screen.
		return /iPhone|iPad|iPod/.test(navigator.userAgent) && !isInstalled() ? "needs-install" : "unsupported";
	}
	if (Notification.permission === "denied") return "blocked";
	const reg = await navigator.serviceWorker.getRegistration();
	const sub = await reg?.pushManager.getSubscription();
	if (!sub) return "off";
	// One browser can have notifications on for some mailboxes and not others.
	const res = await fetch(`/api/v1/mailboxes/${mailboxId}/push`);
	const devices = res.ok ? ((await res.json()) as { endpoint: string }[]) : [];
	return devices.some((d) => d.endpoint === sub.endpoint) && Notification.permission === "granted" ? "on" : "off";
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
	const s = atob(b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4));
	return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** A short name for this device, for the list in Settings. */
export function deviceName(): string {
	const ua = navigator.userAgent;
	const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
	const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Linux";
	return `${isInstalled() ? "Mail App app" : browser} on ${os}`;
}

/** Asks permission, then tells this install where to send notifications for this mailbox. */
export async function turnOnPush(mailboxId: string): Promise<PushState> {
	if ((await Notification.requestPermission()) !== "granted") return Notification.permission === "denied" ? "blocked" : "off";
	const reg = await navigator.serviceWorker.register("/sw.js");
	await navigator.serviceWorker.ready;
	const { publicKey } = await (await fetch("/api/v1/push/key")).json() as { publicKey: string };
	let sub = await reg.pushManager.getSubscription();
	// A subscription made with another install's key can't be used here.
	if (sub && sub.options.applicationServerKey) {
		const current = new Uint8Array(sub.options.applicationServerKey);
		const wanted = keyBytes(publicKey);
		if (current.length !== wanted.length || current.some((b, i) => b !== wanted[i])) { await sub.unsubscribe(); sub = null; }
	}
	sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
	const json = sub.toJSON();
	const res = await fetch(`/api/v1/mailboxes/${mailboxId}/push`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, device: deviceName() }),
	});
	if (!res.ok) throw new Error(`Couldn't switch notifications on (${res.status}).`);
	return "on";
}

export async function turnOffPush(mailboxId: string): Promise<PushState> {
	const reg = await navigator.serviceWorker.getRegistration();
	const sub = await reg?.pushManager.getSubscription();
	if (sub) {
		await fetch(`/api/v1/mailboxes/${mailboxId}/push`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint: sub.endpoint }),
		}).catch(() => {});
		// The browser keeps its subscription, as other mailboxes here may still use it.
	}
	return "off";
}

export async function testPush(mailboxId: string): Promise<number> {
	const res = await fetch(`/api/v1/mailboxes/${mailboxId}/push/test`, { method: "POST" });
	if (!res.ok) throw new Error(String(res.status));
	return ((await res.json()) as { sent: number }).sent;
}
