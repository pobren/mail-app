// Mail App addition (not part of upstream Agentic Inbox).

/** No Origin (not a browser, or a same-site page in an older browser) is fine; otherwise it must be this app. */
export function sameSite(origin: string | undefined, url: URL): boolean {
	if (!origin) return true;
	try {
		return new URL(origin).host === url.host;
	} catch {
		return false;
	}
}
