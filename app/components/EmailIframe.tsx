// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: tracking pictures are removed and other web pictures are fetched privately through Mail App, with a note saying what was blocked.

import DOMPurify from "dompurify";
import { ShieldCheckIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { classifyImage, isRemoteImage } from "shared/trackers";
import copy from "~/copy/trackers.en-GB.json";

/**
 * Mail App: take web pictures out of the email before it's shown. Trackers are removed; every other
 * picture is marked with a number and loaded later through /api/v1/image, so nothing in the
 * email ever reaches the sender's servers directly.
 */
export function stripWebImages(html: string): { html: string; urls: string[]; trackers: string[] } {
	const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
	const urls: string[] = [];
	const trackers: string[] = [];
	doc.querySelectorAll("picture source[srcset]").forEach((el) => el.removeAttribute("srcset"));
	doc.querySelectorAll("img").forEach((img) => {
		const src = img.getAttribute("src");
		img.removeAttribute("srcset");
		// Pictures attached to the email itself (rewritten from cid: to our own address).
		if (src && src.startsWith("/api/v1/mailboxes/")) {
			img.setAttribute("data-app-img", String(urls.length));
			img.removeAttribute("src");
			urls.push(src);
			return;
		}
		if (!isRemoteImage(src)) return;
		const { tracker, company } = classifyImage({
			src: src!.trim(),
			width: img.getAttribute("width"),
			height: img.getAttribute("height"),
			style: img.getAttribute("style"),
		});
		if (tracker) {
			trackers.push(company);
			img.remove();
			return;
		}
		img.setAttribute("data-app-img", String(urls.length));
		img.removeAttribute("src");
		urls.push(src!.trim());
	});
	return { html: doc.body.innerHTML, urls, trackers };
}

/** The email's HTML made safe to show. Mail App: plain-text emails keep their line breaks. */
export function sanitizeEmailBody(body: string): string {
	const isPlainText = !/<[a-z][^>]*>/i.test(body);
	const html = isPlainText
		? body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>")
		: body;
	return DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true },
		FORBID_TAGS: ["style"],
		ADD_ATTR: ["target"],
		FORCE_BODY: true,
	});
}

// Pictures already fetched this session, so switching between emails doesn't fetch them again.
const imageCache = new Map<string, Promise<string | null>>();
export function fetchImage(url: string): Promise<string | null> {
	let p = imageCache.get(url);
	if (!p) {
		p = fetch(url.startsWith("/") ? url : `/api/v1/image?u=${encodeURIComponent(url)}`)
			.then((r) => (r.ok ? r.blob() : null))
			.then((blob) => blob && new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = reject;
				reader.readAsDataURL(blob);
			}))
			.catch(() => null);
		if (imageCache.size > 300) imageCache.clear();
		imageCache.set(url, p);
	}
	return p;
}

function blockedText(trackers: string[]): string {
	const who = [...new Set(trackers)];
	const named = who.length > 2 ? `${who.slice(0, 2).join(", ")} and others` : who.join(" and ");
	return (trackers.length === 1 ? copy.blockedOne : copy.blockedMany)
		.replace("{count}", String(trackers.length))
		.replace("{who}", named);
}

interface EmailIframeProps {
	body: string;
	/** When true, iframe auto-sizes to content height instead of filling parent */
	autoSize?: boolean;
}

/**
 * Renders email HTML inside a sandboxed iframe.
 *
 * Security model:
 * - DOMPurify sanitises the HTML before injection.
 * - The iframe sandbox does NOT include `allow-same-origin`, so even if
 *   DOMPurify has a bypass the attacker's code runs in an opaque origin
 *   with no access to the parent page's cookies, DOM, or API.
 * - Because the iframe is cross-origin we cannot read `contentDocument`
 *   for auto-sizing. Instead, the injected HTML includes a tiny inline
 *   script that posts its body height to the parent via `postMessage`.
 *   The `allow-scripts` flag is required for this, but scripts inside
 *   the opaque-origin sandbox cannot access anything useful.
 * - A strict CSP meta tag blocks external resource loads inside the
 *   iframe as a defense-in-depth layer.
 */
