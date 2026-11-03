// Mail App: whether the screen is wide enough for the floating composer.

import { useEffect, useState } from "react";
import { WIDE_QUERY } from "~/hooks/useUIStore";

export function useIsWide(): boolean {
	const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(WIDE_QUERY).matches);
	useEffect(() => {
		const mq = window.matchMedia(WIDE_QUERY);
		const update = () => setWide(mq.matches);
		update();
		mq.addEventListener("change", update);
		return () => mq.removeEventListener("change", update);
	}, []);
	return wide;
}
