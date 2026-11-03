// Mail App addition (not part of upstream Agentic Inbox).
// The People page (admins only): who can sign in, which mailboxes each person uses, invites, pausing
// and removing people. It sits in the admin area's frame, with everyone in a
// table (role, status, mailboxes). Wording lives in app/copy/people.en-GB.json.
import { Button, Dialog, DropdownMenu, Input, Loader, Text, useKumoToastManager } from "@cloudflare/kumo";
import { CrownSimpleIcon, DotsThreeVerticalIcon, KeyIcon, PlusIcon, UploadSimpleIcon, UserIcon, WarningIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useMemo, useState } from "react";
import AdminShell, { Initial, PageHeading, Pill, type Tone } from "~/components/AdminShell";
import copy from "~/copy/people.en-GB.json";
import { fill } from "~/lib/attachments";
import { queryKeys } from "~/queries/keys";
import { useMe, usePeople } from "~/queries/people";
import api, { type InviteResult, type PersonView, type SignInState } from "~/services/api";
import type { Role } from "shared/people";
import SendingCard from "~/components/SendingCard";
import UserImport from "~/components/UserImport";
import { FindBox, ShowMoreButton, shortList, useShowMore } from "~/components/ShowMore";
import { pageTitle } from "~/lib/brand";

export function meta({ matches }: { matches: readonly unknown[] }) {
	return [{ title: pageTitle(matches, copy.title) }];
}

const when = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const STATUS_TONE: Record<PersonView["status"], Tone> = { invited: "amber", active: "green", suspended: "red" };
const COLUMNS = "md:grid-cols-[minmax(0,2.2fr)_8rem_8rem_minmax(0,1.6fr)_3rem]";
const field = "w-full rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring";

type Confirm = { kind: "reset" | "suspend"; person: PersonView };

