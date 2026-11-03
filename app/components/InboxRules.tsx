// Mail App: inbox rules in Settings. Each change saves straight away, like the block list.
// Words are in app/copy/rules.en-GB.json.

import { Button, Input, Switch, Text, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowDownIcon, ArrowUpIcon, FunnelSimpleIcon, PencilSimpleIcon, PlusIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useState } from "react";
import { Folders } from "shared/folders";
import type { Label } from "shared/labels";
import { MAX_CONDITIONS, MAX_RULES, RULE_FIELDS, cleanRules, newRuleId, type InboxRule, type RuleCondition, type RuleField } from "shared/rules";
import { LabelDot } from "~/components/Labels";
import copy from "~/copy/rules.en-GB.json";
import { useFolders } from "~/queries/folders";
import { useLabels } from "~/queries/labels";
import { useApplyRule, useSaveRules } from "~/queries/mailboxes";
import type { Folder } from "~/types";
import { FindBox, ShowMoreButton, useShowMore } from "~/components/ShowMore";

/** Folders a rule can file mail into: everything but Inbox, Sent, Drafts and Snoozed. */
function ruleFolders(folders: Folder[] | undefined): Folder[] {
	const skip = new Set<string>([Folders.INBOX, Folders.SENT, Folders.DRAFT, Folders.SNOOZED, Folders.SCHEDULED]);
	return (folders ?? []).filter((f) => !skip.has(f.id));
}

const selectClass = "rounded-md border border-kumo-line bg-kumo-recessed px-2 py-1.5 text-sm text-kumo-default";

export default function InboxRules({ mailboxId, rules: saved, startFrom, onStarted }: {
	mailboxId: string;
	rules: InboxRule[] | undefined;
	/** Open a new rule for mail from this sender (from "Make a rule" on a message). */
	startFrom?: string | null;
	/** Called once the new rule is open, so the page link can forget the sender. */
	onStarted?: () => void;
}) {
	const rules = cleanRules(saved);
	const save = useSaveRules();
	const apply = useApplyRule();
	const toast = useKumoToastManager();
	const { data: folders } = useFolders(mailboxId);
	const { data: labels } = useLabels(mailboxId);
	const [editing, setEditing] = useState<InboxRule | null>(null);

	useEffect(() => {
		if (!startFrom) return;
		setEditing(blankRule([{ field: "from", value: startFrom }]));
		onStarted?.();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [startFrom]);

	const store = (next: InboxRule[], after?: (list: InboxRule[]) => void) => save.mutate({ mailboxId, rules: next }, {
		onSuccess: (data) => after?.(cleanRules((data.settings as { rules?: unknown }).rules)),
		onError: () => toast.add({ title: copy.failed, variant: "error" }),
	});

	const saveEditing = (rule: InboxRule, applyNow: boolean) => {
		const at = rules.findIndex((r) => r.id === rule.id);
		const next = at >= 0 ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule];
		store(next, () => {
			setEditing(null);
			if (!applyNow) { toast.add({ title: copy.saved }); return; }
			apply.mutate({ mailboxId, ruleId: rule.id }, {
				onSuccess: ({ changed }) => toast.add({ title: changed === 0 ? copy.appliedNone : changed === 1 ? copy.appliedOne : copy.applied.replace("{n}", String(changed)) }),
				onError: () => toast.add({ title: copy.failed, variant: "error" }),
			});
		});
	};

	const ruleList = useShowMore(rules, { text: (r) => `${r.name ?? ""} ${summary(r, folders, labels)}` });

	const swap = (i: number, j: number) => {
		const next = [...rules];
		[next[i], next[j]] = [next[j], next[i]];
		store(next);
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-2">
				<FunnelSimpleIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{copy.title}</span>
			</div>
			<p className="text-xs text-kumo-subtle mb-3">{copy.intro}</p>

			<FindBox list={ruleList} label={copy.find} className="mb-2" />
			{ruleList.shown.length > 0 ? (
				<ul className="mb-3 divide-y divide-kumo-line rounded-lg border border-kumo-line">
					{ruleList.shown.map((r) => { const i = rules.indexOf(r); return (
						<li key={r.id} className="flex items-start gap-3 px-3 py-2.5">
							<div className="min-w-0 flex-1">
								{r.name && <div className="text-sm font-medium text-kumo-default">{r.name}</div>}
								<div className={`text-sm ${r.enabled ? "text-kumo-default" : "text-kumo-subtle line-through"} ${r.name ? "text-xs text-kumo-subtle" : ""}`}>
									{summary(r, folders, labels)}
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-0.5">
								<Switch
									aria-label={copy.on}
									checked={r.enabled}
									onCheckedChange={(enabled) => store(rules.map((x) => (x.id === r.id ? { ...x, enabled } : x)))}
								/>
								<Button variant="ghost" shape="square" size="xs" icon={<ArrowUpIcon size={14} />} aria-label={copy.moveUp} disabled={i === 0} onClick={() => swap(i, i - 1)} />
								<Button variant="ghost" shape="square" size="xs" icon={<ArrowDownIcon size={14} />} aria-label={copy.moveDown} disabled={i === rules.length - 1} onClick={() => swap(i, i + 1)} />
								<Button variant="ghost" shape="square" size="xs" icon={<PencilSimpleIcon size={14} />} aria-label={copy.edit} onClick={() => setEditing(r)} />
								<Button
									variant="ghost" shape="square" size="xs" icon={<TrashIcon size={14} />} aria-label={copy.delete}
									onClick={() => { if (window.confirm(copy.deleteConfirm)) store(rules.filter((x) => x.id !== r.id)); }}
								/>
							</div>
						</li>
					); })}
				</ul>
			) : !editing && rules.length === 0 && (
				<div className="mb-3">
					<p className="text-sm font-medium text-kumo-default">{copy.noneTitle}</p>
					<p className="text-xs text-kumo-subtle">{copy.none}</p>
				</div>
			)}
			<ShowMoreButton list={ruleList} className="mb-3" />

			{editing ? (
				<RuleEditor
					key={editing.id}
					rule={editing}
					folders={ruleFolders(folders)}
					labels={labels ?? []}
					saving={save.isPending || apply.isPending}
					onCancel={() => setEditing(null)}
					onSave={saveEditing}
				/>
			) : rules.length < MAX_RULES && (
				<Button variant="secondary" size="sm" icon={<PlusIcon size={14} />} onClick={() => setEditing(blankRule())}>{copy.new}</Button>
			)}
			<p className="text-xs text-kumo-subtle mt-3">{copy.quietNote}</p>
		</div>
	);
}

