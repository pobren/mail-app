// Mail App addition (not part of upstream Agentic Inbox).
// An address box that suggests contacts as you type. Addresses stay comma-separated text, as before.
import { Input } from "@cloudflare/kumo";
import { type KeyboardEvent, useMemo, useState } from "react";
import ContactAvatar from "~/components/ContactAvatar";
import { completeRecipient, matchContacts, splitAddresses, typedRecipient, type Contact } from "shared/contacts";

interface Props {
	value: string;
	onChange: (value: string) => void;
	contacts: Contact[];
	photos: boolean;
	placeholder?: string;
	required?: boolean;
	label: string;
}

export default function RecipientInput({ value, onChange, contacts, photos, placeholder, required, label }: Props) {
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const suggestions = useMemo(
		() => (open ? matchContacts(contacts, typedRecipient(value), splitAddresses(value)) : []),
		[open, contacts, value],
	);

	const choose = (c: Contact) => {
		onChange(completeRecipient(value, c.email));
		setActive(0);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (!suggestions.length) return;
		if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % suggestions.length); }
		else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + suggestions.length) % suggestions.length); }
		else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(suggestions[Math.min(active, suggestions.length - 1)]); }
		else if (e.key === "Escape") setOpen(false);
	};

	return (
		<div className="relative flex-1 min-w-0">
			<Input
				type="text"
				size="sm"
				className="w-full"
				aria-label={label}
				placeholder={placeholder}
				value={value}
				required={required}
				autoComplete="off"
				onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(0); }}
				onKeyDown={onKeyDown}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
				role="combobox"
				aria-expanded={suggestions.length > 0}
				aria-autocomplete="list"
			/>
			{suggestions.length > 0 && (
				<ul role="listbox" className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-kumo-line bg-kumo-base py-1 shadow-lg">
					{suggestions.map((c, i) => (
						<li
							key={c.email}
							role="option"
							aria-selected={i === active}
							// mousedown, not click, so the box keeps focus and the list doesn't close first
							onMouseDown={(e) => { e.preventDefault(); choose(c); }}
							onMouseEnter={() => setActive(i)}
							className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${i === active ? "bg-kumo-tint" : ""}`}
						>
							<ContactAvatar email={c.email} name={c.name} photos={photos} size={24} />
							<span className="min-w-0 truncate">
								{c.name ? <><span className="text-kumo-default">{c.name}</span> <span className="text-kumo-subtle">{c.email}</span></> : <span className="text-kumo-default">{c.email}</span>}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