export default function EmailIframe({ body, autoSize }: EmailIframeProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(autoSize ? 100 : 0);
	const [trackers, setTrackers] = useState<string[]>([]);
	const imageUrls = useRef<string[]>([]);

	// Listen for height reports from the sandboxed iframe
	const handleMessage = useCallback(
		(event: MessageEvent) => {
			if (!autoSize) return;
			// Only accept messages from our own iframe
			if (event.source !== iframeRef.current?.contentWindow) return;
			if (
				event.data &&
				typeof event.data === "object" &&
				event.data.__emailIframeHeight &&
				typeof event.data.height === "number" &&
				event.data.height > 0
			) {
				setHeight(event.data.height);
			}
		},
		[autoSize],
	);

	useEffect(() => {
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [handleMessage]);

	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe || !body) return;

		const stripped = stripWebImages(sanitizeEmailBody(body));
		imageUrls.current = stripped.urls;
		setTrackers(stripped.trackers);

		const padding = autoSize ? "0" : "24px";

		// Height-reporting script: sends body.scrollHeight to the parent.
		// Runs inside the opaque-origin sandbox so it has zero access to
		// the parent page — it can only postMessage.
		// Mail App: also receives pictures from the parent (as data: addresses) and puts them in place.
		const heightScript = `<script>
				function reportHeight() {
					${autoSize ? `var h = document.body.scrollHeight;
					if (h > 0) parent.postMessage({ __emailIframeHeight: true, height: h }, "*");` : ""}
				}
				window.addEventListener("message", function (e) {
					if (e.source !== parent || !e.data || !e.data.__appImg) return;
					if (typeof e.data.src !== "string" || e.data.src.indexOf("data:image/") !== 0) return;
					var imgs = document.querySelectorAll('img[data-app-img="' + Number(e.data.i) + '"]');
					for (var k = 0; k < imgs.length; k++) { imgs[k].onload = reportHeight; imgs[k].src = e.data.src; }
				});
				reportHeight();
				setTimeout(reportHeight, 50);
				setTimeout(reportHeight, 150);
				setTimeout(reportHeight, 400);
			<\/script>`;

		// Use srcdoc so the iframe is truly sandboxed (no same-origin access).
		// We can't use doc.write() because that requires allow-same-origin.
		iframe.srcdoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:; script-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; }
html {
	background: #ffffff;
	color-scheme: light;
}
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	font-size: 14px;
	line-height: 1.6;
	color: #1a1a1a;
	background: #ffffff;
	padding: ${padding};
	margin: 0;
	word-wrap: break-word;
	overflow-wrap: break-word;
	${autoSize ? "overflow: hidden;" : ""}
}
[style*="position: fixed"], [style*="position:fixed"], [style*="position: absolute"], [style*="position:absolute"] {
	position: relative !important;
}
a { color: #2563eb; }
img { max-width: 100%; height: auto; }
blockquote {
	border-left: 3px solid #d1d5db;
	padding-left: 1em;
	margin-left: 0;
	color: #6b7280;
}
pre {
	background: #f3f4f6;
	padding: 12px;
	border-radius: 6px;
	overflow-x: auto;
	font-size: 13px;
}
table { border-collapse: collapse; max-width: 100%; }
td, th { padding: 4px 8px; }
p { margin: 4px 0; }
h1, h2, h3 { margin: 8px 0 4px; }
ul, ol { padding-left: 20px; margin: 4px 0; }
</style>
</head>
<body>${stripped.html}${heightScript}</body>
</html>`;
	}, [body, autoSize]);

	// Mail App: once the email is showing, fetch its pictures privately and hand them in.
	const handleLoad = useCallback(() => {
		const win = iframeRef.current?.contentWindow;
		if (!win) return;
		imageUrls.current.forEach((url, i) => {
			fetchImage(url).then((src) => {
				if (src && iframeRef.current?.contentWindow === win) win.postMessage({ __appImg: true, i, src }, "*");
			});
		});
	}, []);

	// Always the same wrapper, so the iframe isn't re-created when the tracker note appears.
	return (
		<div className={autoSize ? undefined : "flex h-full flex-col"}>
			{trackers.length > 0 && (
				<div
					className="mb-2 self-start inline-flex items-center gap-1.5 rounded-md bg-kumo-tint px-2 py-1 text-xs text-kumo-strong"
					title={copy.explain}
				>
					<ShieldCheckIcon size={14} weight="duotone" className="text-green-600 shrink-0" />
					{blockedText(trackers)}
				</div>
			)}
			<iframe
				ref={iframeRef}
				onLoad={handleLoad}
				className="block w-full border-0"
				style={autoSize ? { height: `${height}px` } : { flex: 1, minHeight: 0 }}
				sandbox="allow-scripts allow-popups allow-top-navigation-by-user-activation"
				title="Email content"
			/>
		</div>
	);
}