export default function PeopleRoute() {
	const { data: me } = useMe();
	const isAdmin = me?.role === "admin";
	const { data, isLoading, error } = usePeople(isAdmin);
	const { data: config } = useQuery({ queryKey: queryKeys.config, queryFn: () => api.getConfig(), staleTime: Infinity });
	const qc = useQueryClient();
	const toast = useKumoToastManager();
	const [inviting, setInviting] = useState(false);
	const [importing, setImporting] = useState(false);
	const [editing, setEditing] = useState<PersonView | null>(null);
	const [removing, setRemoving] = useState<PersonView | null>(null);
	const [confirm, setConfirm] = useState<Confirm | null>(null);
	const [keyOpen, setKeyOpen] = useState(false);
	const [sent, setSent] = useState<{ email: string; result: InviteResult } | null>(null);
	const [signIn, setSignIn] = useState<SignInState | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = async (state?: SignInState) => {
		if (state) setSignIn(state);
		await Promise.all([
			qc.invalidateQueries({ queryKey: queryKeys.people }),
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all }),
			qc.invalidateQueries({ queryKey: queryKeys.me }),
		]);
	};
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

	// A big team's list shows its first ten, with "Show all" and a "Find…" box.
	const peopleList = useShowMore(data?.people ?? [], { limit: 10, text: (p) => `${p.name} ${p.email}` });

	if (me && !isAdmin) {
		return <Shell isAdmin={false}><Text>{copy.adminOnly}</Text></Shell>;
	}
	if (isLoading || !data || !me) {
		return <Shell isAdmin={!!me}>{error ? <Text variant="error">{(error as Error).message}</Text> : <div className="flex justify-center py-20"><Loader size="lg" /></div>}</Shell>;
	}

	const state = signIn ?? data.signIn;
	const { plan } = data;
	const full = plan.count >= plan.limit;

	return (
		<Shell isAdmin>
			<PageHeading
				title={copy.title}
				intro={copy.intro}
				action={<>
					<Button variant="secondary" icon={<UploadSimpleIcon size={16} />} disabled={full} onClick={() => setImporting(true)}>{copy.importButton}</Button>
					<Button variant="primary" icon={<PlusIcon size={16} />} disabled={full} onClick={() => setInviting(true)}>{copy.invite}</Button>
				</>}
			/>
			<SendingCard className="mb-4" />

			{full && <p className="mb-4 text-sm text-kumo-subtle">{fill(copy.plan.full, { limit: String(plan.limit) })}</p>}

			{/* Cloudflare sign-in list */}
			{(!state.automatic || state.error) && (
				<div className="mb-4 flex gap-3 rounded-xl border border-kumo-line bg-kumo-base px-4 py-3 text-sm text-kumo-default">
					<WarningIcon size={18} className="shrink-0 mt-0.5 text-kumo-warning" />
					<div className="min-w-0 flex-1">
						{state.error ? fill(copy.signIn.failed, { error: state.error }) : <ManualSignIn />}
					</div>
					{!state.automatic && !state.error && (
						<Button size="sm" variant="secondary" icon={<KeyIcon size={14} />} onClick={() => setKeyOpen(true)}>{copy.signIn.setUp}</Button>
					)}
					{state.error && (
						<Button size="sm" variant="secondary" loading={busy} onClick={() => run(async () => {
							const r = await api.retrySignInSync();
							setSignIn(r.signIn);
							if (r.ok) toast.add({ title: copy.signIn.done });
						})}>{copy.signIn.retry}</Button>
					)}
				</div>
			)}

			{/* An invite that couldn't be emailed from here */}
			{sent && !sent.result.sent && (
				<div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base px-4 py-3 text-sm">
					<p className="text-kumo-default mb-2">{fill(copy.inviteNotSent, { error: sent.result.error, email: sent.email })}</p>
					<textarea readOnly rows={8} className={field} value={`${sent.result.subject}\n\n${sent.result.text}`} />
					<div className="mt-2 flex justify-end gap-2">
						<Button size="sm" variant="ghost" onClick={() => setSent(null)}>{copy.form.cancel}</Button>
						<Button size="sm" variant="secondary" onClick={() => {
							if (sent.result.sent) return;
							void navigator.clipboard?.writeText(`${sent.result.subject}\n\n${sent.result.text}`);
							toast.add({ title: copy.copied });
						}}>{copy.copy}</Button>
					</div>
				</div>
			)}

			{/* Everyone */}
			<div className="rounded-2xl border border-kumo-line bg-kumo-base shadow-sm">
				<div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
					<FindBox list={peopleList} label={copy.find} className="w-full sm:w-80" />
					<span className="ml-auto text-sm text-kumo-subtle">{fill(copy.plan.count, { count: String(plan.count), limit: String(plan.limit) })}</span>
				</div>
				<div className={`hidden md:grid ${COLUMNS} items-center gap-4 border-y border-kumo-line bg-kumo-recessed px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle`}>
					<span>{copy.columns.person}</span>
					<span>{copy.columns.role}</span>
					<span>{copy.columns.status}</span>
					<span>{copy.columns.mailboxes}</span>
					<span />
				</div>
				<div className={peopleList.shown.length ? "" : "hidden"}>
				{peopleList.shown.map((p, i) => (
					<div key={p.email} className={`grid grid-cols-[minmax(0,1fr)_auto] ${COLUMNS} items-center gap-x-4 gap-y-2 px-4 py-4 sm:px-5 ${i > 0 ? "border-t border-kumo-line" : "border-t border-kumo-line md:border-t-0"}`}>
						<div className="flex min-w-0 items-center gap-3.5">
							<Initial name={p.name} size={42} />
							<div className="min-w-0">
								<div className="truncate text-base font-semibold text-kumo-default">{p.name}{p.email === me.email ? ` (${copy.you})` : ""}</div>
								<div className="truncate text-sm text-kumo-subtle">{p.email}</div>
								<div className="mt-0.5 text-xs text-kumo-subtle">
									{p.lastSeenAt ? fill(copy.lastSeen, { when: when(p.lastSeenAt) }) : copy.neverSeen}
								</div>
							</div>
						</div>
						<div className="justify-self-end md:order-last">
						<PersonMenu
							person={p}
							isMe={p.email === me.email}
							isOwner={p.email === data.owner}
							onEdit={() => setEditing(p)}
							onRole={(role) => run(async () => { const r = await api.changePerson(p.email, { role }); await refresh(r.signIn); })}
							onResend={() => run(async () => { const r = await api.resendInvite(p.email); setSent({ email: p.email, result: r.invite }); if (r.invite.sent) toast.add({ title: fill(copy.inviteSent, { email: p.email }) }); })}
							onReset={() => setConfirm({ kind: "reset", person: p })}
							onSuspend={() => setConfirm({ kind: "suspend", person: p })}
							onUnsuspend={() => run(async () => { const r = await api.changePerson(p.email, { status: "active" }); await refresh(r.signIn); })}
							onRemove={() => setRemoving(p)}
						/>
						</div>
						<div className="col-span-2 flex flex-wrap items-center gap-2 pl-[3.5rem] md:contents md:pl-0">
							<div>
								{p.email === data.owner
									? <Pill tone="grey" icon={<CrownSimpleIcon size={15} />} title={copy.roleHelp.admin}>{copy.owner}</Pill>
									: <Pill tone="grey" icon={<UserIcon size={15} />} title={copy.roleHelp[p.role]}>{copy.roles[p.role]}</Pill>}
							</div>
							<div><Pill tone={STATUS_TONE[p.status]} dot>{copy.status[p.status]}</Pill></div>
							<div className="min-w-0 basis-full text-sm text-kumo-default md:basis-auto md:truncate" title={p.mailboxes.join(", ")}>
								{p.mailboxes.length ? shortList(p.mailboxes, 2) : <span className="text-kumo-subtle">{copy.noMailbox}</span>}
							</div>
						</div>
					</div>
				))}
				</div>
				{peopleList.canFold && (
					<div className="border-t border-kumo-line px-5 py-3">
						<ShowMoreButton list={peopleList} />
					</div>
				)}
			</div>

			{inviting && (
				<InviteDialog
					mailboxes={data.mailboxes}
					people={data.people}
					domains={config?.domains ?? []}
					onClose={() => setInviting(false)}
					onDone={async (email, result, state) => {
						setInviting(false);
						setSent({ email, result });
						if (result.sent) toast.add({ title: fill(copy.inviteSent, { email }) });
						await refresh(state);
					}}
				/>
			)}

			{importing && (
				<UserImport
					page={data}
					domains={config?.domains ?? []}
					onClose={() => setImporting(false)}
					onDone={(state) => refresh(state)}
				/>
			)}

			{editing && (
				<MailboxesDialog
					person={editing}
					mailboxes={data.mailboxes}
					people={data.people}
					onClose={() => setEditing(null)}
					onSave={(mailboxes) => run(async () => {
						const r = await api.changePerson(editing.email, { mailboxes });
						setEditing(null);
						await refresh(r.signIn);
					})}
					busy={busy}
				/>
			)}

			{confirm && (
				<Dialog.Root open onOpenChange={(open) => { if (!open) setConfirm(null); }}>
					<Dialog size="sm" className="p-6">
						<Dialog.Title className="text-base font-semibold mb-2">
							{fill(copy[confirm.kind].title, { name: confirm.person.name })}
						</Dialog.Title>
						<Dialog.Description className="text-kumo-subtle text-sm mb-5">
							{fill(copy[confirm.kind].body, { email: confirm.person.email })}
						</Dialog.Description>
						<div className="flex justify-end gap-2">
							<Dialog.Close render={(props) => <Button {...props} variant="secondary" size="sm">{copy.form.cancel}</Button>} />
							<Button variant={confirm.kind === "suspend" ? "destructive" : "primary"} size="sm" loading={busy} onClick={() => run(async () => {
								const { kind, person } = confirm;
								if (kind === "reset") {
									const r = await api.resendInvite(person.email, true);
									setSent({ email: person.email, result: r.invite });
									if (r.invite.sent) toast.add({ title: fill(copy.inviteSent, { email: person.email }) });
								} else {
									const r = await api.changePerson(person.email, { status: "suspended" });
									await refresh(r.signIn);
								}
								setConfirm(null);
							})}>
								{copy[confirm.kind].confirm}
							</Button>
						</div>
					</Dialog>
				</Dialog.Root>
			)}

			{removing && (
				<RemoveDialog
					person={removing}
					others={data.people.filter((p) => p.email !== removing.email && p.status !== "suspended")}
					busy={busy}
					onClose={() => setRemoving(null)}
					onRemove={(what, handTo) => run(async () => {
						const r = await api.removePerson(removing.email, what, handTo);
						setRemoving(null);
						await refresh(r.signIn);
					})}
				/>
			)}

			{keyOpen && (
				<AccessKeyDialog
					accountId={state.accountId}
					onClose={() => setKeyOpen(false)}
					onSaved={(s) => { setKeyOpen(false); setSignIn(s); }}
				/>
			)}

		</Shell>
	);
}

