// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: AI assistant on/off switch (off by default), what it does and keeps, and model choice; blocked senders; signature; templates; out of office; contacts and contact photos; backup & export; extra addresses; who can open this mailbox and admin access log; your own sign-off in a shared mailbox; inbox rules; automatic forwarding; masked email; passkeys; long lists fold to their first few; wording in app/copy/settings.en-GB.json.

import { Badge, Button, Input, Loader, Switch, Text, useKumoToastManager } from "@cloudflare/kumo";
import { AirplaneTakeoffIcon, AppWindowIcon, ArchiveBoxIcon, DownloadSimpleIcon, AddressBookIcon, UserCircleIcon, RobotIcon, ArrowCounterClockwiseIcon, NotepadIcon, PencilSimpleIcon, PlusIcon, ProhibitIcon, SignatureIcon, TrashIcon, UploadSimpleIcon, XIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { folderFromFileName, MboxReader } from "shared/mbox-import";
import { fill } from "~/lib/attachments";
import { installHint, pushState, testPush, turnOffPush, turnOnPush, type InstallHint, type PushState } from "~/lib/app-mode";
import { useBackupAction, useBackups, useMailbox, useSpamAction, useUpdateMailbox } from "~/queries/mailboxes";
import api from "~/services/api";
import { formatSize } from "shared/attachments";
import copy from "~/copy/settings.en-GB.json";
import brand from "~/copy/brand.en-GB.json";
import { AI_CHAT_KEEP, AI_MODELS, aiModelFor, isAiEnabled, WORKERS_AI_DATA_URL, WORKERS_AI_PRICING_URL } from "shared/ai";
import AddressSettings from "~/components/AddressSettings";
import MaskedSettings from "~/components/MaskedSettings";
import MailboxAccess from "~/components/MailboxAccess";
import InboxRules from "~/components/InboxRules";
import SpamLearningNote from "~/components/SpamLearningNote";
import ForwardingSettings from "~/components/ForwardingSettings";
import PersonalSignOff from "~/components/PersonalSignOff";
import Passkeys from "~/components/Passkeys";
import { isValidSenderEntry } from "shared/spam";
import { autoReplyState } from "shared/autoreply";
import { cleanTemplates, MAX_TEMPLATES, type EmailTemplate } from "shared/templates";
import type { MailboxSettings } from "~/types";
import { FindBox, ShowMoreButton, useShowMore } from "~/components/ShowMore";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organise conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

const TABS = ["account", "addresses", "masked", "writing", "contacts", "rules", "forwarding", "spam", "backup", "ai"] as const;
type Tab = (typeof TABS)[number];
const SAVED_TABS = new Set<Tab>(["account", "writing", "contacts", "ai"]);

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [searchParams, setSearchParams] = useSearchParams();
	const tab: Tab = (TABS as readonly string[]).includes(searchParams.get("tab") ?? "") ? (searchParams.get("tab") as Tab) : "account";
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [aiEnabled, setAiEnabled] = useState(false);
	const [aiModel, setAiModel] = useState(AI_MODELS[0].id as string);
	const [signatureOn, setSignatureOn] = useState(false);
	const [signatureText, setSignatureText] = useState("");
	const [showPhotos, setShowPhotos] = useState(false);
	const [autoContacts, setAutoContacts] = useState(true);
	const [awayOn, setAwayOn] = useState(false);
	const [awayMessage, setAwayMessage] = useState("");
	const [awayStart, setAwayStart] = useState("");
	const [awayEnd, setAwayEnd] = useState("");
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
			setAiEnabled(isAiEnabled(mailbox.settings));
			setAiModel(aiModelFor(mailbox.settings));
			setSignatureOn(!!mailbox.settings?.signature?.enabled);
			setSignatureText(mailbox.settings?.signature?.text || "");
			setShowPhotos(!!mailbox.settings?.showPhotos);
			setAutoContacts(mailbox.settings?.autoContacts !== false);
			setAwayOn(!!mailbox.settings?.autoReply?.enabled);
			setAwayMessage(mailbox.settings?.autoReply?.message || "");
			setAwayStart(toLocalInput(mailbox.settings?.autoReply?.start));
			setAwayEnd(toLocalInput(mailbox.settings?.autoReply?.end));
		}
		// Mail App: only when the mailbox first loads, so blocking a sender below doesn't wipe unsaved edits.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mailbox?.id]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		const awayError = awayOn && !awayMessage.trim() ? copy.outOfOffice.needMessage
			: awayStart && awayEnd && fromLocalInput(awayEnd)! <= fromLocalInput(awayStart)! ? copy.outOfOffice.endBeforeStart : null;
		if (awayError) { toastManager.add({ title: awayError, variant: "error" }); return; }
		setIsSaving(true);
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			aiEnabled,
			aiModel,
			agentSystemPrompt: agentPrompt.trim() || undefined,
			// Plain text from Settings replaces any older HTML signature.
			signature: { enabled: signatureOn && signatureText.trim().length > 0, text: signatureText.trim() },
			showPhotos,
			autoContacts,
			autoReply: { enabled: awayOn, message: awayMessage.trim(), start: fromLocalInput(awayStart), end: fromLocalInput(awayEnd) },
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved!" });
		} catch {
			toastManager.add({
				title: "Failed to save settings",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	const handleResetPrompt = () => {
		setAgentPrompt("");
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-4">Settings</h1>

			{/* Mail App: settings grouped into tabs. Each has its own link, e.g. ?tab=backup, for guides to point at.
			    On a phone they scroll sideways; on a wider screen they wrap onto a second line rather than hide. */}
			<div role="tablist" aria-label="Settings" className="-mx-4 mb-6 flex gap-1 overflow-x-auto border-b border-kumo-line px-4 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
				{TABS.map((t) => (
					<button
						key={t}
						type="button"
						role="tab"
						aria-selected={tab === t}
						ref={tab === t ? (el) => el?.scrollIntoView({ block: "nearest", inline: "nearest" }) : undefined}
						onClick={() => setSearchParams((p) => { p.set("tab", t); return p; }, { replace: true })}
						className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${tab === t ? "border-kumo-brand text-kumo-default" : "border-transparent text-kumo-subtle hover:text-kumo-default"}`}
					>
						{copy.tabs[t]}
					</button>
				))}
			</div>

			<div className="space-y-6">
				{tab === "account" && (<>
				{/* Account */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">
						Account
					</div>
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
					</div>
					{/* Mail App: Cloudflare Access ends the sign-in on this device */}
					<div className="mt-4 flex flex-wrap items-center gap-3">
						<Button variant="secondary" size="sm" onClick={() => { window.location.href = brand.signOutUrl; }}>{brand.signOut}</Button>
						<span className="text-xs text-kumo-subtle">{brand.signOutHint}</span>
					</div>
				</div>

				{/* Mail App: who can open this mailbox, and when an admin did */}
				{mailboxId && <MailboxAccess mailboxId={mailboxId} />}

				{/* Mail App: sign in with Face ID, Touch ID or a phone instead of an email code */}
				<Passkeys />

				{/* Mail App: the app on your Dock or home screen, and notifications */}
				{mailboxId && <ThisDevice mailboxId={mailboxId} />}
				</>)}
				{tab === "addresses" && mailboxId && (
					<AddressSettings mailboxId={mailboxId} mainName={mailbox.settings?.fromName || mailbox.name} settings={mailbox.settings} />
				)}
				{tab === "masked" && mailboxId && <MaskedSettings mailboxId={mailboxId} settings={mailbox.settings} />}
				{tab === "writing" && (<>
				{/* Mail App: in a shared mailbox, your own name and signature */}
				{mailbox.shared && <PersonalSignOff mailboxName={mailbox.settings?.fromName || mailbox.email.split("@")[0]} />}

				{/* Mail App: signature */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-2">
						<SignatureIcon size={16} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-medium text-kumo-default">{copy.signature.title}</span>
					</div>
					<p className="text-xs text-kumo-subtle mb-3">{copy.signature.intro}</p>
					<Switch label={copy.signature.switchLabel} checked={signatureOn} onCheckedChange={setSignatureOn} />
					{signatureOn && (
						<label className="block mt-3">
							<span className="block text-base font-medium text-kumo-default mb-1.5">{copy.signature.label}</span>
							<textarea
								value={signatureText}
								onChange={(e) => setSignatureText(e.target.value)}
								placeholder={copy.signature.placeholder}
								rows={4}
								className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring"
							/>
						</label>
					)}
				</div>

				{/* Mail App: out of office */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-2">
						<AirplaneTakeoffIcon size={16} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-medium text-kumo-default">{copy.outOfOffice.title}</span>
					</div>
					<p className="text-xs text-kumo-subtle mb-3">{copy.outOfOffice.intro}</p>
					<Switch label={copy.outOfOffice.switchLabel} checked={awayOn} onCheckedChange={setAwayOn} />
					{awayOn && (
						<div className="mt-3 space-y-3">
							<label className="block">
								<span className="block text-base font-medium text-kumo-default mb-1.5">{copy.outOfOffice.message}</span>
								<textarea
									value={awayMessage}
									onChange={(e) => setAwayMessage(e.target.value)}
									placeholder={copy.outOfOffice.messagePlaceholder}
									rows={4}
									className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring"
								/>
							</label>
							<div className="grid gap-3 sm:grid-cols-2">
								<Input label={copy.outOfOffice.start} type="datetime-local" value={awayStart} onChange={(e) => setAwayStart(e.target.value)} />
								<Input label={copy.outOfOffice.end} type="datetime-local" value={awayEnd} onChange={(e) => setAwayEnd(e.target.value)} />
							</div>
							<p className="text-xs text-kumo-subtle">{copy.outOfOffice.datesHint}</p>
							<AwayState enabled={mailbox.settings?.autoReply?.enabled} message={mailbox.settings?.autoReply?.message} start={mailbox.settings?.autoReply?.start} end={mailbox.settings?.autoReply?.end} />
							<p className="text-xs text-kumo-subtle">{copy.outOfOffice.paidNote}</p>
						</div>
					)}
				</div>

				{/* Mail App: templates */}
				{mailboxId && <Templates mailboxId={mailboxId} settings={mailbox.settings} />}
				</>)}
				{tab === "contacts" && (<>
				{/* Mail App: add people from your emails to Contacts */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-2">
						<AddressBookIcon size={16} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-medium text-kumo-default">{copy.autoContacts.title}</span>
					</div>
					<p className="text-xs text-kumo-subtle mb-3">{copy.autoContacts.intro}</p>
					<Switch label={copy.autoContacts.switchLabel} checked={autoContacts} onCheckedChange={setAutoContacts} />
				</div>

				{/* Mail App: contact photos */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-2">
						<UserCircleIcon size={16} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-medium text-kumo-default">{copy.photos.title}</span>
					</div>
					<p className="text-xs text-kumo-subtle mb-3">{copy.photos.intro}</p>
					<Switch label={copy.photos.switchLabel} checked={showPhotos} onCheckedChange={setShowPhotos} />
				</div>
				</>)}
				{tab === "rules" && mailboxId && (
				<InboxRules mailboxId={mailboxId} rules={mailbox.settings?.rules} startFrom={searchParams.get("from")}
					onStarted={() => setSearchParams((p) => { p.delete("from"); return p; }, { replace: true })} />
				)}
				{tab === "forwarding" && mailboxId && <ForwardingSettings mailboxId={mailboxId} />}
				{tab === "spam" && (<>
				{/* Mail App: blocked senders */}
				{mailboxId && <BlockedSenders mailboxId={mailboxId} blocked={mailbox.settings?.blockedSenders ?? []} />}
				{mailboxId && <SpamLearningNote mailboxId={mailboxId} />}
				</>)}
				{tab === "backup" && (<>
				{/* Mail App: backup & export */}
				{mailboxId && <Backups mailboxId={mailboxId} />}
				</>)}
				{tab === "ai" && (<>
				{/* Mail App: AI assistant switch, what it does and keeps, model choice and pricing link */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-2">
						<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-medium text-kumo-default">{copy.ai.title}</span>
					</div>
					<p className="text-xs text-kumo-default mb-3">{copy.ai.intro}</p>
					<p className="text-xs text-kumo-subtle mb-3">{aiEnabled ? copy.ai.on : copy.ai.off}</p>
					<Switch label={copy.ai.switchLabel} checked={aiEnabled} onCheckedChange={setAiEnabled} />
					<div className="mt-5 rounded-md border border-kumo-line bg-kumo-recessed p-4">
						<p className="text-sm font-medium text-kumo-default mb-2">{copy.ai.factsTitle}</p>
						<dl className="flex flex-col gap-2">
							{copy.ai.facts.map((f) => (
								<div key={f.title}>
									<dt className="text-xs font-medium text-kumo-default">{f.title}</dt>
									<dd className="text-xs text-kumo-subtle">{f.text.replace("{keep}", String(AI_CHAT_KEEP))}</dd>
								</div>
							))}
						</dl>
						<p className="text-xs mt-3">
							<a href={WORKERS_AI_DATA_URL} target="_blank" rel="noopener noreferrer" className="text-kumo-link underline">{copy.ai.dataLink}</a>
						</p>
					</div>
					<fieldset className="mt-5">
						<legend className="text-sm font-medium text-kumo-default mb-1">{copy.ai.modelTitle}</legend>
						<p className="text-xs text-kumo-subtle mb-2">{copy.ai.modelNote}</p>
						<div className="flex flex-col gap-2">
							{AI_MODELS.map((m) => (
								<label key={m.id} className="flex items-start gap-2 rounded-md border border-kumo-line px-3 py-2 cursor-pointer">
									<input type="radio" name="aiModel" value={m.id} checked={aiModel === m.id} onChange={() => setAiModel(m.id)} className="mt-0.5" />
									<span>
										<span className="block text-sm text-kumo-default">{m.name} <span className="text-kumo-subtle">by {m.maker}</span></span>
										<span className="block text-xs text-kumo-subtle">{m.note}</span>
									</span>
								</label>
							))}
						</div>
					</fieldset>
					<p className="text-xs text-kumo-subtle mt-4">
						{copy.ai.pricingNote}{" "}
						<a href={WORKERS_AI_PRICING_URL} target="_blank" rel="noopener noreferrer" className="text-kumo-link underline">{copy.ai.pricingLink}</a>
					</p>
				</div>

				{/* Agent System Prompt */}
				{aiEnabled && (
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
								Your instructions
							</span>
							{isCustomPrompt ? (
								<Badge variant="primary">Custom</Badge>
							) : (
								<Badge variant="secondary">Default</Badge>
							)}
						</div>
						{isCustomPrompt && (
							<Button
								variant="ghost"
								size="xs"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={handleResetPrompt}
							>
								Reset to default
							</Button>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						Tell the assistant how to write for this mailbox, such as your tone or sign-off.
						Leave it empty to use the built-in instructions.
					</p>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						placeholder={PROMPT_PLACEHOLDER}
						rows={12}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
					/>
					<p className="text-xs text-kumo-subtle mt-2">
						These go to the AI model with each request, and are kept in this mailbox's settings.
					</p>
				</div>
				)}
				</>)}
				
				{/* Save: the Rules, Spam and Backup tabs save each change straight away. */}
				{SAVED_TABS.has(tab) && <div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving}>
						Save changes
					</Button>
				</div>}
			</div>
		</div>
	);
}

// Mail App: the block list. Changes save straight away, separately from "Save changes".
function BlockedSenders({ mailboxId, blocked }: { mailboxId: string; blocked: string[] }) {
	const spam = useSpamAction();
	const toastManager = useKumoToastManager();
	const blockedList = useShowMore(blocked, { text: (b) => b });
	const [entry, setEntry] = useState("");
	const [error, setError] = useState<string | null>(null);

	const add = (e: FormEvent) => {
		e.preventDefault();
		if (!isValidSenderEntry(entry)) { setError(copy.spam.invalid); return; }
		setError(null);
		spam.mutate({ mailboxId, action: "block", sender: entry }, {
			onSuccess: () => setEntry(""),
			onError: () => toastManager.add({ title: copy.spam.failed, variant: "error" }),
		});
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-2">
				<ProhibitIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{copy.spam.title}</span>
			</div>
			<p className="text-xs text-kumo-subtle mb-3">{copy.spam.intro}</p>
			{blocked.length > 0 ? (<>
				<FindBox list={blockedList} label={copy.spam.find} className="mb-2" />
				<ul className={`mb-3 divide-y divide-kumo-line rounded-lg border border-kumo-line ${blockedList.shown.length ? "" : "hidden"}`}>
					{blockedList.shown.map((b) => (
						<li key={b} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-kumo-default">
							<span className="truncate font-mono text-xs">{b}</span>
							<Button
								variant="ghost"
								size="xs"
								icon={<XIcon size={12} />}
								onClick={() => spam.mutate({ mailboxId, action: "unblock", sender: b })}
								aria-label={`Unblock ${b}`}
							>
								{copy.spam.unblock}
							</Button>
						</li>
					))}
				</ul>
				<ShowMoreButton list={blockedList} className="mb-3" />
			</>) : (
				<div className="mb-3">
					<p className="text-sm font-medium text-kumo-default">{copy.spam.noneTitle}</p>
					<p className="text-xs text-kumo-subtle">{copy.spam.none}</p>
				</div>
			)}
			<form onSubmit={add} className="flex items-end gap-2">
				<div className="flex-1">
					<Input label={copy.spam.addLabel} placeholder="name@example.com or example.com" value={entry} onChange={(e) => setEntry(e.target.value)} />
				</div>
				<Button type="submit" variant="secondary" loading={spam.isPending}>{copy.spam.add}</Button>
			</form>
			{error && <div className="mt-2"><Text variant="error" size="sm">{error}</Text></div>}
		</div>
	);
}

// Mail App: templates. Each one saves straight away, separately from "Save changes".
function Templates({ mailboxId, settings }: { mailboxId: string; settings?: MailboxSettings }) {
	const update = useUpdateMailbox();
	const toastManager = useKumoToastManager();
	const templates = cleanTemplates(settings?.templates);
	const templateList = useShowMore(templates, { text: (t) => t.name });
	const [editing, setEditing] = useState<EmailTemplate | null>(null);
	const [error, setError] = useState<string | null>(null);

	const save = (next: EmailTemplate[], onDone?: () => void) => {
		update.mutate({ mailboxId, settings: { ...settings, templates: next } }, {
			onSuccess: () => { onDone?.(); },
			onError: () => toastManager.add({ title: copy.templates.failed, variant: "error" }),
		});
	};

	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!editing) return;
		const t = { ...editing, name: editing.name.trim(), subject: editing.subject.trim() };
		if (!t.name || !t.body.trim()) { setError(copy.templates.needName); return; }
		const exists = templates.some((x) => x.id === t.id);
		if (!exists && templates.length >= MAX_TEMPLATES) { setError(copy.templates.tooMany.replace("{max}", String(MAX_TEMPLATES))); return; }
		setError(null);
		save(exists ? templates.map((x) => (x.id === t.id ? t : x)) : [...templates, t], () => {
			setEditing(null);
			toastManager.add({ title: copy.templates.saved });
		});
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-2">
				<NotepadIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{copy.templates.title}</span>
			</div>
			<p className="text-xs text-kumo-subtle mb-3">{copy.templates.intro}</p>
			{templates.length > 0 ? (<>
				<FindBox list={templateList} label={copy.templates.find} className="mb-2" />
				<ul className={`mb-3 divide-y divide-kumo-line rounded-lg border border-kumo-line ${templateList.shown.length ? "" : "hidden"}`}>
					{templateList.shown.map((t) => (
						<li key={t.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-kumo-default">
							<span className="truncate">{t.name}</span>
							<span className="flex shrink-0 gap-1">
								<Button variant="ghost" size="xs" icon={<PencilSimpleIcon size={12} />} onClick={() => { setError(null); setEditing(t); }} aria-label={`${copy.templates.edit} ${t.name}`}>
									{copy.templates.edit}
								</Button>
								<Button variant="ghost" size="xs" icon={<TrashIcon size={12} />} onClick={() => save(templates.filter((x) => x.id !== t.id))} aria-label={`${copy.templates.delete} ${t.name}`}>
									{copy.templates.delete}
								</Button>
							</span>
						</li>
					))}
				</ul>
				<ShowMoreButton list={templateList} className="mb-3" />
			</>) : (
				!editing && <p className="text-xs text-kumo-subtle mb-3">{copy.templates.none}</p>
			)}
			{editing ? (
				<form onSubmit={submit} className="space-y-3 rounded-lg border border-kumo-line p-3">
					<Input label={copy.templates.name} placeholder={copy.templates.namePlaceholder} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
					<Input label={copy.templates.subject} value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} />
					<label className="block">
						<span className="block text-base font-medium text-kumo-default mb-1.5">{copy.templates.body}</span>
						<textarea
							value={editing.body}
							onChange={(e) => setEditing({ ...editing, body: e.target.value })}
							rows={6}
							className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring"
						/>
					</label>
					{error && <Text variant="error" size="sm">{error}</Text>}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(null); setError(null); }}>{copy.templates.cancel}</Button>
						<Button type="submit" variant="secondary" size="sm" loading={update.isPending}>{copy.templates.save}</Button>
					</div>
				</form>
			) : (
				<Button variant="secondary" size="sm" icon={<PlusIcon size={14} />} onClick={() => { setError(null); setEditing({ id: crypto.randomUUID(), name: "", subject: "", body: "" }); }}>
					{copy.templates.new}
				</Button>
			)}
		</div>
	);
}

// Mail App: out-of-office dates. The browser's date and time box works in local time; settings keep ISO times.
function toLocalInput(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function fromLocalInput(value: string): string | undefined {
	if (!value) return undefined;
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const showTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

// Mail App: what the saved out of office is doing right now.
function AwayState({ enabled, message, start, end }: { enabled?: boolean; message?: string; start?: string; end?: string }) {
	const state = autoReplyState({ enabled: !!enabled, message: message ?? "", start, end }, new Date());
	if (state === "off") return null;
	const text = state === "scheduled" ? copy.outOfOffice.stateScheduled.replace("{start}", showTime(start!))
		: state === "ended" ? copy.outOfOffice.stateEnded.replace("{end}", showTime(end!))
		: end ? copy.outOfOffice.stateUntil.replace("{end}", showTime(end)) : copy.outOfOffice.stateOn;
	return <Badge variant={state === "on" ? "primary" : "secondary"}>{text}</Badge>;
}

// Mail App: backup & export. Changes save straight away, separately from "Save changes".
const KEEP_CHOICES = [1, 2, 3, 5, 7];

function when(iso: string): string {
	return new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Backups({ mailboxId }: { mailboxId: string }) {
	const { data } = useBackups(mailboxId);
	const action = useBackupAction();
	const toastManager = useKumoToastManager();
	const c = copy.backup;
	const backups = data?.backups ?? [];
	const settings = data?.settings;
	const running = backups.find((b) => b.status === "running");
	const backupList = useShowMore(backups.filter((b) => b.status !== "running"));
	const fail = () => toastManager.add({ title: c.error, variant: "error" });

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-2">
				<ArchiveBoxIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{c.title}</span>
			</div>
			<p className="text-xs text-kumo-subtle mb-3">{c.intro}</p>
			{settings && (
				<div className="flex flex-wrap items-center gap-x-6 gap-y-3">
					<Switch
						label={c.nightly}
						checked={settings.nightly}
						onCheckedChange={(nightly) => action.mutate({ mailboxId, settings: { nightly } }, { onError: fail })}
					/>
					<label className="flex items-center gap-2 text-sm text-kumo-default">
						{c.keep}
						<select
							value={settings.keep}
							onChange={(e) => action.mutate({ mailboxId, settings: { keep: Number(e.target.value) } }, { onError: fail })}
							className="rounded-md border border-kumo-line bg-kumo-recessed px-2 py-1 text-sm"
						>
							{KEEP_CHOICES.map((n) => <option key={n} value={n}>{n === 1 ? c.keepOptionOne : fill(c.keepOption, { n })}</option>)}
						</select>
					</label>
				</div>
			)}
			<p className="text-xs text-kumo-subtle mt-2">{c.keepHint}</p>

			<div className="mt-4 flex flex-wrap items-center gap-3">
				<Button
					variant="secondary"
					size="sm"
					icon={<ArchiveBoxIcon size={14} />}
					disabled={!!running}
					onClick={() => action.mutate({ mailboxId, start: true }, {
						onSuccess: () => toastManager.add({ title: c.started }),
						onError: fail,
					})}
				>
					{c.now}
				</Button>
				{running ? (
					<span className="flex items-center gap-2 text-sm text-kumo-default" role="status">
						<Loader size="sm" />
						{c.running.replace("{done}", String(running.emails)).replace("{total}", String(running.total))}
					</span>
				) : settings?.next ? (
					<span className="text-xs text-kumo-subtle">{c.next.replace("{when}", when(settings.next))}</span>
				) : null}
			</div>

			{running && running.total > 0 && (
				<div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-kumo-fill">
					<div className="h-full bg-kumo-brand transition-all" style={{ width: `${Math.min(100, Math.round((running.emails / running.total) * 100))}%` }} />
				</div>
			)}

			{backupList.total > 0 ? (<>
				<ul className="mt-4 divide-y divide-kumo-line rounded-lg border border-kumo-line">
					{backupList.shown.map((b) => (
						<li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
							<span className="font-medium text-kumo-default">{when(b.started_at)}</span>
							<span className="text-xs text-kumo-subtle">
								{b.kind === "manual" ? c.manual : c.nightlyKind}
								{b.status === "done" ? ` · ${c.emails.replace("{n}", b.emails.toLocaleString("en-GB"))} · ${formatSize(b.size)}` : ""}
							</span>
							{b.status === "failed" && <Badge variant="destructive">{c.failed}</Badge>}
							<span className="ml-auto flex items-center gap-1">
								{b.status === "done" && (
									<a
										href={api.backupDownloadUrl(mailboxId, b.id)}
										download
										className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-kumo-link hover:bg-kumo-tint no-underline"
									>
										<DownloadSimpleIcon size={14} />
										{c.download}
									</a>
								)}
								<Button
									variant="ghost"
									size="xs"
									icon={<TrashIcon size={12} />}
									aria-label={`${c.delete}: ${when(b.started_at)}`}
									onClick={() => {
										if (!window.confirm(c.deleteConfirm.replace("{when}", when(b.started_at)))) return;
										action.mutate({ mailboxId, remove: b.id }, { onError: fail });
									}}
								/>
							</span>
						</li>
					))}
				</ul>
				<ShowMoreButton list={backupList} className="mt-3" />
			</>) : !running ? (
				<p className="mt-4 text-sm text-kumo-subtle">{c.none}</p>
			) : null}

			<ImportMail mailboxId={mailboxId} />
		</div>
	);
}

/** Batches sent to the server: at most this many messages, or about this many bytes. */
const IMPORT_BATCH = 100;
const IMPORT_BATCH_BYTES = 20 * 1024 * 1024;
const IMPORT_MAX_MESSAGE = 90 * 1024 * 1024;

type ImportState =
	| { phase: "idle" }
	| { phase: "running"; pct: number }
	| { phase: "done"; added: number; skipped: number; failed: number; tooBig: number }
	| { phase: "error"; error: string };

/** Mail App: reads an .mbox file in the browser, a piece at a time, and sends its messages up in batches. */
function ImportMail({ mailboxId }: { mailboxId: string }) {
	const c = copy.backup;
	const qc = useQueryClient();
	const [state, setState] = useState<ImportState>({ phase: "idle" });
	const running = state.phase === "running";

	useEffect(() => {
		if (!running) return;
		const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = c.importLeave; };
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [running, c.importLeave]);

	const run = async (file: File) => {
		const total = { added: 0, skipped: 0, failed: 0, tooBig: 0 };
		const folder = folderFromFileName(file.name);
		const reader = new MboxReader();
		let batch: Uint8Array[] = [];
		let batchBytes = 0;
		let read = 0;
		setState({ phase: "running", pct: 0 });
		const send = async () => {
			if (batch.length === 0) return;
			const r = await api.importMessages(mailboxId, batch, folder);
			total.added += r.added; total.skipped += r.skipped; total.failed += r.failed;
			batch = []; batchBytes = 0;
		};
		const take = async (messages: Uint8Array[]) => {
			for (const m of messages) {
				if (m.length > IMPORT_MAX_MESSAGE) { total.tooBig += 1; continue; }
				if (batch.length >= IMPORT_BATCH || (batchBytes + m.length > IMPORT_BATCH_BYTES && batch.length > 0)) await send();
				batch.push(m); batchBytes += m.length;
			}
		};
		try {
			const stream = file.stream().getReader();
			for (;;) {
				const { done, value } = await stream.read();
				if (done) break;
				read += value.length;
				await take(reader.push(value));
				setState({ phase: "running", pct: file.size ? Math.min(99, Math.floor((read / file.size) * 100)) : 0 });
			}
			await take(reader.end());
			await send();
			setState({ phase: "done", ...total });
		} catch (e) {
			setState({ phase: "error", error: e instanceof Error ? e.message : String(e) });
		} finally {
			qc.invalidateQueries();
		}
	};

	return (
		<div className="mt-5 border-t border-kumo-line pt-4">
			<span className="text-sm font-medium text-kumo-default">{c.importTitle}</span>
			<p className="text-xs text-kumo-subtle mt-1 mb-3">{c.importIntro}</p>
			<label className={`inline-flex items-center gap-1.5 rounded-md border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm font-medium text-kumo-default ${running ? "opacity-50" : "cursor-pointer hover:bg-kumo-tint"}`}>
				<UploadSimpleIcon size={14} />
				{c.importChoose}
				<input
					type="file"
					accept=".mbox,.mbx,.txt,application/mbox"
					className="sr-only"
					disabled={running}
					onChange={(e) => {
						const file = e.target.files?.[0];
						e.target.value = "";
						if (file) void run(file);
					}}
				/>
			</label>
			{state.phase === "running" && (
				<div className="mt-3" role="status">
					<span className="flex items-center gap-2 text-sm text-kumo-default">
						<Loader size="sm" />
						{c.importRunning.replace("{pct}", String(state.pct))}
					</span>
					<div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-kumo-fill">
						<div className="h-full bg-kumo-brand transition-all" style={{ width: `${state.pct}%` }} />
					</div>
					<p className="text-xs text-kumo-subtle mt-1">{c.importStay}</p>
				</div>
			)}
			{state.phase === "done" && (
				<div className="mt-3 text-sm text-kumo-default" role="status">
					<p>{c.importDone.replace("{added}", state.added.toLocaleString("en-GB")).replace("{skipped}", state.skipped.toLocaleString("en-GB"))}</p>
					{state.failed > 0 && <p className="text-xs text-kumo-subtle">{c.importFailed.replace("{n}", String(state.failed))}</p>}
					{state.tooBig > 0 && <p className="text-xs text-kumo-subtle">{c.importTooBig.replace("{n}", String(state.tooBig))}</p>}
				</div>
			)}
			{state.phase === "error" && (
				<p className="mt-3 text-sm text-kumo-danger" role="alert">{c.importError.replace("{error}", state.error)}</p>
			)}
		</div>
	);
}

/** Mail App: installing Mail App as an app, and switching new-mail notifications on for this device. */
function ThisDevice({ mailboxId }: { mailboxId: string }) {
	const c = copy.device;
	const toastManager = useKumoToastManager();
	const [state, setState] = useState<PushState | null>(null);
	const [busy, setBusy] = useState(false);
	const [hint, setHint] = useState<InstallHint>("installOther");
	const canMailto = typeof navigator !== "undefined" && "registerProtocolHandler" in navigator && !/^((?!Chrome|Edg|Firefox).)*Safari/.test(navigator.userAgent);

	useEffect(() => {
		setHint(installHint());
		pushState(mailboxId).then(setState).catch(() => setState("unsupported"));
	}, [mailboxId]);

	const fail = () => toastManager.add({ title: c.error, variant: "error" });
	const toggle = async (on: boolean) => {
		setBusy(true);
		try { setState(on ? await turnOnPush(mailboxId) : await turnOffPush(mailboxId)); } catch { fail(); } finally { setBusy(false); }
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-2">
				<AppWindowIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{c.title}</span>
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				{c[hint]}{" "}
				<a href={c.guideUrl} target="_blank" rel="noreferrer" className="text-kumo-link">{c.guide}</a>
			</p>

			{state === "off" || state === "on" ? (
				<>
					<div className="flex flex-wrap items-center gap-3">
						<Switch label={c.notify} checked={state === "on"} disabled={busy} onCheckedChange={(on) => void toggle(on)} />
						{state === "on" && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => testPush(mailboxId)
									.then((n) => toastManager.add({ title: n > 0 ? c.testSent : c.testNone }))
									.catch(fail)}
							>
								{c.test}
							</Button>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mt-2">{c.notifyHint} {c.notifyScope}</p>
				</>
			) : state ? (
				<p className="text-sm text-kumo-subtle">{state === "blocked" ? c.blocked : state === "needs-install" ? c.needsInstall : c.unsupported}</p>
			) : null}

			{canMailto && (
				<div className="mt-4">
					<p className="text-sm font-medium text-kumo-default mb-2">{c.mailtoTitle}</p>
					<Button
						variant="secondary"
						size="sm"
						onClick={() => {
							try { navigator.registerProtocolHandler("mailto", `${window.location.origin}/compose?mailto=%s`); } catch { fail(); }
						}}
					>
						{c.mailto}
					</Button>
					<p className="text-xs text-kumo-subtle mt-2">{c.mailtoHint}</p>
				</div>
			)}
		</div>
	);
}
