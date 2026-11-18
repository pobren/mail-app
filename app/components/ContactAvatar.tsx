// Mail App addition (not part of upstream Agentic Inbox).
// A contact's photo from Gravatar when the person has switched photos on in Settings, otherwise initials.
import { useEffect, useState } from "react";
import { initials } from "shared/contacts";

const hashes = new Map<string, Promise<string>>();

/** Gravatar looks people up by the SHA-256 of their lower-cased address. */
function gravatarHash(email: string): Promise<string> {
	const key = email.trim().toLowerCase();
	let hash = hashes.get(key);
	if (!hash) {
		hash = crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)).then((buf) =>
			Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join(""),
		);
		hashes.set(key, hash);
	}
	return hash;
}

// Mail App 2.3: soft colours for initials, the same for a person every time (picked from their address).
const PALETTE: [string, string][] = [
	["#e7eefb", "#2747a8"], ["#fcefe6", "#a2481c"], ["#e8f4ee", "#1e7a50"],
	["#f1ecfb", "#5b3bb0"], ["#fdf3d9", "#8a5a00"], ["#e6f3f7", "#1d6b80"],
];

export function avatarColours(email: string): { "--av-bg": string; "--av-ink": string } {
	let h = 0;
	for (const ch of email.trim().toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	const [bg, ink] = PALETTE[h % PALETTE.length];
	return { "--av-bg": bg, "--av-ink": ink };
}

export default function ContactAvatar({ email, name, photos, size = 36 }: { email: string; name: string; photos: boolean; size?: number }) {
	const [src, setSrc] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		setSrc(null);
		setFailed(false);
		if (!photos) return;
		let live = true;
		// d=404 means "no picture" comes back as an error, so we fall back to initials.
		gravatarHash(email).then((h) => { if (live) setSrc(`https://gravatar.com/avatar/${h}?s=${size * 2}&d=404`); });
		return () => { live = false; };
	}, [email, photos, size]);

	const style = { width: size, height: size };
	if (src && !failed) {
		return <img src={src} alt="" style={style} className="shrink-0 rounded-full object-cover" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
	}
	return (
		<span style={{ ...style, ...avatarColours(email), fontSize: size * 0.38 } as React.CSSProperties} aria-hidden className="app-avatar shrink-0 rounded-full font-semibold flex items-center justify-center">
			{initials({ email, name })}
		</span>
	);
}