function Shell({ isAdmin, children }: { isAdmin: boolean; children: React.ReactNode }) {
	return <AdminShell isAdmin={isAdmin}>{children}</AdminShell>;
}

function ManualSignIn() {
	return <>{copy.signIn.manual} <a href="https://github.com/pobren/mail-app#cloudflare-access" target="_blank" rel="noreferrer" className="font-medium text-kumo-link">{copy.signIn.howTo}</a></>;
}

function PersonMenu(props: {
	person: PersonView;
	isMe: boolean;
	isOwner: boolean;
	onEdit: () => void;
	onRole: (role: Role) => void;
	onResend: () => void;
	onReset: () => void;
	onSuspend: () => void;
	onUnsuspend: () => void;
	onRemove: () => void;
}) {
	const { person: p, isOwner } = props;
	// The owner can't be made a member, paused or removed.
	const isMe = props.isMe || isOwner;
	const a = copy.actions;
	return (
		<DropdownMenu>
			<DropdownMenu.Trigger>
				<Button variant="secondary" size="sm" shape="square" aria-label={fill(a.menu, { name: p.name })} icon={<DotsThreeVerticalIcon size={18} weight="bold" />} />
			</DropdownMenu.Trigger>
			<DropdownMenu.Content>
				<DropdownMenu.Item onClick={props.onEdit}>{a.edit}</DropdownMenu.Item>
				{!isMe && <DropdownMenu.Item onClick={() => props.onRole(p.role === "admin" ? "member" : "admin")}>{p.role === "admin" ? a.makeMember : a.makeAdmin}</DropdownMenu.Item>}
				{p.status === "invited" && <DropdownMenu.Item onClick={props.onResend}>{a.resend}</DropdownMenu.Item>}
				{p.status === "active" && !props.isMe && <DropdownMenu.Item onClick={props.onReset}>{a.reset}</DropdownMenu.Item>}
				{p.status !== "suspended" && !isMe && <DropdownMenu.Item onClick={props.onSuspend}>{a.suspend}</DropdownMenu.Item>}
				{p.status === "suspended" && <DropdownMenu.Item onClick={props.onUnsuspend}>{a.unsuspend}</DropdownMenu.Item>}
				{!isMe && <DropdownMenu.Item onClick={props.onRemove}>{a.remove}</DropdownMenu.Item>}
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}

function InviteDialog({ mailboxes, people, domains, onClose, onDone }: {
	mailboxes: string[];
	people: PersonView[];
	domains: string[];
	onClose: () => void;
	onDone: (email: string, result: InviteResult, state: SignInState) => void;
}) {
	const f = copy.form;
	const free = mailboxes;
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<Role>("member");
	const [kind, setKind] = useState<"new" | "existing" | "none">(domains.length ? "new" : free.length ? "existing" : "none");
	const [prefix, setPrefix] = useState("");
	const [domain, setDomain] = useState(domains[0] ?? "");
	const [existing, setExisting] = useState(free[0] ?? "");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		setSaving(true);
		try {
			const r = await api.invitePerson({
				email: email.trim(),
				name: name.trim(),
				role,
				mailboxes: kind === "existing" && existing ? [existing] : [],
				...(kind === "new" ? { newMailbox: { email: `${prefix.trim().toLowerCase()}@${domain}`, name: name.trim() } } : {}),
			});
			onDone(r.person.email, r.invite, r.signIn);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-base font-semibold mb-4">{f.title}</Dialog.Title>
				<form onSubmit={submit} className="space-y-4">
					<Input label={f.name} size="sm" value={name} onChange={(e) => setName(e.target.value)} required />
					<div>
						<Input label={f.email} type="email" size="sm" value={email} onChange={(e) => setEmail(e.target.value)} required />
						<p className="mt-1 text-xs text-kumo-subtle">{f.emailHelp}</p>
					</div>
					<fieldset>
						<legend className="text-sm font-medium text-kumo-default mb-1.5">{f.mailbox}</legend>
						<div className="space-y-2 text-sm text-kumo-default">
							{domains.length > 0 && (
								<label className="flex items-center gap-2"><input type="radio" checked={kind === "new"} onChange={() => setKind("new")} /> {f.newMailbox}</label>
							)}
							{kind === "new" && (
								<div className="flex items-center gap-2 pl-6">
									<div className="flex-1"><Input aria-label="Address prefix" placeholder="anna" size="sm" value={prefix} onChange={(e) => setPrefix(e.target.value)} required /></div>
									<span className="text-kumo-subtle">@</span>
									{domains.length > 1
										? <select aria-label="Domain" className={`${field} flex-1`} value={domain} onChange={(e) => setDomain(e.target.value)}>{domains.map((d) => <option key={d}>{d}</option>)}</select>
										: <span className="text-kumo-subtle">{domain}</span>}
								</div>
							)}
							{free.length > 0 && (
								<label className="flex items-center gap-2"><input type="radio" checked={kind === "existing"} onChange={() => setKind("existing")} /> {f.existingMailbox}</label>
							)}
							{kind === "existing" && (
								<div className="pl-6">
									<select aria-label={f.existingMailbox} className={field} value={existing} onChange={(e) => setExisting(e.target.value)}>
										{free.map((m) => <option key={m}>{m}</option>)}
									</select>
								</div>
							)}
							<label className="flex items-center gap-2"><input type="radio" checked={kind === "none"} onChange={() => setKind("none")} /> {f.noneMailbox}</label>
						</div>
					</fieldset>
					<fieldset>
						<legend className="text-sm font-medium text-kumo-default mb-1.5">{f.role}</legend>
						<div className="space-y-2 text-sm text-kumo-default">
							{(["member", "admin"] as const).map((r) => (
								<label key={r} className="flex items-start gap-2">
									<input type="radio" className="mt-1" checked={role === r} onChange={() => setRole(r)} />
									<span><span className="font-medium">{copy.roles[r]}</span><span className="block text-xs text-kumo-subtle">{copy.roleHelp[r]}</span></span>
								</label>
							))}
						</div>
					</fieldset>
					{error && <Text variant="error" size="sm">{error}</Text>}
					<div className="flex justify-end gap-2 pt-1">
						<Dialog.Close render={(props) => <Button {...props} variant="secondary" size="sm">{f.cancel}</Button>} />
						<Button type="submit" variant="primary" size="sm" loading={saving}>{f.send}</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

function MailboxesDialog({ person, mailboxes, people, busy, onClose, onSave }: {
	person: PersonView;
	mailboxes: string[];
	people: PersonView[];
	busy: boolean;
	onClose: () => void;
	onSave: (mailboxes: string[]) => void;
}) {
	const choices = useMemo(() => [...new Set([...person.mailboxes, ...mailboxes])].sort(), [person, mailboxes]);
	const [picked, setPicked] = useState<string[]>(person.mailboxes);
	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-base font-semibold mb-4">{fill(copy.edit.title, { name: person.name })}</Dialog.Title>
				<div className="max-h-72 space-y-2 overflow-y-auto text-sm text-kumo-default">
					{choices.length === 0 && <p className="text-kumo-subtle">{copy.noMailbox}</p>}
					{choices.map((m) => (
						<label key={m} className="flex items-center gap-2 break-all">
							<input type="checkbox" checked={picked.includes(m)} onChange={(e) => setPicked(e.target.checked ? [...picked, m] : picked.filter((x) => x !== m))} />
							{m}
						</label>
					))}
				</div>
				<div className="flex justify-end gap-2 pt-5">
					<Dialog.Close render={(props) => <Button {...props} variant="secondary" size="sm">{copy.form.cancel}</Button>} />
					<Button variant="primary" size="sm" loading={busy} onClick={() => onSave(picked)}>{copy.edit.save}</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

function RemoveDialog({ person, others, busy, onClose, onRemove }: {
	person: PersonView;
	others: PersonView[];
	busy: boolean;
	onClose: () => void;
	onRemove: (what: "keep" | "hand-over" | "delete", handTo?: string) => void;
}) {
	const r = copy.remove;
	const [what, setWhat] = useState<"keep" | "hand-over" | "delete">("keep");
	const [handTo, setHandTo] = useState(others[0]?.email ?? "");
	const hasMailboxes = person.mailboxes.length > 0;
	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-base font-semibold mb-2">{fill(r.title, { name: person.name })}</Dialog.Title>
				<Dialog.Description className="text-kumo-subtle text-sm mb-4">{hasMailboxes ? r.body : r.bodyNoMailbox}</Dialog.Description>
				{hasMailboxes && (
					<div className="space-y-2 text-sm text-kumo-default mb-2">
						<p className="text-xs text-kumo-subtle break-all">{person.mailboxes.join(", ")}</p>
						<label className="flex items-center gap-2"><input type="radio" checked={what === "keep"} onChange={() => setWhat("keep")} /> {r.keep}</label>
						{others.length > 0 && <label className="flex items-center gap-2"><input type="radio" checked={what === "hand-over"} onChange={() => setWhat("hand-over")} /> {r.handTo}</label>}
						{what === "hand-over" && (
							<div className="pl-6">
								<select aria-label={r.handTo} className={field} value={handTo} onChange={(e) => setHandTo(e.target.value)}>
									{others.map((o) => <option key={o.email} value={o.email}>{o.name} ({o.email})</option>)}
								</select>
							</div>
						)}
						<label className="flex items-center gap-2"><input type="radio" checked={what === "delete"} onChange={() => setWhat("delete")} /> {r.delete}</label>
						{what === "delete" && <p className="pl-6 text-xs text-kumo-danger">{r.deleteWarn}</p>}
					</div>
				)}
				<div className="flex justify-end gap-2 pt-3">
					<Dialog.Close render={(props) => <Button {...props} variant="secondary" size="sm">{copy.form.cancel}</Button>} />
					<Button variant="destructive" size="sm" loading={busy} onClick={() => onRemove(what, what === "hand-over" ? handTo : undefined)}>{r.confirm}</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

function AccessKeyDialog({ accountId, onClose, onSaved }: { accountId: string | null; onClose: () => void; onSaved: (s: SignInState) => void }) {
	const t = copy.signIn;
	const toast = useKumoToastManager();
	const [key, setKey] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const save = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		setSaving(true);
		try {
			const r = await api.saveAccessToken(key.trim());
			toast.add({ title: t.keySaved });
			onSaved(r.signIn);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};
	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-base font-semibold mb-2">{t.keyTitle}</Dialog.Title>
				<Dialog.Description className="text-kumo-subtle text-sm mb-3">{t.keyIntro}</Dialog.Description>
				{accountId ? (
					<form onSubmit={save} className="space-y-3">
						<ol className="list-decimal pl-5 space-y-1 text-sm text-kumo-default">
							{t.keySteps.map((step) => <li key={step}>{step}</li>)}
						</ol>
						<a href={`https://dash.cloudflare.com/${encodeURIComponent(accountId)}/api-tokens`} target="_blank" rel="noreferrer" className="block text-sm font-medium text-kumo-link underline">{t.keyLink}</a>
						<div className="w-full"><Input aria-label={t.keyTitle} className="w-full font-mono text-xs" placeholder={t.keyPlaceholder} value={key} onChange={(e) => setKey(e.target.value)} required /></div>
						{error && <Text variant="error" size="sm">{error}</Text>}
						<div className="flex justify-end gap-2">
							<Dialog.Close render={(props) => <Button {...props} variant="secondary" size="sm">{copy.form.cancel}</Button>} />
							<Button type="submit" variant="primary" size="sm" loading={saving}>{t.keySave}</Button>
						</div>
					</form>
				) : (
					<p className="text-sm text-kumo-default">{t.keyNeedsInstaller}</p>
				)}
			</Dialog>
		</Dialog.Root>
	);
}
