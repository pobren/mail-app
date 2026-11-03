// Mail App addition (not part of upstream Agentic Inbox).
// The admin area's frame: a menu down the side (Mailboxes, Domains, Routing, Spam filter, Users, Company details, Branding, Backups, Reports, API & webhooks, in groups) on a computer,
// and a row of tabs under the logo on a phone. People who aren't admins get the same page without
// the menu. Also the small pieces the admin pages share: coloured initials, pills and page headings.
// Wording lives in app/copy/admin.en-GB.json.

import { ArrowsSplitIcon, BuildingOfficeIcon, ChartBarIcon, CodeIcon, DatabaseIcon, EnvelopeSimpleIcon, GlobeIcon, PaletteIcon, ShieldCheckIcon, UsersThreeIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { NavLink } from "react-router";
import Logo, { HelpLinks, UpdateNotice } from "~/components/Logo";
import copy from "~/copy/admin.en-GB.json";

const GROUPS: { label: string; items: { to: string; label: string; icon: typeof GlobeIcon; soon?: boolean }[] }[] = [
	{
		label: copy.groups.email,
		items: [
			{ to: "/", label: copy.nav.mailboxes, icon: EnvelopeSimpleIcon },
			{ to: "/domains", label: copy.nav.domains, icon: GlobeIcon },
			{ to: "/routing", label: copy.nav.routing, icon: ArrowsSplitIcon },
			{ to: "/spam-filter", label: copy.nav.spamFilter, icon: ShieldCheckIcon },
		],
	},
	{
		label: copy.groups.admin,
		items: [
			{ to: "/users", label: copy.nav.users, icon: UsersThreeIcon },
			{ to: "/company", label: copy.nav.company, icon: BuildingOfficeIcon },
			{ to: "/branding", label: copy.nav.branding, icon: PaletteIcon },
			{ to: "/backups", label: copy.nav.backups, icon: DatabaseIcon },
			{ to: "/reports", label: copy.nav.reports, icon: ChartBarIcon },
		],
	},
	{
		label: copy.groups.developers,
		items: [{ to: "/developer", label: copy.nav.developer, icon: CodeIcon }],
	},
];

export default function AdminShell({ isAdmin, children }: { isAdmin: boolean; children: ReactNode }) {
	if (!isAdmin) {
		return (
			<div className="min-h-screen bg-kumo-recessed">
				<div className="mx-auto max-w-3xl px-4 py-8 md:px-6 md:py-14">
					<div className="mb-8"><Logo size={28} /></div>
					<UpdateNotice className="mb-6" />
					{children}
					<HelpLinks className="mt-10 text-center" />
				</div>
			</div>
		);
	}
	return (
		<div className="min-h-screen bg-kumo-recessed md:flex">
			{/* Computer: the menu down the side */}
			<aside className="hidden md:flex md:sticky md:top-0 md:h-screen w-60 shrink-0 flex-col border-r border-kumo-line bg-kumo-base">
				<div className="flex items-center gap-2 px-5 pt-6 pb-5">
					<Logo size={26} />
					<span className="rounded-md bg-kumo-tint px-1.5 py-0.5 text-xs font-semibold text-kumo-subtle">{copy.title}</span>
				</div>
				<nav aria-label={copy.menu} className="flex-1 overflow-y-auto px-3">
					{GROUPS.map((g) => (
						<div key={g.label} className="mb-5">
							<div className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">{g.label}</div>
							{g.items.map((item) => (
								<NavLink
									key={item.to}
									to={item.to}
									end
									className={({ isActive }) => `mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-[15px] no-underline transition-colors ${
										isActive ? "bg-[rgba(var(--brand-rgb),0.1)] font-semibold text-[var(--brand-ink)]" : "text-kumo-default hover:bg-kumo-tint"
									}`}
								>
									{({ isActive }) => (<>
										<item.icon size={19} weight={isActive ? "fill" : "regular"} />
										<span className="flex-1">{item.label}</span>
										{item.soon && <span className="rounded-full bg-kumo-tint px-2 py-0.5 text-[11px] font-semibold text-kumo-subtle">{copy.soon}</span>}
									</>)}
								</NavLink>
							))}
						</div>
					))}
				</nav>
				<HelpLinks className="border-t border-kumo-line px-5 py-4 leading-relaxed" />
			</aside>

			{/* Phone: the logo, then the sections as tabs */}
			<div className="md:hidden border-b border-kumo-line bg-kumo-base">
				<div className="flex items-center gap-2 px-4 pt-5 pb-3">
					<Logo size={24} />
					<span className="rounded-md bg-kumo-tint px-1.5 py-0.5 text-xs font-semibold text-kumo-subtle">{copy.title}</span>
				</div>
				<nav aria-label={copy.menu} className="flex gap-1 overflow-x-auto px-3 pb-3">
					{GROUPS.flatMap((g) => g.items).map((item) => (
						<NavLink
							key={item.to}
							to={item.to}
							end
							className={({ isActive }) => `flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm no-underline ${
								isActive ? "bg-[rgba(var(--brand-rgb),0.1)] font-semibold text-[var(--brand-ink)]" : "text-kumo-default bg-kumo-tint"
							}`}
						>
							<item.icon size={16} />
							{item.label}
						</NavLink>
					))}
				</nav>
			</div>

			<main className="min-w-0 flex-1">
				<div className="mx-auto max-w-5xl px-4 py-6 md:px-10 md:py-10">
					<UpdateNotice className="mb-6" />
					{children}
					<HelpLinks className="mt-10 text-center md:hidden" />
				</div>
			</main>
		</div>
	);
}

/** A page's big heading, the line under it, and its main button on the right. */
export function PageHeading({ title, intro, action }: { title: string; intro?: ReactNode; action?: ReactNode }) {
	return (
		<div className="mb-6 flex flex-wrap items-start justify-between gap-4">
			<div className="min-w-0">
				<h1 className="text-3xl font-bold tracking-tight text-kumo-default">{title}</h1>
				{intro && <p className="mt-1.5 text-base text-kumo-subtle">{intro}</p>}
			</div>
			{action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
		</div>
	);
}

const TONES = {
	blue: "bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
	violet: "bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
	green: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
	amber: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
	red: "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200",
	grey: "bg-kumo-tint text-kumo-default",
} as const;
export type Tone = keyof typeof TONES;

const DOTS: Record<Tone, string> = {
	blue: "bg-sky-500", violet: "bg-violet-500", green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-red-500", grey: "bg-kumo-subtle",
};

/** A rounded tag such as "Shared" or "Active", with an icon or a coloured dot in front. */
export function Pill({ tone = "grey", icon, dot, title, children }: { tone?: Tone; icon?: ReactNode; dot?: boolean; title?: string; children: ReactNode }) {
	return (
		<span title={title} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-sm font-medium ${TONES[tone]}`}>
			{dot && <span className={`size-2 rounded-full ${DOTS[tone]}`} />}
			{icon}
			{children}
		</span>
	);
}

const INITIAL_COLOURS = [
	"bg-sky-100 text-sky-800",
	"bg-violet-100 text-violet-800",
	"bg-amber-100 text-amber-800",
	"bg-emerald-100 text-emerald-800",
	"bg-rose-100 text-rose-800",
	"bg-teal-100 text-teal-800",
	"bg-orange-100 text-orange-800",
	"bg-indigo-100 text-indigo-800",
];

/** A round initial in a soft colour that stays the same for the same name. */
export function Initial({ name, size = 40 }: { name: string; size?: number }) {
	let hash = 0;
	for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
	return (
		<span
			aria-hidden="true"
			style={{ width: size, height: size, fontSize: size * 0.42 }}
			className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${INITIAL_COLOURS[hash % INITIAL_COLOURS.length]}`}
		>
			{(name.trim().charAt(0) || "?").toUpperCase()}
		</span>
	);
}

/** A mailbox's display name: its own name, its one user's name, or a tidied first part ("Support"). */
export function mailboxTitle(m: { email: string; name?: string; shared?: boolean; people?: { name: string }[] }): string {
	if (m.name && m.name.toLowerCase() !== m.email.toLowerCase()) return m.name;
	if (!m.shared && m.people?.length === 1) return m.people[0].name;
	const local = m.email.split("@")[0] ?? m.email;
	return local.charAt(0).toUpperCase() + local.slice(1).replace(/[._-]+/g, " ");
}
