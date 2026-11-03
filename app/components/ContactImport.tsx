// Mail App addition (not part of upstream Agentic Inbox).
// Contact import on the Contacts page: choose a .vcf or .csv file, check who's new, then add them.
import { Button, Text, useKumoToastManager } from "@cloudflare/kumo";
import { FileArrowUpIcon, XIcon } from "@phosphor-icons/react";
import { type ChangeEvent, useRef, useState } from "react";
import copy from "~/copy/contacts.en-GB.json";
import { useImportContacts } from "~/queries/contacts";
import { parseContactsFile, planImport, type Contact, type ImportPlan } from "shared/contacts";

const MAX_BYTES = 10 * 1024 * 1024;
/** How many new people the preview lists before saying "and N more". */
const SHOWN = 50;

const count = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("{count}", n.toLocaleString("en-GB")));

/** Outlook on Windows can save CSV files as UTF-16; everything else is UTF-8. */
async function readText(file: File): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
	return new TextDecoder(encoding).decode(bytes);
}

export default function ContactImport({ mailboxId, contacts, onClose }: { mailboxId: string; contacts: Contact[]; onClose: () => void }) {
	const importContacts = useImportContacts(mailboxId);
	const toastManager = useKumoToastManager();
	const input = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<string | null>(null);
	const [plan, setPlan] = useState<ImportPlan | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [reading, setReading] = useState(false);

	const choose = async (e: ChangeEvent<HTMLInputElement>) => {
		const f = e.target.files?.[0];
		e.target.value = "";
		if (!f) return;
		setPlan(null);
		setError(null);
		if (f.size > MAX_BYTES) { setError(copy.importTooBig); return; }
		setReading(true);
		try {
			const found = parseContactsFile(await readText(f), f.name);
			if (!found.length) { setError(copy.importNone); return; }
			setFile(f.name);
			// Your own address never goes in your contacts.
			setPlan(planImport(found, [...contacts, { email: mailboxId }]));
		} catch {
			setError(copy.importUnreadable);
		} finally {
			setReading(false);
		}
	};

	const add = () => {
		if (!plan?.add.length) return;
		importContacts.mutate(plan.add, {
			onSuccess: (added) => {
				toastManager.add({ title: count(added, copy.importDoneOne, copy.importDone) });
				onClose();
			},
			onError: () => toastManager.add({ title: copy.importFailed, variant: "error" }),
		});
	};

	const total = plan ? plan.add.length + plan.already.length : 0;

	return (
		<div className="space-y-3 rounded-lg border border-kumo-line bg-kumo-base p-4">
			<div className="flex items-start justify-between gap-3">
				<h2 className="text-base font-semibold text-kumo-default">{copy.importTitle}</h2>
				<Button variant="ghost" size="xs" icon={<XIcon size={14} />} onClick={onClose} aria-label={copy.cancel} />
			</div>
			<input ref={input} type="file" accept=".vcf,.vcard,.csv,text/vcard,text/x-vcard,text/csv" className="hidden" onChange={choose} />

			{!plan && (
				<>
					<p className="text-sm text-kumo-subtle">{copy.importIntro}</p>
					<div className="flex flex-wrap items-center gap-3">
						<Button variant="primary" size="sm" icon={<FileArrowUpIcon size={14} />} loading={reading} onClick={() => input.current?.click()}>
							{reading ? copy.importReading : copy.importChoose}
						</Button>
						<span className="text-xs text-kumo-subtle">{copy.importTypes}</span>
					</div>
					{error && <Text variant="error" size="sm">{error}</Text>}
					<details className="rounded-lg bg-kumo-recessed px-3 py-2 text-sm text-kumo-default">
						<summary className="cursor-pointer font-medium">{copy.importHelp}</summary>
						<ul className="mt-2 space-y-2 text-kumo-subtle">
							{[copy.importHelpGmail, copy.importHelpIphone, copy.importHelpOutlook].map((step) => {
								// "Gmail: on a computer…" shows the name before the colon in bold.
								const [where, ...rest] = step.split(": ");
								return <li key={where}><span className="font-medium text-kumo-default">{where}:</span> {rest.join(": ")}</li>;
							})}
						</ul>
					</details>
				</>
			)}

			{plan && (
				<>
					<p className="text-sm text-kumo-default">
						{(total === 1 ? copy.importFoundOne : copy.importFound.replace("{count}", total.toLocaleString("en-GB"))).replace("{file}", file ?? "")}
						{plan.already.length > 0 && plan.add.length > 0 && ` ${count(plan.already.length, copy.importAlreadyOne, copy.importAlreadyCount)}`}
					</p>
					{plan.add.length === 0 ? (
						<p className="text-sm text-kumo-subtle">{copy.importNothingNew}</p>
					) : (
						<div>
							<div className="mb-1 text-xs font-medium uppercase tracking-wide text-kumo-subtle">{copy.importNew}</div>
							<ul className="max-h-72 divide-y divide-kumo-line overflow-y-auto rounded-lg border border-kumo-line">
								{plan.add.slice(0, SHOWN).map((c) => (
									<li key={c.email} className="px-3 py-2">
										<div className="truncate text-sm text-kumo-default">{c.name || c.email}</div>
										{c.name && <div className="truncate text-xs text-kumo-subtle">{c.email}</div>}
									</li>
								))}
								{plan.add.length > SHOWN && (
									<li className="px-3 py-2 text-sm text-kumo-subtle">{copy.importMore.replace("{count}", (plan.add.length - SHOWN).toLocaleString("en-GB"))}</li>
								)}
							</ul>
						</div>
					)}
					<div className="flex flex-wrap justify-end gap-2">
						<Button variant="ghost" size="sm" onClick={() => input.current?.click()}>{copy.importAnother}</Button>
						{plan.add.length > 0 && (
							<Button variant="primary" size="sm" loading={importContacts.isPending} onClick={add}>
								{count(plan.add.length, copy.importAddOne, copy.importAddMany)}
							</Button>
						)}
					</div>
				</>
			)}
		</div>
	);
}
