// Mail App addition (not part of upstream Agentic Inbox).
// Switches between Mail, Calendar, Contacts, Files and Notes, like Gmail and Outlook: a narrow strip down the left
// on wider screens, and a bar along the bottom on phones. Each has its own screen.

import { Tooltip } from "@cloudflare/kumo";
import { AddressBookIcon, CalendarBlankIcon, EnvelopeSimpleIcon, FolderSimpleIcon, GearSixIcon, NotePencilIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { NavLink, useLocation, useParams } from "react-router";
import { Folders } from "shared/folders";
import { useFolders } from "~/queries/folders";

export type AppArea = "mail" | "calendar" | "contacts" | "files" | "notes";

/** Which of the five a page belongs to. Settings and search count as Mail. */
export function areaOf(pathname: string): AppArea {
	if (/\/mailbox\/[^/]+\/calendar(\/|$)/.test(pathname)) return "calendar";
	if (/\/mailbox\/[^/]+\/contacts(\/|$)/.test(pathname)) return "contacts";
	if (/\/mailbox\/[^/]+\/files(\/|$)/.test(pathname)) return "files";
	if (/\/mailbox\/[^/]+\/notes(\/|$)/.test(pathname)) return "notes";
	return "mail";
}

interface Item { area: AppArea; label: string; to: string; icon: (active: boolean) => ReactNode }

function useItems(): Item[] {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const base = `/mailbox/${mailboxId}`;
	return [
		{ area: "mail", label: "Mail", to: `${base}/emails/inbox`, icon: (on) => <EnvelopeSimpleIcon size={22} weight={on ? "fill" : "regular"} /> },
		{ area: "calendar", label: "Calendar", to: `${base}/calendar`, icon: (on) => <CalendarBlankIcon size={22} weight={on ? "fill" : "regular"} /> },
		{ area: "contacts", label: "Contacts", to: `${base}/contacts`, icon: (on) => <AddressBookIcon size={22} weight={on ? "fill" : "regular"} /> },
		{ area: "files", label: "Files", to: `${base}/files`, icon: (on) => <FolderSimpleIcon size={22} weight={on ? "fill" : "regular"} /> },
		{ area: "notes", label: "Notes", to: `${base}/notes`, icon: (on) => <NotePencilIcon size={22} weight={on ? "fill" : "regular"} /> },
	];
}

function useInboxUnread(): number {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: folders = [] } = useFolders(mailboxId);
	return folders.find((f) => f.id === Folders.INBOX)?.unreadCount || 0;
}

/** The strip down the left on wider screens. */
export function AppStrip() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const area = areaOf(useLocation().pathname);
	const unread = useInboxUnread();
	return (
		<nav aria-label="Switch between Mail, Calendar, Contacts, Files and Notes" className="hidden h-full w-[4.5rem] shrink-0 flex-col items-center gap-1 border-r border-kumo-line bg-kumo-recessed py-3 md:flex">
			{useItems().map((item) => {
				const on = item.area === area;
				return (
					<NavLink key={item.area} to={item.to} aria-current={on ? "page" : undefined}
						className={`group relative flex w-16 flex-col items-center gap-0.5 rounded-lg py-1.5 text-xs font-medium no-underline ${on ? "text-kumo-default" : "text-kumo-strong hover:text-kumo-default"}`}>
						<span className={`flex h-8 w-12 items-center justify-center rounded-full transition-colors ${on ? "bg-kumo-fill" : "group-hover:bg-kumo-tint"}`}>
							{item.icon(on)}
						</span>
						{item.label}
						{item.area === "mail" && unread > 0 && !on && <span className="absolute right-2.5 top-1 size-2.5 rounded-full bg-kumo-brand" aria-label={`${unread} unread`} />}
					</NavLink>
				);
			})}
			<div className="mt-auto">
				<Tooltip content="Settings" side="right" asChild>
					<NavLink to={`/mailbox/${mailboxId}/settings`} aria-label="Settings"
						className={({ isActive }) => `flex size-10 items-center justify-center rounded-full ${isActive ? "bg-kumo-fill text-kumo-default" : "text-kumo-strong hover:bg-kumo-tint"}`}>
						<GearSixIcon size={20} />
					</NavLink>
				</Tooltip>
			</div>
		</nav>
	);
}

/** The bar along the bottom on phones. */
export function AppTabBar() {
	const area = areaOf(useLocation().pathname);
	const unread = useInboxUnread();
	return (
		<nav aria-label="Switch between Mail, Calendar, Contacts, Files and Notes"
			className="flex shrink-0 border-t border-kumo-line bg-kumo-base pb-[env(safe-area-inset-bottom)] md:hidden">
			{useItems().map((item) => {
				const on = item.area === area;
				return (
					<NavLink key={item.area} to={item.to} aria-current={on ? "page" : undefined}
						className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 text-xs font-medium no-underline ${on ? "text-[var(--color-kumo-brand)]" : "text-kumo-strong"}`}>
						{item.icon(on)}
						{item.label}
						{item.area === "mail" && unread > 0 && (
							<span className="absolute left-1/2 top-1 ml-2 min-w-4 rounded-full bg-kumo-brand px-1 text-[10px] leading-4 text-white">{unread > 99 ? "99+" : unread}</span>
						)}
					</NavLink>
				);
			})}
		</nav>
	);
}
