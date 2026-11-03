// Mail App addition (not part of upstream Agentic Inbox).
// The page someone sees when they open a download link. It is the only Mail App page anyone can open without
// signing in. The file is decrypted here in their browser; the server only ever sends the scrambled copy.
// deriveKeys below must match shared/links.ts.
import { LINK_DAYS } from "shared/links";

const SCRIPT = String.raw`
(() => {
	const $ = (id) => document.getElementById(id);
	const enc = new TextEncoder();
	const token = location.pathname.split("/").filter(Boolean)[1] || "";
	const key = location.hash.slice(1);
	const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
	const unb64 = (t) => { const s = t.replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(s + "===".slice((s.length + 3) % 4)); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); };
	const size = (n) => n < 1024 ? n + " bytes" : n < 1048576 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(1) + " MB";
	const date = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
	const minutes = (s) => Math.max(1, Math.ceil(s / 60));

	async function deriveKeys(secret, salt) {
		const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits", "deriveKey"]);
		const fileKey = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("mail-app link file") }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
		const auth = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("mail-app link auth") }, base, 256));
		return { fileKey, auth };
	}
	async function passwordSecret(password, salt, iterations) {
		const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
		return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256));
	}

	function show(state, text) {
		for (const el of document.querySelectorAll("[data-state]")) el.hidden = el.dataset.state !== state;
		if (text !== undefined) $("message").textContent = text;
		$("message").hidden = !text;
	}

	let info = null;
	async function load() {
		if (!window.crypto || !crypto.subtle) return show("none", "This browser can't open protected files. Try an up-to-date Chrome, Edge, Firefox or Safari.");
		try {
			const res = await fetch("/f/" + token + "/info", { cache: "no-store" });
			if (!res.ok) return show("gone");
			info = await res.json();
		} catch { return show("none", "We couldn't reach this download. Check your connection and reload the page."); }
		$("size").textContent = size(info.size);
		$("expires").textContent = date(info.expires);
		if (info.protected) { show("password"); $("password").focus(); }
		else if (!key) show("none", "This link is incomplete. Ask the sender to copy the whole link, including everything after the # sign.");
		else show("ready");
		if (info.lockedSeconds) $("message").textContent = "Too many wrong passwords. Try again in " + minutes(info.lockedSeconds) + " minutes.", $("message").hidden = false;
	}

	async function download(event) {
		event.preventDefault();
		const button = event.submitter || $("go");
		button.disabled = true;
		$("message").hidden = true;
		try {
			const salt = unb64(info.salt);
			$("progress").textContent = info.protected ? "Checking the password…" : "Starting…";
			const secret = info.protected ? await passwordSecret($("password").value, salt, info.iterations) : unb64(key);
			const { fileKey, auth } = await deriveKeys(secret, salt);
			const res = await fetch("/f/" + token + "/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ auth: b64(auth) }), cache: "no-store" });
			if (res.status === 403) {
				const body = await res.json();
				$("progress").textContent = "";
				show(info.protected ? "password" : "none", body.lockedSeconds ? "Too many wrong passwords. Try again in " + minutes(body.lockedSeconds) + " minutes." : info.protected ? "That password isn't right. " + body.left + (body.left === 1 ? " try" : " tries") + " left before the link pauses for a while." : "This link is damaged. Ask the sender to copy it again.");
				return;
			}
			if (res.status === 429) { $("progress").textContent = ""; show(info.protected ? "password" : "ready", "Too many wrong passwords. Try again in " + minutes((await res.json()).lockedSeconds) + " minutes."); return; }
			if (!res.ok || !res.body) { $("progress").textContent = ""; show("gone"); return; }
			const total = Number(res.headers.get("content-length")) || info.size;
			const reader = res.body.getReader();
			const chunks = []; let got = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value); got += value.length;
				$("progress").textContent = "Downloading… " + Math.min(100, Math.round((got / total) * 100)) + "%";
			}
			const data = new Uint8Array(got); let at = 0;
			for (const c of chunks) { data.set(c, at); at += c.length; }
			$("progress").textContent = "Unlocking the file…";
			const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(res.headers.get("x-mail-app-iv") || "") }, fileKey, data);
			const name = decodeURIComponent(res.headers.get("x-mail-app-name") || "download");
			const type = decodeURIComponent(res.headers.get("x-mail-app-type") || "application/octet-stream");
			const url = URL.createObjectURL(new Blob([plain], { type }));
			const a = document.createElement("a");
			a.href = url; a.download = name; a.rel = "noopener";
			document.body.appendChild(a); a.click(); a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 60000);
			$("progress").textContent = "";
			$("done-name").textContent = name;
			show("done");
		} catch {
			$("progress").textContent = "";
			show(info && info.protected ? "password" : "ready", "Something went wrong opening this file. Please try again.");
		} finally { button.disabled = false; }
	}

	$("form").addEventListener("submit", download);
	load();
})();
`;

const STYLE = `body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:#eef1f1;color:#12262b}
main{max-width:30rem;margin:10vh auto;padding:0 16px}
.card{background:#fff;border:1px solid #d9e0e1;border-radius:12px;padding:28px}
h1{font-size:1.35rem;margin:14px 0 6px}p{color:#4d6066;margin:8px 0}
label{display:block;font-weight:600;margin:16px 0 6px}
input{box-sizing:border-box;width:100%;font:inherit;padding:10px 12px;border:1px solid #b9c4c6;border-radius:8px}
button{margin-top:16px;font:inherit;font-weight:600;color:#fff;background:#c8102e;border:0;border-radius:8px;padding:10px 18px;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
#message{color:#a00d26;font-weight:500}#progress{min-height:1.5em;font-size:.9rem}
small{display:block;margin-top:20px;color:#7f9095;font-size:.8rem}
@media (prefers-color-scheme:dark){body{background:#0f1c1f;color:#e6eef0}.card{background:#16272b;border-color:#26393e}p{color:#a9bcc1}input{background:#0f1c1f;color:#e6eef0;border-color:#3a5156}#message{color:#ff8a9a}small{color:#7f9599}}`;

const LOGO = `<svg width="34" height="34" viewBox="0 0 30 30" aria-hidden="true"><rect x="1" y="5" width="28" height="20" rx="4" fill="#c8102e"/><path d="M5 10l10 7 10-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function linkPage(available: string | null): string {
	return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<title>Download a file</title><style>${STYLE}</style></head>
<body><main><div class="card">${LOGO}
<div data-state="gone"${available ? " hidden" : ""}><h1>This link has expired</h1><p>Download links last ${LINK_DAYS} days, and the sender can remove them sooner. Ask them to send the file again.</p></div>
<form id="form" novalidate${available ? "" : " hidden"}>
	<h1>Someone has shared a file with you</h1>
	<p>Size: <span id="size">…</span>. Available until <span id="expires">…</span>.</p>
	<div data-state="password" hidden>
		<label for="password">Password</label>
		<input id="password" type="password" autocomplete="off" required>
		<p>The sender should have given you the password separately.</p>
		<button type="submit">Unlock and download</button>
	</div>
	<div data-state="ready" hidden><button id="go" type="submit">Download</button></div>
	<div data-state="done" hidden><p>Downloaded <strong id="done-name"></strong>. Check your Downloads folder.</p><button type="submit">Download again</button></div>
	<div data-state="none" hidden></div>
	<p id="progress" aria-live="polite"></p>
	<p id="message" role="alert" hidden></p>
</form>
<small>Sent with Mail App. The file is encrypted and is only unlocked here, in your browser.</small>
</div></main>${available ? `<script>${SCRIPT}</script>` : ""}</body></html>`;
}