function blankRule(conditions: RuleCondition[] = [{ field: "from", value: "" }]): InboxRule {
	return { id: newRuleId(), enabled: true, match: "all", conditions, actions: {} };
}

function RuleEditor({ rule, folders, labels, saving, onCancel, onSave }: {
	rule: InboxRule;
	folders: Folder[];
	labels: Label[];
	saving: boolean;
	onCancel: () => void;
	onSave: (rule: InboxRule, applyNow: boolean) => void;
}) {
	const [name, setName] = useState(rule.name ?? "");
	const [match, setMatch] = useState(rule.match);
	const [conditions, setConditions] = useState<RuleCondition[]>(rule.conditions.length ? rule.conditions : [{ field: "from", value: "" }]);
	const [moveOn, setMoveOn] = useState(!!rule.actions.folder);
	const [folder, setFolder] = useState(rule.actions.folder ?? "");
	const [picked, setPicked] = useState<string[]>(rule.actions.labels ?? []);
	const [markRead, setMarkRead] = useState(!!rule.actions.markRead);
	const [star, setStar] = useState(!!rule.actions.star);
	const [applyNow, setApplyNow] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const setCondition = (i: number, change: Partial<RuleCondition>) =>
		setConditions((cs) => cs.map((c, j) => (j === i ? { ...c, ...change } : c)));

	const submit = (e: FormEvent) => {
		e.preventDefault();
		const next = cleanRules([{
			id: rule.id, name, enabled: rule.enabled, match, conditions,
			actions: { folder: moveOn ? folder : undefined, labels: picked.filter((id) => labels.some((l) => l.id === id)), markRead, star },
		}])[0];
		if (!conditions.some((c) => c.field === "attachment" || c.value?.trim())) { setError(copy.needCondition); return; }
		if (!next) { setError(copy.needAction); return; }
		setError(null);
		onSave(next, applyNow);
	};

	return (
		<form onSubmit={submit} className="space-y-4 rounded-lg border border-kumo-line bg-kumo-recessed/40 p-4">
			<Input label={copy.nameLabel} placeholder={copy.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />

			<div>
				<div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-kumo-default">
					{conditions.length > 1 ? (<>
						<span>{copy.when}</span>
						<select aria-label={copy.when} value={match} onChange={(e) => setMatch(e.target.value as InboxRule["match"])} className={selectClass}>
							<option value="all">{copy.matchAll}</option>
							<option value="any">{copy.matchAny}</option>
						</select>
					</>) : <span>{copy.when} {copy.matchOne}</span>}
				</div>
				<div className="space-y-2">
					{conditions.map((c, i) => (
						<div key={i} className="flex flex-wrap items-center gap-2">
							<select
								aria-label={copy.fields.from}
								value={c.field}
								onChange={(e) => setCondition(i, { field: e.target.value as RuleField })}
								className={selectClass}
							>
								{RULE_FIELDS.map((f) => <option key={f} value={f}>{copy.fields[f]}</option>)}
							</select>
							{c.field !== "attachment" && (<>
								<span className="text-sm text-kumo-subtle">{copy.contains}</span>
								<input
									value={c.value ?? ""}
									onChange={(e) => setCondition(i, { value: e.target.value })}
									placeholder={copy.placeholders[c.field]}
									aria-label={`${copy.fields[c.field]} ${copy.contains}`}
									className="min-w-0 flex-1 basis-40 rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring"
								/>
							</>)}
							{conditions.length > 1 && (
								<Button variant="ghost" shape="square" size="xs" icon={<XIcon size={14} />} aria-label={copy.removeCondition}
									onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))} />
							)}
						</div>
					))}
				</div>
				{conditions.length < MAX_CONDITIONS && (
					<button type="button" onClick={() => setConditions((cs) => [...cs, { field: "subject", value: "" }])}
						className="mt-2 text-sm text-kumo-link hover:underline">
						+ {copy.addCondition}
					</button>
				)}
			</div>

			<div>
				<div className="mb-2 text-sm font-medium text-kumo-default">{copy.then}</div>
				<div className="space-y-2.5 text-sm text-kumo-default">
					<div className="flex flex-wrap items-center gap-2">
						<label className="flex items-center gap-2">
							<input type="checkbox" checked={moveOn} onChange={(e) => setMoveOn(e.target.checked)} className="size-4 accent-kumo-brand" />
							{copy.moveTo}
						</label>
						{moveOn && (
							<select aria-label={copy.moveTo} value={folder} onChange={(e) => setFolder(e.target.value)} className={selectClass}>
								<option value="" disabled>{copy.chooseFolder}</option>
								{folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
							</select>
						)}
					</div>
					<div>
						<div className="mb-1.5">{copy.addLabels}</div>
						{labels.length ? (
							<div className="flex flex-wrap gap-1.5">
								{labels.map((l) => {
									const on = picked.includes(l.id);
									return (
										<button
											key={l.id}
											type="button"
											aria-pressed={on}
											onClick={() => setPicked((p) => (on ? p.filter((id) => id !== l.id) : [...p, l.id]))}
											className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${on ? "border-kumo-brand bg-kumo-base font-medium" : "border-kumo-line bg-kumo-base text-kumo-subtle hover:text-kumo-default"}`}
										>
											<LabelDot color={l.color} />
											{l.name}
										</button>
									);
								})}
							</div>
						) : <p className="text-xs text-kumo-subtle">{copy.noLabels}</p>}
					</div>
					<label className="flex items-center gap-2">
						<input type="checkbox" checked={markRead} onChange={(e) => setMarkRead(e.target.checked)} className="size-4 accent-kumo-brand" />
						{copy.markRead}
					</label>
					<label className="flex items-center gap-2">
						<input type="checkbox" checked={star} onChange={(e) => setStar(e.target.checked)} className="size-4 accent-kumo-brand" />
						{copy.star}
					</label>
				</div>
			</div>

			<label className="flex items-center gap-2 border-t border-kumo-line pt-3 text-sm text-kumo-default">
				<input type="checkbox" checked={applyNow} onChange={(e) => setApplyNow(e.target.checked)} className="size-4 accent-kumo-brand" />
				{copy.applyExisting}
			</label>

			{error && <Text variant="error" size="sm">{error}</Text>}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>{copy.cancel}</Button>
				<Button type="submit" variant="primary" size="sm" loading={saving}>{copy.save}</Button>
			</div>
		</form>
	);
}

/** One line in plain words, such as: From contains "bank.co.uk": move to Bank, label Money. */
function summary(rule: InboxRule, folders: Folder[] | undefined, labels: Label[] | undefined): string {
	const join = rule.match === "any" ? copy.summaryOr : copy.summaryAnd;
	const when = rule.conditions
		.map((c) => (c.field === "attachment" ? copy.fields.attachment : `${copy.fields[c.field]} ${copy.contains} "${c.value}"`))
		.join(join);
	const does: string[] = [];
	if (rule.actions.folder) {
		const f = folders?.find((x) => x.id === rule.actions.folder);
		does.push(copy.summaryMove.replace("{folder}", f?.name ?? copy.deletedFolder));
	}
	const names = (rule.actions.labels ?? []).map((id) => labels?.find((l) => l.id === id)?.name).filter(Boolean);
	if (names.length) does.push(copy.summaryLabel.replace("{labels}", names.join(", ")));
	if (rule.actions.markRead) does.push(copy.summaryRead);
	if (rule.actions.star) does.push(copy.summaryStar);
	return `${when}: ${does.join(", ")}`;
}
