// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: the AI agent panel and its button only show when AI is switched on; the
// floating composer lives here so it stays open while you move around the mailbox; on wider screens the sidebar
// can be folded down to a strip of icons; the unread badge on the app icon, and opening a new email or an email
// from a link or notification; calendar reminders while the app is open; Mail, Calendar and Contacts each have
// their own screen, with a switcher down the left (or along the bottom on phones).

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useLocation, useParams, useSearchParams } from "react-router";
import { AppStrip, AppTabBar, areaOf } from "~/components/AppSwitcher";
import AgentSidebar from "~/components/AgentSidebar";
import ComposeDock from "~/components/ComposeDock";
import ComposeEmail from "~/components/ComposeEmail";
import Header from "~/components/Header";
import Sidebar, { SidebarRail } from "~/components/Sidebar";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";
import { useRemembered } from "~/hooks/useRemembered";
import { isAiEnabled } from "shared/ai";
import { parseMailto } from "shared/mailto";
import { Folders } from "shared/folders";
import { useFolders } from "~/queries/folders";
import { useUpdateEmail } from "~/queries/emails";
import { LAST_MAILBOX_KEY, useAppBadge, useNewMailSignal } from "~/lib/app-mode";
import { queryKeys } from "~/queries/keys";
import { useCalendarReminders } from "~/hooks/useCalendarReminders";

export default function MailboxRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	// Prefetch mailbox data for child components
	const { data: mailbox } = useMailbox(mailboxId);
	const aiOn = isAiEnabled(mailbox?.settings);
	const prevMailboxIdRef = useRef<string | undefined>(undefined);
	const {
		isSidebarOpen,
		closeSidebar,
		isAgentPanelOpen,
		closePanel,
		closeCompose,
		closeComposeModal,
	} = useUIStore();
	const [collapsed, setCollapsed] = useRemembered("mailapp.sidebar.collapsed", false);
	// Mail App: Calendar and Contacts have their own screens, without the mail folders and search.
	const isMail = areaOf(useLocation().pathname) === "mail";
	// Mail App: checked every 30 seconds and when the window comes forward, so the app's icon stays right.
	const { data: folders, dataUpdatedAt: foldersCheckedAt } = useFolders(mailboxId, { refetchInterval: 30_000, refetchOnWindowFocus: true });
	const [searchParams, setSearchParams] = useSearchParams();
	const { startCompose, selectEmail } = useUIStore();

	// Mail App: the unread count on the app's Dock or home-screen icon.
	useCalendarReminders(mailboxId);
	useAppBadge(folders?.find((f) => f.id === Folders.INBOX)?.unreadCount, foldersCheckedAt);
	const updateEmail = useUpdateEmail();
	// Mail App: new mail shows in an open window as soon as its notification arrives.
	const queryClient = useQueryClient();
	useNewMailSignal(useCallback(() => {
		if (!mailboxId) return;
		queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
		queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
	}, [mailboxId, queryClient]));

	// Mail App: remembered so "New email" and email links on websites open the mailbox you last used.
	useEffect(() => {
		if (mailboxId) try { localStorage.setItem(LAST_MAILBOX_KEY, mailboxId); } catch { /* private window */ }
	}, [mailboxId]);

	useEffect(() => {
		if (
			prevMailboxIdRef.current &&
			mailboxId &&
			prevMailboxIdRef.current !== mailboxId
		) {
			closePanel();
			closeCompose();
			closeComposeModal();
			closeSidebar();
		}

		prevMailboxIdRef.current = mailboxId;
	}, [mailboxId, closeComposeModal, closePanel, closeCompose, closeSidebar]);

	// Mail App: ?compose= (from an email link or the app's "New email" shortcut) and ?open= (from a notification or
	// All inboxes). It comes after the switch-mailbox reset above, so arriving from another mailbox keeps it open.
	useEffect(() => {
		const compose = searchParams.get("compose");
		const open = searchParams.get("open");
		if (compose === null && open === null) return;
		if (open) {
			selectEmail(open);
			// Opening an email from its notification counts as reading it, as clicking it in the list does.
			if (mailboxId) updateEmail.mutate({ mailboxId, id: open, data: { read: true } });
		}
		if (compose !== null) {
			const m = parseMailto(compose);
			startCompose({ mode: "new", to: m.to || undefined, cc: m.cc || undefined, subject: m.subject || undefined, text: m.body || undefined });
		}
		setSearchParams((p) => { p.delete("compose"); p.delete("open"); return p; }, { replace: true });
	}, [searchParams, setSearchParams, startCompose, selectEmail, mailboxId, updateEmail.mutate]);

	return (
		<div className="flex h-screen overflow-hidden">
			<AppStrip />
			{/* Mobile sidebar overlay backdrop */}
			{isMail && isSidebarOpen && (
				<div
					className="fixed inset-0 z-30 bg-black/30 md:hidden"
					onClick={closeSidebar}
					onKeyDown={(e) => e.key === "Escape" && closeSidebar()}
					role="button"
					tabIndex={-1}
					aria-label="Close sidebar"
				/>
			)}

			{/* Sidebar: hidden on mobile by default, shown as overlay when open */}
			<div
				className={`fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 md:z-0 ${
					isSidebarOpen ? "translate-x-0" : "-translate-x-full"
				} ${collapsed ? "md:hidden" : ""} ${isMail ? "" : "hidden"}`}
			>
				<Sidebar onCollapse={() => setCollapsed(true)} />
			</div>
			{/* Mail App: the folded-away sidebar on wider screens */}
			{isMail && collapsed && (
				<div className="hidden md:flex">
					<SidebarRail onExpand={() => setCollapsed(false)} />
				</div>
			)}

			{/* Main content */}
			<div className="flex-1 flex flex-col min-w-0 bg-kumo-base">
				{isMail && <Header />}
				<main className="flex-1 overflow-hidden">
					<Outlet />
				</main>
				<AppTabBar />
			</div>

			{/* Agent + MCP sidebar -- togglable on desktop */}
			{aiOn && isAgentPanelOpen && (
				<div className="hidden lg:flex w-[380px] shrink-0 border-l border-kumo-line flex-col bg-kumo-base overflow-hidden">
					<AgentSidebar />
				</div>
			)}

			<ComposeEmail />
			{/* Mail App: the email being written, in a floating box on wider screens */}
			<ComposeDock />
		</div>
	);
}
