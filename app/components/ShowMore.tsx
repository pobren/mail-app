// Mail App: keeps long lists short. A list shows its first few items with a "Show all 12" button
// under it, and a long one gets a "Find…" box above it. Used for domains, mailboxes, people,
// addresses and the lists in Settings, so a big install stays easy to read.

import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { fill } from "~/lib/attachments";
import copy from "~/copy/lists.en-GB.json";

/** How many items a list shows before "Show all". */
export const SHORT_LIST = 5;
/** From this many items, a list gets a "Find…" box. */
export const FIND_FROM = 10;

/**
 * The items to draw, folded to the first `limit` unless opened, and filtered by the "Find…" text.
 * `text` gives the words each item can be found by.
 */
export function useShowMore<T>(items: T[], { limit = SHORT_LIST, text }: { limit?: number; text?: (item: T) => string } = {}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const q = query.trim().toLowerCase();
	const canFind = !!text && items.length >= FIND_FROM;
	const matched = canFind && q ? items.filter((item) => text(item).toLowerCase().includes(q)) : items;
	// While finding, every match shows: the point is to see what you typed for.
	const folded = !open && !q && matched.length > limit + 1;
	return {
		shown: folded ? matched.slice(0, limit) : matched,
		total: matched.length,
		folded,
		open,
		canFold: !q && matched.length > limit + 1,
		toggle: () => setOpen((o) => !o),
		canFind,
		query,
		setQuery,
		noMatch: canFind && !!q && matched.length === 0,
	};
}

type ShowMoreState = ReturnType<typeof useShowMore<unknown>>;

/**
 * The "Show all 12" / "Show fewer" button under a list. Draws nothing for a short list.
 * `showAll` changes the words, such as "Show all {count} mailboxes" where lists sit together.
 */
export function ShowMoreButton({ list, showAll = copy.showAll, className = "" }: { list: ShowMoreState; showAll?: string; className?: string }) {
	if (!list.canFold) return null;
	return (
		<button
			type="button"
			onClick={list.toggle}
			aria-expanded={list.open}
			className={`text-sm font-medium text-kumo-link hover:underline ${className}`}
		>
			{list.open ? copy.showFewer : fill(showAll, { count: String(list.total) })}
		</button>
	);
}

/** The "Find…" box above a long list. Draws nothing until the list is long. */
export function FindBox({ list, label, className = "" }: { list: ShowMoreState; label?: string; className?: string }) {
	if (!list.canFind) return null;
	return (
		<div className={className}>
			<label className="relative block">
				<span className="sr-only">{label ?? copy.find}</span>
				<MagnifyingGlassIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-kumo-subtle" />
				<input
					type="search"
					value={list.query}
					onChange={(e) => list.setQuery(e.target.value)}
					placeholder={label ?? copy.find}
					className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base pl-8 pr-2.5 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring"
				/>
			</label>
			{list.noMatch && <p className="mt-2 text-xs text-kumo-subtle">{fill(copy.noMatch, { text: list.query.trim() })}</p>}
		</div>
	);
}

/** "a, b, c and 4 more" for a line of names that could run on and on. */
export function shortList(items: string[], limit = 3): string {
	if (items.length <= limit + 1) return items.join(", ");
	return fill(copy.andMore, { list: items.slice(0, limit).join(", "), count: String(items.length - limit) });
}
