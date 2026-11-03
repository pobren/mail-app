// Mail App addition (not part of upstream Agentic Inbox).
// Admin > API & webhooks (admins only): the API's address, API keys (each limited to chosen mailboxes and
// permissions, shown once when made), and webhooks (with a signing secret, a test button and a delivery
// log). The API itself is described in docs/api.md. Wording lives in app/copy/developer.en-GB.json.

import { Button, Dialog, DropdownMenu, Input, Loader, Text, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowSquareOutIcon, BookOpenTextIcon, CheckIcon, CopyIcon, DotsThreeVerticalIcon, KeyIcon, PlusIcon, WarningIcon, WebhooksLogoIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { SCOPES, WEBHOOK_EVENTS, type Scope, type Webhook, type WebhookEvent } from "shared/api";
import { Details, Empty, Headings, Menu, Row, Section } from "~/components/AdminTable";
import AdminShell, { PageHeading, Pill, type Tone } from "~/components/AdminShell";
import { FindBox, ShowMoreButton, shortList, useShowMore } from "~/components/ShowMore";
import adminCopy from "~/copy/admin.en-GB.json";
import copy from "~/copy/developer.en-GB.json";
import peopleCopy from "~/copy/people.en-GB.json";
import { fill } from "~/lib/attachments";
import { queryKeys } from "~/queries/keys";
import { useMe } from "~/queries/people";
import api from "~/services/api";
import { pageTitle } from "~/lib/brand";

export function meta({ matches }: { matches: readonly unknown[] }) {
	return [{ title: pageTitle(matches, copy.title) }];
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const SCOPE_TONE: Record<Scope, Tone> = { read: "blue", send: "violet", organise: "amber" };
const KEY_COLUMNS = "md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_minmax(0,1.4fr)_9rem_3rem]";
const HOOK_COLUMNS = "md:grid-cols-[minmax(0,1.8fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_7rem_3rem]";

export default function DeveloperRoute() {
	const { data: me } = useMe();
	const isAdmin = me?.role === "admin";
	const { data, isLoading, error } = useQuery({ queryKey: queryKeys.developer, queryFn: () => api.getDeveloper(), enabled: isAdmin });
	const qc = useQueryClient();
	const toast = useKumoToastManager();
	const [newKey, setNewKey] = useState(false);
	const [newHook, setNewHook] = useState(false);
	const [shownKey, setShownKey] = useState<string | null>(null);
	const [shownSecret, setShownSecret] = useState<Webhook | null>(null);
	const [logFor, setLogFor] = useState<Webhook | null>(null);
	const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => Promise<unknown>; done: string } | null>(null);
	const [busy, setBusy] = useState(false);

	const keyList = useShowMore(data?.keys ?? [], { text: (k) => `${k.name} ${k.hint} ${k.mailboxes.join(" ")}` });
	const hookList = useShowMore(data?.webhooks ?? [], { text: (w) => `${w.name} ${w.url} ${w.mailboxes.join(" ")}` });

	const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.developer });
	const run = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await fn();
			return true;
		} catch (e) {
			toast.add({ title: e instanceof Error ? e.message : "Something went wrong", variant: "error" });
			return false;
		} finally {
			setBusy(false);
		}
	};

	if (me && !isAdmin) return <AdminShell isAdmin={false}><Text>{peopleCopy.adminOnly}</Text></AdminShell>;

	return (
		<AdminShell isAdmin>
			<PageHeading
				title={copy.title}
				intro={copy.intro}
				action={(
					<a href={copy.guideUrl} target="_blank" rel="noreferrer" className="no-underline">
						<Button variant="secondary" icon={<BookOpenTextIcon size={16} />}>{copy.guide}</Button>
					</a>
				)}
			/>
			{isLoading || !data ? (
				<div className="flex justify-center py-20">{error ? <Text variant="error">{(error as Error).message}</Text> : <Loader size="lg" />}</div>
			) : (<>
				{!data.apiOn && (
					<div className="mb-5 flex gap-3 rounded-2xl border border-kumo-line bg-kumo-base px-5 py-4 text-base text-kumo-default">
						<WarningIcon size={20} className="mt-0.5 shrink-0 text-kumo-warning" />
						<p>{copy.off}</p>
					</div>
				)}

				<div className="mb-8 rounded-2xl border border-kumo-line bg-kumo-base px-5 py-4 shadow-sm">
					<div className="text-sm font-semibold text-kumo-default">{copy.address}</div>
					<div className="mt-2 flex flex-wrap items-center gap-2">
						<code className="min-w-0 flex-1 break-all rounded-lg bg-kumo-recessed px-3 py-2 font-mono text-[15px] text-kumo-default">{data.baseUrl}</code>
						<CopyButton text={data.baseUrl} />
					</div>
					<p className="mt-2 text-sm text-kumo-subtle">{copy.addressHelp}</p>
				</div>

				{/* API keys */}
				<Section
					title={copy.keys.title}
					intro={copy.keys.intro}
					action={<Button variant="primary" icon={<PlusIcon size={16} />} disabled={data.keys.length >= data.limits.keys} onClick={() => setNewKey(true)}>{copy.keys.new}</Button>}
				>
					{data.keys.length === 0 ? (
						<Empty icon={<KeyIcon size={36} weight="thin" />} title={copy.keys.emptyTitle} text={copy.keys.empty} />
					) : (<>
						<Find list={keyList} label={copy.keys.find} />
						<Headings columns={KEY_COLUMNS} labels={[copy.keys.columns.name, copy.keys.columns.can, copy.keys.columns.mailboxes, copy.keys.columns.used]} />
						{keyList.shown.map((k, i) => (
							<Row key={k.id} columns={KEY_COLUMNS} first={i === 0}>
								<div className="min-w-0">
									<div className="truncate text-base font-semibold text-kumo-default">{k.name}</div>
									<div className="truncate font-mono text-sm text-kumo-subtle">{k.hint}</div>
								</div>
								<div className="justify-self-end md:order-last">
									<Menu label={fill(copy.keys.menu, { name: k.name })} items={[{
										label: copy.keys.delete, danger: true,
										onClick: () => setConfirm({
											title: fill(copy.keys.deleteTitle, { name: k.name }), body: copy.keys.deleteBody, done: copy.keys.deleted,
											run: () => api.deleteApiKey(k.id),
										}),
									}]} />
								</div>
								<Details>
									<div className="flex flex-wrap gap-1.5">
										{k.scopes.map((s) => <Pill key={s} tone={SCOPE_TONE[s]} title={copy.scopeHelp[s]}>{copy.scopes[s]}</Pill>)}
									</div>
									<div className="min-w-0 basis-full text-sm text-kumo-default md:basis-auto md:truncate" title={k.mailboxes.join(", ")}>{shortList(k.mailboxes, 1)}</div>
									<div className="text-sm text-kumo-subtle">
										{k.lastUsedAt ? day(k.lastUsedAt) : copy.keys.never}
									</div>
								</Details>
							</Row>
						))}
						<ShowMoreButton list={keyList} className="mx-5 my-3" />
					</>)}
				</Section>

				{/* Webhooks */}
				<Section
					title={copy.webhooks.title}
					intro={copy.webhooks.intro}
					action={<Button variant="primary" icon={<PlusIcon size={16} />} disabled={data.webhooks.length >= data.limits.webhooks} onClick={() => setNewHook(true)}>{copy.webhooks.new}</Button>}
				>
					{data.webhooks.length === 0 ? (
						<Empty icon={<WebhooksLogoIcon size={36} weight="thin" />} title={copy.webhooks.emptyTitle} text={copy.webhooks.empty} />
					) : (<>
						<Find list={hookList} label={copy.webhooks.find} />
						<Headings columns={HOOK_COLUMNS} labels={[copy.webhooks.columns.name, copy.webhooks.columns.when, copy.webhooks.columns.mailboxes, copy.webhooks.columns.status]} />
						{hookList.shown.map((w, i) => (
							<Row key={w.id} columns={HOOK_COLUMNS} first={i === 0}>
								<div className="min-w-0">
									<div className="truncate text-base font-semibold text-kumo-default">{w.name}</div>
									<div className="truncate text-sm text-kumo-subtle" title={w.url}>{w.url}</div>
								</div>
								<div className="justify-self-end md:order-last">
									<Menu label={fill(copy.webhooks.menu, { name: w.name })} items={[
										{ label: copy.webhooks.test, onClick: () => run(async () => {
											const r = await api.testWebhook(w.id);
											toast.add(r.ok
												? { title: fill(copy.webhooks.testOk, { status: String(r.status) }) }
												: { title: fill(copy.webhooks.testFailed, { error: r.error ?? String(r.status) }), variant: "error" });
											await qc.invalidateQueries({ queryKey: queryKeys.deliveries(w.id) });
										}) },
										{ label: copy.webhooks.log, onClick: () => setLogFor(w) },
										{ label: copy.webhooks.secret, onClick: () => setShownSecret(w) },
										{ label: w.paused ? copy.webhooks.resume : copy.webhooks.pause, onClick: () => run(async () => { await api.pauseWebhook(w.id, !w.paused); await refresh(); }) },
										{ label: copy.webhooks.delete, danger: true, onClick: () => setConfirm({
											title: fill(copy.webhooks.deleteTitle, { name: w.name }), body: fill(copy.webhooks.deleteBody, { url: w.url }), done: copy.webhooks.deleted,
											run: () => api.deleteWebhook(w.id),
										}) },
									]} />
								</div>
								<Details>
									<div className="flex flex-wrap gap-1.5">
										{w.events.map((e) => <Pill key={e} tone={e === "email.received" ? "blue" : "violet"}>{copy.events[e]}</Pill>)}
									</div>
									<div className="min-w-0 basis-full text-sm text-kumo-default md:basis-auto md:truncate" title={w.mailboxes.join(", ")}>
										{w.mailboxes.length ? shortList(w.mailboxes, 1) : <span className="text-kumo-subtle">{copy.webhooks.all}</span>}
									</div>
									<div>{w.paused ? <Pill tone="grey" dot>{copy.webhooks.paused}</Pill> : <Pill tone="green" dot>{copy.webhooks.active}</Pill>}</div>
								</Details>
							</Row>
						))}
						<ShowMoreButton list={hookList} className="mx-5 my-3" />
					</>)}
				</Section>
			</>)}

			{newKey && data && (
				<NewKeyDialog
					mailboxes={data.mailboxes}
					onClose={() => setNewKey(false)}
					onMade={async (key) => { setNewKey(false); setShownKey(key); await refresh(); }}
				/>
			)}
			{newHook && data && (
				<NewWebhookDialog
					mailboxes={data.mailboxes}
					onClose={() => setNewHook(false)}
					onMade={async (hook) => { setNewHook(false); setShownSecret(hook); await refresh(); }}
				/>
			)}

			{shownKey && (
				<Shown title={copy.newKey.shownTitle} body={copy.newKey.shownBody} value={shownKey} done={copy.newKey.done} onClose={() => setShownKey(null)} />
			)}
			{shownSecret && (
				<Shown
					title={fill(copy.secret.title, { name: shownSecret.name })}
					body={copy.secret.body}
					value={shownSecret.secret}
					done={copy.secret.close}
					onClose={() => setShownSecret(null)}
				/>
			)}
			{logFor && <DeliveryLog hook={logFor} onClose={() => setLogFor(null)} />}

			{confirm && (
				<Dialog.Root open onOpenChange={(open) => { if (!open) setConfirm(null); }}>
					<Dialog size="sm" className="p-6">
						<Dialog.Title className="text-lg font-semibold mb-2">{confirm.title}</Dialog.Title>
						<Dialog.Description className="text-kumo-subtle text-base mb-5 break-words">{confirm.body}</Dialog.Description>
						<div className="flex justify-end gap-2">
							<Dialog.Close render={(props) => <Button {...props} variant="secondary">{copy.newKey.cancel}</Button>} />
							<Button variant="destructive" loading={busy} onClick={() => run(async () => {
								await confirm.run();
								toast.add({ title: confirm.done });
								setConfirm(null);
								await refresh();
							})}>{adminCopy.mailboxes.actions.delete}</Button>
						</div>
					</Dialog>
				</Dialog.Root>
			)}
		</AdminShell>
	);
}

