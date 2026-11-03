// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: a new email can start with a recipient; on wider screens the composer is a
// floating box (see ComposeDock) that stays open while you read and move between folders; a new email can start with files attached.

import { create } from "zustand";
import type { Email } from "~/types";

export type ComposeMode = "new" | "reply" | "reply-all" | "forward";
/** Mail App: the floating composer's size on wider screens. */
export type ComposeSize = "normal" | "minimised" | "full";

/** Mail App: wide enough for the floating composer (Tailwind's md breakpoint). Phones keep the full-screen one. */
export const WIDE_QUERY = "(min-width: 768px)";
const isWide = () => typeof window !== "undefined" && window.matchMedia(WIDE_QUERY).matches;

export interface ComposeOptions {
	mode: ComposeMode;
	originalEmail?: Email | null;
	/** When editing a draft, this holds the draft email to pre-fill the composer */
	draftEmail?: Email | null;
	/** Mail App: who a new email is to, for "Write email" on the Contacts page. */
	to?: string;
	/** Mail App: the rest of a mailto: link (clicking an email link on a website when Mail App is your mail app). */
	cc?: string;
	subject?: string;
	text?: string;
	/** Mail App: files to attach, for "Send by email" on the Files page. */
	files?: File[];
}

interface UIState {
	// Side panel state
	selectedEmailId: string | null;
	isComposing: boolean;
	_previousEmailId: string | null;
	selectEmail: (id: string | null) => void;
	startCompose: (options?: ComposeOptions) => void;
	closePanel: () => void;
	closeCompose: () => void;
	/** Mail App: close the composer after sending. */
	finishCompose: () => void;
	composeSize: ComposeSize;
	setComposeSize: (size: ComposeSize) => void;
	/** Mail App: goes up with each new email, so the composer starts fresh. */
	composeKey: number;

	// Compose options
	composeOptions: ComposeOptions;

	// Mobile sidebar
	isSidebarOpen: boolean;
	openSidebar: () => void;
	closeSidebar: () => void;
	toggleSidebar: () => void;

	// Agent panel
	isAgentPanelOpen: boolean;
	toggleAgentPanel: () => void;

	// Legacy dialog support (kept for non-split views)
	isComposeModalOpen: boolean;
	openComposeModal: (options?: ComposeOptions) => void;
	closeComposeModal: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
	selectedEmailId: null,
	isComposing: false,
	_previousEmailId: null,
	composeOptions: { mode: "new", originalEmail: null },
	isComposeModalOpen: false,
	isSidebarOpen: false,
	isAgentPanelOpen: true,
	composeSize: "normal",
	composeKey: 0,

	// On wider screens the floating composer stays open while you read other emails.
	selectEmail: (id) => set(isWide() ? { selectedEmailId: id } : { selectedEmailId: id, isComposing: false }),

	setComposeSize: (composeSize) => set({ composeSize }),

	startCompose: (options) =>
		set((state) => {
			const mode = options?.mode || "new";
			const isReplyOrForward = mode === "reply" || mode === "reply-all" || mode === "forward";
			if (isWide()) {
				return {
					isComposing: true,
					composeOptions: options || { mode: "new", originalEmail: null },
					composeSize: "normal" as const,
					composeKey: state.composeKey + 1,
					isSidebarOpen: false,
				};
			}
			return {
				isComposing: true,
				composeKey: state.composeKey + 1,
				_previousEmailId: state.selectedEmailId,
				// Keep selectedEmailId when replying/forwarding so the thread stays visible
				selectedEmailId: isReplyOrForward ? state.selectedEmailId : null,
				composeOptions: options || { mode: "new", originalEmail: null },
				isSidebarOpen: false,
			};
		}),

	// Closes the email that's open. On wider screens an email being written stays open in its box.
	closePanel: () =>
		set((state) =>
			isWide() && state.isComposing
				? { selectedEmailId: null, _previousEmailId: null }
				: { selectedEmailId: null, isComposing: false, _previousEmailId: null, composeOptions: { mode: "new" as const, originalEmail: null } },
		),

	closeCompose: () =>
		set((state) =>
			isWide()
				? { isComposing: false, composeSize: "normal" as const, composeOptions: { mode: "new" as const, originalEmail: null } }
				: {
						isComposing: false,
						selectedEmailId: state._previousEmailId,
						_previousEmailId: null,
						composeOptions: { mode: "new" as const, originalEmail: null },
					},
		),

	finishCompose: () =>
		set(
			isWide()
				? { isComposing: false, composeSize: "normal" as const, composeOptions: { mode: "new" as const, originalEmail: null } }
				: { selectedEmailId: null, isComposing: false, _previousEmailId: null, composeOptions: { mode: "new" as const, originalEmail: null } },
		),

	openSidebar: () => set({ isSidebarOpen: true }),
	closeSidebar: () => set({ isSidebarOpen: false }),
	toggleSidebar: () => set({ isSidebarOpen: !get().isSidebarOpen }),

	toggleAgentPanel: () => set({ isAgentPanelOpen: !get().isAgentPanelOpen }),

	openComposeModal: (options) =>
		set({
			composeOptions: options || { mode: "new", originalEmail: null },
			isComposeModalOpen: true,
		}),

	closeComposeModal: () =>
		set({
			isComposeModalOpen: false,
			composeOptions: { mode: "new", originalEmail: null },
		}),
}));
