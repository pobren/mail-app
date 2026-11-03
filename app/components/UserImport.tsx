// Mail App addition (not part of upstream Agentic Inbox).
// Import users on the Users page: download the template, choose a filled-in CSV, see every row
// checked (with what's wrong with any that can't be added), then add everyone who's ready at once.
// Wording lives in app/copy/people.en-GB.json ("import").
import { Button, Dialog, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, DownloadSimpleIcon, FileArrowUpIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { type ChangeEvent, useMemo, useRef, useState } from "react";
import { FindBox, useShowMore } from "~/components/ShowMore";
import copy from "~/copy/people.en-GB.json";
import { fill } from "~/lib/attachments";
import api, { type ImportResult, type PeoplePage, type SignInState } from "~/services/api";
import type { PeopleBook } from "shared/people";
import { MAX_IMPORT_ROWS, USER_TEMPLATE_CSV, parseUsersCsv, planUserImport, type PlannedUser, type UserRow } from "shared/user-import";

const MAX_BYTES = 1024 * 1024;
const t = copy.import;

/** Outlook on Windows can save CSV files as UTF-16; everything else is UTF-8. */
async function readText(file: File): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
	return new TextDecoder(encoding).decode(bytes);
}

function downloadTemplate(domain: string | undefined) {
	const text = domain ? USER_TEMPLATE_CSV.replaceAll("@example.com", `@${domain}`) : USER_TEMPLATE_CSV;
	const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = "mail-app-users.csv";
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function UserImport({ page, domains, onClose, onDone }: {
	page: PeoplePage;
	domains: string[];
	onClose: () => void;
	onDone: (state: SignInState) => Promise<void>;
}) {
	const input = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<string | null>(null);
	const [rows, setRows] = useState<UserRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [sendInvites, setSendInvites] = useState(true);
	const [saving, setSaving] = useState(false);
	const [results, setResults] = useState<ImportResult[] | null>(null);

	const planned = useMemo<PlannedUser[]>(() => {
		if (!rows) return [];
		const book = { people: page.people.map((p) => ({ ...p, adminAccess: p.adminAccess ?? [] })), log: [] } as unknown as PeopleBook;
		return planUserImport(rows, { book, plan: page.plan, mailboxes: page.mailboxes, domains });
	}, [rows, page, domains]);
	const ready = planned.filter((p) => !p.problem);
	const problems = planned.length - ready.length;
	// The table scrolls, so every row stays in it, but a long file gets a Find box.
	const found = useShowMore(planned, { limit: Infinity, text: (p) => `${p.name} ${p.email} ${p.mailbox ?? ""} ${p.problem ?? ""}` });

	const choose = async (e: ChangeEvent<HTMLInputElement>) => {
		const f = e.target.files?.[0];
		e.target.value = "";
		if (!f) return;
		setRows(null);
		setError(null);
		if (f.size > MAX_BYTES) { setError(t.tooBig); return; }
		try {
			const found = parseUsersCsv(await readText(f));
			if (!found.length) { setError(t.empty); return; }
			if (found.length > MAX_IMPORT_ROWS) { setError(fill(t.tooMany, { count: String(found.length), max: String(MAX_IMPORT_ROWS) })); return; }
			setFile(f.name);
			setRows(found);
		} catch (err) {
			setError(err instanceof Error && err.message === "no email column" ? t.noEmailColumn : t.unreadable);
		}
	};

	const add = async () => {
		if (!rows || !ready.length) return;
		setSaving(true);
		setError(null);
		try {
			const wanted = new Set(ready.map((p) => p.line));
			const r = await api.importPeople(rows.filter((row) => wanted.has(row.line)), sendInvites);
			setResults(r.results);
			await onDone(r.signIn);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
			<Dialog size="xl" className="max-h-[92vh] w-[calc(100vw-2rem)] min-w-0 overflow-y-auto p-5 sm:p-8 md:w-auto md:min-w-[48rem] lg:min-w-[56rem]">
				<Dialog.Title className="text-2xl font-bold tracking-tight mb-2">{t.title}</Dialog.Title>
				{results ? <Results results={results} onClose={onClose} /> : (
					<>
						<Dialog.Description className="text-base text-kumo-subtle mb-1">{t.intro}</Dialog.Description>
						<p className="text-sm text-kumo-subtle mb-5">{t.mailboxHelp}</p>

						<div className="flex flex-wrap items-center gap-2 mb-5">
							<Button variant={rows ? "secondary" : "primary"} icon={<FileArrowUpIcon size={16} />} onClick={() => input.current?.click()}>
								{rows ? t.chooseAnother : t.choose}
							</Button>
							<Button variant="ghost" icon={<DownloadSimpleIcon size={16} />} onClick={() => downloadTemplate(domains[0])}>{t.template}</Button>
							{file && <span className="text-sm text-kumo-subtle truncate">{file}</span>}
							<input ref={input} type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={choose} />
						</div>

						{error && <Text variant="error" size="sm">{error}</Text>}

						{rows && planned.length > 0 && (
							<>
								<p className="mb-2 text-base font-semibold text-kumo-default">
									{problems ? fill(t.summary, { ready: String(ready.length), problems: String(problems) }) : fill(t.summaryAll, { ready: String(ready.length) })}
								</p>
								{problems > 0 && <p className="mb-3 text-sm text-kumo-subtle">{t.fixHelp}</p>}
								<FindBox list={found} label={t.find} className="mb-2 w-full sm:w-80" />
								<div className="max-h-[50vh] overflow-auto rounded-xl border border-kumo-line">
									<table className="w-full text-sm">
										<thead className="sticky top-0 bg-kumo-recessed text-left text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
											<tr>
												<th className="hidden w-14 px-3 py-2 sm:table-cell">{t.columns.line}</th>
												<th className="w-1/2 px-3 py-2 sm:w-[34%]">{t.columns.user}</th>
												<th className="hidden w-24 px-3 py-2 sm:table-cell">{t.columns.role}</th>
												<th className="hidden w-[28%] px-3 py-2 sm:table-cell">{t.columns.mailbox}</th>
												<th className="px-3 py-2">{t.columns.check}</th>
											</tr>
										</thead>
										<tbody>
											{found.shown.map((p) => (
												<tr key={p.line} className="border-t border-kumo-line align-top">
													<td className="hidden px-3 py-2.5 text-kumo-subtle sm:table-cell">{p.line}</td>
													<td className="px-3 py-2.5 min-w-0">
														<div className="font-medium text-kumo-default break-words">{p.name || "–"}</div>
														<div className="text-kumo-subtle [overflow-wrap:anywhere]">{p.email || "–"}</div>
													</td>
													<td className="hidden px-3 py-2.5 text-kumo-default sm:table-cell">{copy.roles[p.role]}</td>
													<td className="hidden px-3 py-2.5 text-kumo-default [overflow-wrap:anywhere] sm:table-cell">
														{p.mailboxKind === "new" ? fill(t.newMailbox, { mailbox: p.mailbox }) : p.mailboxKind === "existing" ? p.mailbox : <span className="text-kumo-subtle">{p.problem ? "–" : t.noMailbox}</span>}
													</td>
													<td className="px-3 py-2.5">
														{p.problem
															? <span className="flex gap-1.5 text-kumo-danger"><WarningCircleIcon size={18} className="shrink-0" />{p.problem}</span>
															: <span className="flex gap-1.5 text-kumo-success"><CheckCircleIcon size={18} weight="fill" className="shrink-0" />{t.ready}</span>}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>

								<label className="mt-4 flex items-start gap-2 text-sm text-kumo-default">
									<input type="checkbox" className="mt-1" checked={sendInvites} onChange={(e) => setSendInvites(e.target.checked)} />
									<span><span className="font-medium">{t.sendInvites}</span><span className="block text-xs text-kumo-subtle">{t.sendInvitesHelp}</span></span>
								</label>
							</>
						)}

						<div className="flex justify-end gap-2 pt-5">
							<Button variant="secondary" disabled={saving} onClick={onClose}>{t.cancel}</Button>
							{rows && (
								<Button variant="primary" loading={saving} disabled={!ready.length} onClick={add}>
									{ready.length === 1 ? t.addOne : fill(t.add, { count: String(ready.length) })}
								</Button>
							)}
						</div>
					</>
				)}
			</Dialog>
		</Dialog.Root>
	);
}

function Results({ results, onClose }: { results: ImportResult[]; onClose: () => void }) {
	const added = results.filter((r) => r.added);
	const failed = results.filter((r) => !r.added);
	const notSent = added.filter((r) => r.invite && !r.invite.sent).length;
	return (
		<>
			<p className="mb-3 flex items-center gap-2 text-lg font-semibold text-kumo-default">
				<CheckCircleIcon size={24} weight="fill" className="text-kumo-success" />
				{failed.length
					? fill(t.doneSome, { added: String(added.length), failed: String(failed.length) })
					: added.length === 1 ? t.doneOne : fill(t.done, { count: String(added.length) })}
			</p>
			{failed.length > 0 && (
				<ul className="mb-3 space-y-1 text-sm text-kumo-danger">
					{failed.map((r) => <li key={r.line}>{r.email}: {r.error}</li>)}
				</ul>
			)}
			{notSent > 0 && <p className="mb-3 text-sm text-kumo-subtle">{fill(t.notSent, { count: String(notSent) })}</p>}
			<div className="flex justify-end pt-3">
				<Button variant="primary" onClick={onClose}>{t.close}</Button>
			</div>
		</>
	);
}
