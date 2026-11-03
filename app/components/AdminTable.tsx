// Mail App addition (not part of upstream Agentic Inbox).
// The pieces the admin pages' tables share: a titled section with its card, column headings, rows that
// become cards on a phone, an empty message and a row's ⋮ menu.
import { Button, DropdownMenu } from "@cloudflare/kumo";
import { DotsThreeVerticalIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export function Section({ title, intro, action, children }: { title: string; intro: string; action: ReactNode; children: ReactNode }) {
	return (
		<section className="mb-8">
			<div className="mb-3 flex flex-wrap items-end justify-between gap-3">
				<div className="min-w-0 max-w-2xl">
					<h2 className="text-xl font-bold text-kumo-default">{title}</h2>
					<p className="mt-1 text-base text-kumo-subtle">{intro}</p>
				</div>
				{action}
			</div>
			<div className="rounded-2xl border border-kumo-line bg-kumo-base shadow-sm">{children}</div>
		</section>
	);
}

export function Headings({ columns, labels }: { columns: string; labels: string[] }) {
	return (
		<div className={`hidden md:grid ${columns} items-center gap-4 rounded-t-2xl border-b border-kumo-line bg-kumo-recessed px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle`}>
			{labels.map((l) => <span key={l}>{l}</span>)}
			<span />
		</div>
	);
}

export function Row({ columns, first, children }: { columns: string; first: boolean; children: ReactNode }) {
	return (
		<div className={`grid grid-cols-[minmax(0,1fr)_auto] ${columns} items-center gap-x-4 gap-y-2 px-4 py-4 sm:px-5 ${first ? "" : "border-t border-kumo-line"}`}>
			{children}
		</div>
	);
}

/** The columns after the first: one wrapped line on a phone, columns on a computer. */
export function Details({ children }: { children: ReactNode }) {
	return <div className="col-span-2 flex flex-wrap items-center gap-2 md:contents">{children}</div>;
}

export function Empty({ icon, title, text }: { icon: ReactNode; title?: string; text: string }) {
	return (
		<div className="flex flex-col items-center px-6 py-10 text-center">
			<div className="mb-3 text-kumo-subtle">{icon}</div>
			{title && <p className="mb-1 text-base font-semibold text-kumo-default">{title}</p>}
			<p className="max-w-md text-base text-kumo-subtle">{text}</p>
		</div>
	);
}

export function Menu({ label, items }: { label: string; items: { label: string; onClick: () => void; danger?: boolean }[] }) {
	return (
		<DropdownMenu>
			<DropdownMenu.Trigger>
				<Button variant="secondary" size="sm" shape="square" aria-label={label} icon={<DotsThreeVerticalIcon size={18} weight="bold" />} />
			</DropdownMenu.Trigger>
			<DropdownMenu.Content>
				{items.map((item) => (
					<DropdownMenu.Item key={item.label} onClick={item.onClick}>
						<span className={item.danger ? "text-kumo-danger" : ""}>{item.label}</span>
					</DropdownMenu.Item>
				))}
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}