function CopyButton({ text }: { text: string }) {
	const [done, setDone] = useState(false);
	return (
		<Button
			variant="secondary"
			icon={done ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
			onClick={() => {
				void navigator.clipboard?.writeText(text);
				setDone(true);
				setTimeout(() => setDone(false), 2000);
			}}
		>
			{done ? copy.copied : copy.copy}
		</Button>
	);
}

function Ticks<T extends string>({ label, options, picked, onPicked, describe }: {
	label: string;
	options: T[];
	picked: Set<T>;
	onPicked: (next: Set<T>) => void;
	describe: (option: T) => { name: string; help?: string };
}) {
	// The box scrolls, so nothing is folded away, but a long list of mailboxes gets a Find box.
	const list = useShowMore(options, { limit: Infinity, text: (o) => describe(o).name });
	return (
		<fieldset>
			<legend className="mb-2 text-sm font-semibold text-kumo-default">{label}</legend>
			<FindBox list={list} className="mb-2" />
			<div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-kumo-line p-2">
				{list.shown.map((o) => {
					const { name, help } = describe(o);
					return (
						<label key={o} className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 hover:bg-kumo-tint">
							<input
								type="checkbox"
								className="mt-1 size-4 shrink-0 accent-kumo-brand"
								checked={picked.has(o)}
								onChange={(e) => {
									const next = new Set(picked);
									if (e.target.checked) next.add(o); else next.delete(o);
									onPicked(next);
								}}
							/>
							<span className="min-w-0">
								<span className="block break-all text-base text-kumo-default">{name}</span>
								{help && <span className="block text-sm text-kumo-subtle">{help}</span>}
							</span>
						</label>
					);
				})}
			</div>
		</fieldset>
	);
}

function NewKeyDialog({ mailboxes, onClose, onMade }: { mailboxes: string[]; onClose: () => void; onMade: (key: string) => void }) {
	const f = copy.newKey;
	const [name, setName] = useState("");
	const [scopes, setScopes] = useState<Set<Scope>>(new Set(["read"]));
	const [picked, setPicked] = useState<Set<string>>(new Set(mailboxes.length === 1 ? mailboxes : []));
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		setSaving(true);
		try {
			const r = await api.createApiKey({ name: name.trim(), scopes: [...scopes], mailboxes: [...picked] });
			onMade(r.key);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong");
		} finally {
			setSaving(false);
		}
	};
	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-lg font-semibold mb-4">{f.title}</Dialog.Title>
				<form onSubmit={submit} className="space-y-4">
					{error && <Text variant="error">{error}</Text>}
					<Input label={f.name} placeholder={f.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} required />
					<Ticks label={f.can} options={SCOPES} picked={scopes} onPicked={setScopes} describe={(s) => ({ name: copy.scopes[s], help: copy.scopeHelp[s] })} />
					<Ticks label={f.mailboxes} options={mailboxes} picked={picked} onPicked={setPicked} describe={(m) => ({ name: m })} />
					<div className="flex justify-end gap-2 pt-1">
						<Button type="button" variant="secondary" onClick={onClose}>{f.cancel}</Button>
						<Button type="submit" variant="primary" loading={saving}>{f.make}</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

function NewWebhookDialog({ mailboxes, onClose, onMade }: { mailboxes: string[]; onClose: () => void; onMade: (hook: Webhook) => void }) {
	const f = copy.newWebhook;
	const [name, setName] = useState("");
	const [url, setUrl] = useState("https://");
	const [events, setEvents] = useState<Set<WebhookEvent>>(new Set(["email.received"]));
	const [every, setEvery] = useState(true);
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		setSaving(true);
		try {
			onMade(await api.createWebhook({ name: name.trim(), url: url.trim(), events: [...events], mailboxes: every ? [] : [...picked] }));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong");
		} finally {
			setSaving(false);
		}
	};
	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-lg font-semibold mb-4">{f.title}</Dialog.Title>
				<form onSubmit={submit} className="space-y-4">
					{error && <Text variant="error">{error}</Text>}
					<Input label={f.url} placeholder={f.urlPlaceholder} value={url} onChange={(e) => setUrl(e.target.value)} required />
					<Input label={f.name} placeholder={f.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
					<Ticks label={f.when} options={WEBHOOK_EVENTS} picked={events} onPicked={setEvents} describe={(ev) => ({ name: copy.events[ev] })} />
					<fieldset>
						<legend className="mb-2 text-sm font-semibold text-kumo-default">{f.mailboxes}</legend>
						<label className="flex items-center gap-3 py-1 text-base text-kumo-default">
							<input type="radio" name="which" className="size-4 accent-kumo-brand" checked={every} onChange={() => setEvery(true)} />{f.allMailboxes}
						</label>
						<label className="flex items-center gap-3 py-1 text-base text-kumo-default">
							<input type="radio" name="which" className="size-4 accent-kumo-brand" checked={!every} onChange={() => setEvery(false)} />{f.someMailboxes}
						</label>
					</fieldset>
					{!every && <Ticks label={f.someMailboxes} options={mailboxes} picked={picked} onPicked={setPicked} describe={(m) => ({ name: m })} />}
					<div className="flex justify-end gap-2 pt-1">
						<Button type="button" variant="secondary" onClick={onClose}>{f.cancel}</Button>
						<Button type="submit" variant="primary" loading={saving}>{f.make}</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

/** A key or secret, with a Copy button. */
function Shown({ title, body, value, done, onClose }: { title: string; body: string; value: string; done: string; onClose: () => void }) {
	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-lg font-semibold mb-2 break-words">{title}</Dialog.Title>
				<Dialog.Description className="text-base text-kumo-subtle mb-4">{body}</Dialog.Description>
				<code className="mb-3 block break-all rounded-lg bg-kumo-recessed px-3 py-3 font-mono text-[15px] text-kumo-default">{value}</code>
				<div className="flex justify-end gap-2">
					<CopyButton text={value} />
					<Button variant="primary" onClick={onClose}>{done}</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

function DeliveryLog({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
	const { data, isLoading } = useQuery({ queryKey: queryKeys.deliveries(hook.id), queryFn: () => api.getDeliveries(hook.id) });
	const deliveries = data?.deliveries ?? [];
	const log = useShowMore(deliveries, { limit: 10, text: (d) => `${d.status} ${copy.events[d.event]} ${d.error ?? ""} ${when(d.at)}` });
	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="lg" className="p-6">
				<Dialog.Title className="text-lg font-semibold mb-1 break-words">{fill(copy.log.title, { name: hook.name })}</Dialog.Title>
				<Dialog.Description className="text-base text-kumo-subtle mb-4">{copy.log.intro}</Dialog.Description>
				{isLoading ? (
					<div className="flex justify-center py-8"><Loader /></div>
				) : deliveries.length === 0 ? (
					<p className="py-6 text-center text-base text-kumo-subtle">{copy.log.empty}</p>
				) : (<>
					<FindBox list={log} label={copy.log.find} className="mb-3" />
					<ul className="max-h-96 divide-y divide-kumo-line overflow-y-auto rounded-xl border border-kumo-line">
						{log.shown.map((d) => (
							<li key={`${d.id}-${d.attempt}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
								<Pill tone={d.ok ? "green" : "red"} dot>{d.status || "—"}</Pill>
								<span className="text-base text-kumo-default">{copy.events[d.event]}</span>
								<span className="text-sm text-kumo-subtle">{fill(copy.log.try, { attempt: String(d.attempt) })} · {d.ms} ms</span>
								<span className="ml-auto text-sm text-kumo-subtle">{when(d.at)}</span>
								{d.error && <span className="basis-full text-sm text-kumo-danger">{d.error}</span>}
							</li>
						))}
					</ul>
					<ShowMoreButton list={log} className="mt-3" />
				</>)}
				<div className="mt-4 flex justify-end">
					<a href={`${copy.guideUrl}#webhooks`} target="_blank" rel="noreferrer" className="mr-auto inline-flex items-center gap-1 self-center text-sm text-kumo-link">
						{copy.guide} <ArrowSquareOutIcon size={14} />
					</a>
					<Button variant="secondary" onClick={onClose}>{copy.log.close}</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

/** The Find box at the top of a table, when the table is long enough to need one. */
function Find({ list, label }: { list: Parameters<typeof FindBox>[0]["list"]; label: string }) {
	if (!list.canFind) return null;
	return (
		<div className="border-b border-kumo-line px-4 py-3 sm:px-5">
			<FindBox list={list} label={label} className="w-full max-w-sm" />
		</div>
	);
}
