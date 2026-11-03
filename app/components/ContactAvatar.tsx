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
		<span style={{ ...style, fontSize: size * 0.4 }} aria-hidden className="shrink-0 rounded-full bg-kumo-fill text-kumo-strong font-semibold flex items-center justify-center">
			{initials({ email, name })}
		</span>
	);
}
