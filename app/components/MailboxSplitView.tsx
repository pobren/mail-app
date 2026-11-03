// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: on wider screens the composer floats in its own box (ComposeDock) instead. On phones, a round Compose button floats over the email list.

import { PencilSimpleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import ComposePanel from "~/components/ComposePanel";
import EmailPanel from "~/components/EmailPanel";
import { useIsWide } from "~/hooks/useIsWide";
import { useUIStore } from "~/hooks/useUIStore";

interface MailboxSplitViewProps {
	selectedEmailId: string | null;
	isComposing: boolean;
	children: ReactNode;
}

export default function MailboxSplitView({
	selectedEmailId,
	isComposing: composing,
	children,
}: MailboxSplitViewProps) {
	const wide = useIsWide();
	const isComposing = composing && !wide;
	const isPanelOpen = selectedEmailId !== null || isComposing;
	const { startCompose } = useUIStore();

	return (
		<div className="flex h-full">
			<div
				className={`flex flex-col min-w-0 shrink-0 ${
					isPanelOpen
						? "hidden md:flex md:w-[380px] md:border-r md:border-kumo-line"
						: "w-full"
				}`}
			>
				{children}
			</div>
			{isPanelOpen && (
				<div className="flex-1 flex flex-col min-w-0 overflow-hidden w-full md:w-auto">
					{isComposing && !selectedEmailId ? (
						<ComposePanel />
					) : isComposing && selectedEmailId ? (
						<div className="flex flex-col h-full overflow-y-auto">
							<ComposePanel />
							<div className="border-t border-kumo-line">
								<EmailPanel emailId={selectedEmailId} />
							</div>
						</div>
					) : selectedEmailId ? (
						<EmailPanel emailId={selectedEmailId} />
					) : null}
				</div>
			)}
			{/* Mail App: phones have no sidebar on screen, so Compose floats over the list */}
			{!isPanelOpen && (
				<button
					type="button"
					onClick={() => startCompose()}
					aria-label="Compose"
					title="Compose"
					className="fixed right-4 z-20 flex size-14 items-center justify-center rounded-2xl bg-kumo-brand text-white shadow-lg active:scale-95 transition-transform md:hidden bottom-[calc(5rem+env(safe-area-inset-bottom))]"
				>
					<PencilSimpleIcon size={24} />
				</button>
			)}
		</div>
	);
}
