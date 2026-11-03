// Mail App: on wider screens, the email you're writing sits in a floating box in the bottom corner,
// like Gmail. You can keep reading and moving between folders behind it, shrink it to a bar, or make
// it full screen. Phones keep the full-screen composer in MailboxSplitView.

import ComposePanel from "~/components/ComposePanel";
import { useIsWide } from "~/hooks/useIsWide";
import { useUIStore } from "~/hooks/useUIStore";

const BOX = {
	normal: "bottom-0 right-6 w-[min(600px,calc(100vw-3rem))] h-[min(680px,calc(100vh-4rem))] rounded-t-xl",
	minimised: "bottom-0 right-6 w-[320px] rounded-t-xl",
	full: "inset-x-[6vw] inset-y-[5vh] rounded-xl",
} as const;

export default function ComposeDock() {
	const { isComposing, composeSize, setComposeSize, composeKey } = useUIStore();
	const wide = useIsWide();
	if (!wide || !isComposing) return null;

	return (
		<>
			{composeSize === "full" && (
				<div className="fixed inset-0 z-40 bg-black/30" onClick={() => setComposeSize("normal")} aria-hidden="true" />
			)}
			<section
				aria-label="Write an email"
				className={`fixed z-50 flex flex-col overflow-hidden border border-kumo-line bg-kumo-base shadow-2xl ${BOX[composeSize]}`}
				onKeyDown={(e) => { if (e.key === "Escape" && composeSize === "full") setComposeSize("normal"); }}
			>
				<ComposePanel key={composeKey} size={composeSize} onSize={setComposeSize} />
			</section>
		</>
	);
}
