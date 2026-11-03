// Mail App, 2026.
import { useEffect, useState } from "react";

/** Mail App: an on/off choice kept in this browser, such as whether a sidebar list is folded away. */
export function useRemembered(key: string, initial: boolean) {
	const [value, setValue] = useState(initial);
	useEffect(() => {
		try {
			const saved = localStorage.getItem(key);
			if (saved !== null) setValue(saved === "1");
		} catch { /* storage blocked: just don't remember */ }
	}, [key]);
	const set = (next: boolean) => {
		setValue(next);
		try { localStorage.setItem(key, next ? "1" : "0"); } catch { /* not remembered */ }
	};
	return [value, set] as const;
}
