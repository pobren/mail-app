// The pure parts of installing Mail App on someone's Cloudflare account: what to create, in what
// order, and the exact request bodies. No network calls here (see install-run.ts), so it can be
// tested with `node --experimental-strip-types --test site/test`.

import type { DurableObjectMigration, ReleaseManifest } from "./release";

/** Names of what we create on the person's account. Fixed, so re-running finds the same things. */
export const SCRIPT_NAME = "mail-app";
export const BUCKET_NAME = "mail-app";
/** The web app for a real domain lives at <subdomain>.<domain>; "mail" unless the person picks another. */
export const WEB_SUBDOMAIN = "mail";
export const ACCESS_APP_NAME = "Mail App";
/** The one part of the web address open without signing in: /f/, where download links live. */
export const LINKS_APP_NAME = "Mail App: download links";
export const LINKS_POLICY_NAME = "Mail App: anyone with a download link";
export const API_APP_NAME = "Mail App: API";
export const API_POLICY_NAME = "Mail App: apps with an API key";
export const ICONS_APP_NAME = "Mail App: home screen icons";
export const ICONS_POLICY_NAME = "Mail App: anyone loading the app's icons";
export const CHECK_APP_NAME = "Mail App: sign-in check";
export const CHECK_POLICY_NAME = "Mail App: Cloudflare asking who may sign in";
export const PASSKEY_APP_NAME = "Mail App: passkey sign-in";
export const PASSKEY_POLICY_NAME = "Mail App: signing in with a passkey";

export interface InstallChoice {
	accountId: string;
	/** null for "Just try it first": no domain, the app runs on the account's workers.dev address. */
	domain: string | null;
	/** Only with a domain: the part before it in the web address, e.g. "mail" for mail.example.com. */
	subdomain?: string;
	/** Only with a domain: the person agreed to move its email here from another service (see mailToMove). */
	moveMail?: boolean;
	/** The address the person signs in to Mail App with, if not their Cloudflare account's email. */
	signInEmail?: string;
	/** A second address that can sign in and get codes, for when the first one's mail blocks them. */
	backupEmail?: string;
}

export type ActionId = "storage" | "assets" | "worker" | "address" | "email" | "records" | "access" | "sending";

export interface PlanStep {
	id: "storage" | "install" | "email" | "protect" | "sending";
	label: string;
	actions: ActionId[];
}

const ACCOUNT_RE = /^[0-9a-f]{32}$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

export function parseChoice(input: unknown): InstallChoice | null {
	const v = input as { accountId?: unknown; domain?: unknown; subdomain?: unknown; moveMail?: unknown; signInEmail?: unknown; backupEmail?: unknown };
	if (!v || typeof v.accountId !== "string" || !ACCOUNT_RE.test(v.accountId)) return null;
	const signIn = typeof v.signInEmail === "string" ? v.signInEmail.trim().toLowerCase() : "";
	if (signIn && (signIn.length > 254 || !EMAIL_RE.test(signIn))) return null;
	const backup = typeof v.backupEmail === "string" ? v.backupEmail.trim().toLowerCase() : "";
	if (backup && (backup.length > 254 || !EMAIL_RE.test(backup))) return null;
	// A backup only makes sense next to a chosen sign-in address, and only if it's a different one.
	const withBackup = <T extends InstallChoice>(c: T): T => (signIn && backup && backup !== signIn ? { ...c, backupEmail: backup } : c);
	const withSignIn = <T extends InstallChoice>(c: T): T => withBackup(signIn ? { ...c, signInEmail: signIn } : c);
	if (v.domain === null || v.domain === undefined || v.domain === "") return withSignIn({ accountId: v.accountId, domain: null });
	if (typeof v.domain !== "string") return null;
	const domain = v.domain.trim().toLowerCase().replace(/\.$/, "");
	if (!DOMAIN_RE.test(domain)) return null;
	const moveMail = v.moveMail === true;
	if (v.subdomain === null || v.subdomain === undefined || v.subdomain === "") return withSignIn({ accountId: v.accountId, domain, subdomain: WEB_SUBDOMAIN, moveMail });
	if (typeof v.subdomain !== "string") return null;
	const subdomain = v.subdomain.trim().toLowerCase();
	return LABEL_RE.test(subdomain) ? withSignIn({ accountId: v.accountId, domain, subdomain, moveMail }) : null;
}

/** Cloudflare's error code when R2 has never been switched on for the account. */
export const R2_OFF_CODE = 10042;

/**
 * True when Cloudflare refuses an R2 call because R2 isn't switched on for the account yet
 * ("Please enable R2 through the Cloudflare Dashboard."). It has to be switched on once in the
 * dashboard, which asks for a payment card even for the free allowance, so Mail App can't do it.
 */
export function r2NotEnabled(errors: { code: number; message: string }[]): boolean {
	return errors.some((e) => e.code === R2_OFF_CODE || /enable R2|R2.*(enable|purchase|subscri)/i.test(e.message));
}

/** The R2 page in the person's own Cloudflare dashboard, where they switch R2 on. */
export function r2DashboardUrl(accountId: string): string {
	return `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/r2/overview`;
}

export function isActionId(value: unknown): value is ActionId {
	return value === "storage" || value === "assets" || value === "worker" || value === "address" || value === "email" || value === "records" || value === "access" || value === "sending";
}

/** The steps the person sees, each made of one or more server actions, run in order. */
export function planSteps(choice: InstallChoice): PlanStep[] {
	const steps: PlanStep[] = [
		{ id: "storage", label: "Creating storage", actions: ["storage"] },
		{ id: "install", label: "Installing Mail App", actions: ["assets", "worker", "address"] },
	];
	if (choice.domain) {
		steps.push({ id: "email", label: `Switching on email for ${choice.domain}`, actions: ["email", "records"] });
	}
	steps.push({ id: "protect", label: "Setting up sign-in protection", actions: ["access"] });
	// Last, because it may wait for the person to turn on Cloudflare's paid plan (or skip it).
	if (choice.domain) steps.push({ id: "sending", label: `Switching on sending for ${choice.domain}`, actions: ["sending"] });
	return steps;
}

/** Where the web app lives. A trial needs the account's workers.dev subdomain. */
export function webHostname(choice: InstallChoice, workersSubdomain?: string | null): string {
	if (choice.domain) return `${choice.subdomain ?? WEB_SUBDOMAIN}.${choice.domain}`;
	if (!workersSubdomain) throw new Error("No workers.dev subdomain on this account yet.");
	return `${SCRIPT_NAME}.${workersSubdomain}.workers.dev`;
}

// -- Durable Object migrations ----------------------------------------

export interface MigrationsPayload {
	old_tag?: string;
	new_tag: string;
	steps: Omit<DurableObjectMigration, "tag">[];
}

/**
 * Which migrations to send, given the tag the Worker already has (from the scripts list).
 * Mirrors Wrangler: send everything for a new Worker, only the newer steps for an existing one,
 * and nothing when it's already up to date. Returns undefined when there's nothing to send.
 */
export function planMigrations(migrations: DurableObjectMigration[], currentTag: string | null | undefined): MigrationsPayload | undefined {
	if (migrations.length === 0) return undefined;
	const newTag = migrations[migrations.length - 1].tag;
	const strip = (list: DurableObjectMigration[]) => list.map(({ tag: _tag, ...rest }) => rest);
	if (!currentTag) return { new_tag: newTag, steps: strip(migrations) };
	const found = migrations.findIndex((m) => m.tag === currentTag);
	if (found === -1) return { old_tag: currentTag, new_tag: newTag, steps: strip(migrations) };
	if (found === migrations.length - 1) return undefined;
	return { old_tag: currentTag, new_tag: newTag, steps: strip(migrations.slice(found + 1)) };
}

// -- Script upload metadata -------------------------------------------

export type Binding =
	| { type: "r2_bucket"; name: string; bucket_name: string }
	| { type: "durable_object_namespace"; name: string; class_name: string }
	| { type: "send_email"; name: string }
	| { type: "ai"; name: string }
	| { type: "plain_text"; name: string; text: string }
	| { type: "json"; name: string; json: unknown };

export function buildBindings(manifest: ReleaseManifest, choice: InstallChoice): Binding[] {
	const w = manifest.worker;
	const bindings: Binding[] = [{ type: "r2_bucket", name: w.bucketBinding, bucket_name: BUCKET_NAME }];
	for (const d of w.durableObjects) bindings.push({ type: "durable_object_namespace", name: d.name, class_name: d.className });
	for (const name of w.sendEmail) bindings.push({ type: "send_email", name });
	if (w.ai) bindings.push({ type: "ai", name: w.ai });
	// DOMAINS is empty for a trial; the app then has no domain to offer until one is connected.
	bindings.push({ type: "plain_text", name: "DOMAINS", text: choice.domain ?? "" });
	// An empty list lets the person create any mailbox on their domain from the app.
	bindings.push({ type: "json", name: "EMAIL_ADDRESSES", json: [] });
	// Which release this is, so the installer's update command can tell what's running.
	bindings.push({ type: "plain_text", name: "APP_VERSION", text: manifest.version });
	return bindings;
}

export interface ScriptMetadata {
	main_module: string;
	compatibility_date: string;
	compatibility_flags: string[];
	bindings: Binding[];
	/** Keeps POLICY_AUD and TEAM_DOMAIN (set as secrets by the sign-in protection step) on re-runs. */
	keep_bindings: string[];
	assets: { jwt: string };
	migrations?: MigrationsPayload;
	observability: { enabled: boolean };
}

export function buildMetadata(
	manifest: ReleaseManifest,
	choice: InstallChoice,
	opts: { assetsJwt: string; currentMigrationTag: string | null | undefined },
): ScriptMetadata {
	const metadata: ScriptMetadata = {
		main_module: manifest.worker.mainModule,
		compatibility_date: manifest.worker.compatibilityDate,
		compatibility_flags: manifest.worker.compatibilityFlags,
		bindings: buildBindings(manifest, choice),
		keep_bindings: ["secret_text"],
		assets: { jwt: opts.assetsJwt },
		observability: { enabled: true },
	};
	const migrations = planMigrations(manifest.worker.migrations, opts.currentMigrationTag);
	if (migrations) metadata.migrations = migrations;
	return metadata;
}

// -- Static assets ----------------------------------------------------

/** Body for POST .../workers/scripts/:name/assets-upload-session. */
export function assetUploadManifest(manifest: ReleaseManifest): { manifest: Record<string, { hash: string; size: number }> } {
	const out: Record<string, { hash: string; size: number }> = {};
	for (const a of manifest.assets) out[a.path] = { hash: a.hash, size: a.size };
	return { manifest: out };
}

/**
 * Takes whole buckets, in order, until adding the next would go over `maxFiles` (always at least
 * one bucket, so progress is guaranteed). Keeps each request within Cloudflare's limits.
 */
export function takeBuckets(buckets: string[][], maxFiles: number): { now: string[][]; later: string[][] } {
	const nonEmpty = buckets.filter((b) => b.length > 0);
	const now: string[][] = [];
	let count = 0;
	let i = 0;
	for (; i < nonEmpty.length; i++) {
		if (now.length > 0 && count + nonEmpty[i].length > maxFiles) break;
		now.push(nonEmpty[i]);
		count += nonEmpty[i].length;
	}
	return { now, later: nonEmpty.slice(i) };
}

// -- Email routing and Access -----------------------------------------

/** Body for PUT /zones/:zone/email/routing/rules/catch_all. */
export function catchAllRule(): { name: string; enabled: true; matchers: { type: "all" }[]; actions: { type: "worker"; value: string[] }[] } {
	// TODO(confirm): the SDK types confirm `type: "worker"` with `value: string[]`; that the value
	// is the Worker's script name is how the dashboard's "Send to a Worker" stores it, not stated in the docs.
	return { name: "Send all mail to Mail App", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: [SCRIPT_NAME] }] };
}

// -- Adding domains ----------------------------------------------------
/** A catch-all rule that hands mail to Mail App. */
export function isAppCatchAll(rule: { actions?: { type?: string; value?: string[] }[] } | null | undefined): boolean {
	return !!rule?.actions?.some((a) => a.type === "worker" && (a.value ?? []).includes(SCRIPT_NAME));
}

const ROUTING_MX_RE = /(^|\.)mx\.cloudflare\.net\.?$/i;
const PROVIDERS: [RegExp, string][] = [
	[/google(mail)?\.com\.?$|googlemail\.com\.?$/i, "Google"],
	[/outlook\.com\.?$|protection\.outlook\.com\.?$/i, "Microsoft"],
	[/zoho\.(com|eu|in)\.?$/i, "Zoho"],
	[/protonmail\.ch\.?$/i, "Proton"],
	[/fastmail\.com\.?$|messagingengine\.com\.?$/i, "Fastmail"],
	[/icloud\.com\.?$/i, "iCloud"],
];

/**
 * Who handles a domain's email now, from its MX records: null when nobody does or Cloudflare Email
 * Routing does, else a provider's name ("Google") or "another service".
 */
export function mailElsewhere(mxContents: string[]): string | null {
	const hosts = mxContents.map((c) => (c.trim().split(/\s+/).pop() ?? "").toLowerCase()).filter(Boolean);
	const others = hosts.filter((h) => !ROUTING_MX_RE.test(h));
	if (!others.length) return null;
	for (const [re, name] of PROVIDERS) if (others.some((h) => re.test(h))) return name;
	return "another service";
}

/**
 * A name the person will recognise for whoever handles their email now: the provider ("Google"), or
 * failing that the mail server's own domain ("krystal.io" from mx1.krystal.io).
 */
export function mailProviderLabel(mxContents: string[]): string {
	const named = mailElsewhere(mxContents);
	if (named && named !== "another service") return named;
	const host = mxContents.map((c) => (c.trim().split(/\s+/).pop() ?? "").toLowerCase().replace(/\.$/, "")).find((h) => h && !ROUTING_MX_RE.test(h));
	if (!host) return "another service";
	const parts = host.split(".");
	// Keep three labels for names like example.co.uk, two for example.io.
	const keep = parts.length > 2 && parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3 ? 3 : 2;
	return parts.slice(-keep).join(".");
}

interface DnsRecord { id: string; type: string; name: string; content: string }

/**
 * The records to delete when the person agrees to move a domain's email to Mail App: the old service's
 * MX records, and its SPF record (Email Routing adds its own, and a domain may only have one).
 * Only the domain itself, never subdomains, and never Cloudflare's own records.
 */
export function mailToMove(records: DnsRecord[], domain: string): DnsRecord[] {
	const here = (r: DnsRecord) => r.name.toLowerCase().replace(/\.$/, "") === domain;
	return records.filter((r) => {
		if (!here(r)) return false;
		if (r.type === "MX") return !ROUTING_MX_RE.test((r.content.trim().split(/\s+/).pop() ?? "").toLowerCase());
		if (r.type === "TXT") {
			const txt = r.content.replace(/"\s*"/g, "").replace(/^"|"$/g, "").trim();
			return /^v=spf1\b/i.test(txt) && !/_spf\.mx\.cloudflare\.net/i.test(txt);
		}
		return false;
	});
}

/** Email Routing's address rules that forward somewhere: they win over the catch-all, so Mail App never sees that mail. */
export function forwardingRules(rules: { enabled?: boolean; matchers?: { type?: string; field?: string; value?: string }[]; actions?: { type?: string; value?: string[] }[] }[]): { address: string; to: string[] }[] {
	return rules
		.filter((r) => r.enabled !== false && (r.actions ?? []).some((a) => a.type === "forward"))
		.map((r) => ({
			address: (r.matchers ?? []).find((m) => m.type === "literal" && m.field === "to")?.value?.toLowerCase() ?? "",
			to: (r.actions ?? []).filter((a) => a.type === "forward").flatMap((a) => a.value ?? []),
		}))
		.filter((r) => r.address);
}

/** The zone an install's web address is on (the longest matching zone name), e.g. example.com for mail.example.com. */
export function zoneOfHost(host: string, zones: string[]): string | null {
	const h = host.toLowerCase();
	const matches = zones.map((z) => z.toLowerCase()).filter((z) => h === z || h.endsWith(`.${z}`));
	return matches.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** How a sign-in hint we wrote starts, so a later run can tell it's ours and bring it up to date. */
export const SIGN_IN_HINT_START = "Mail App:";

/** An address with most of its name hidden, e.g. s•••@example.co.uk, for a page anyone can open. */
export function maskEmail(email: string): string {
	const [name, domain] = email.trim().toLowerCase().split("@");
	return name && domain ? `${name[0]}•••@${domain}` : "";
}

/**
 * The line shown at the top of Cloudflare's sign-in page. Cloudflare says "code sent" to any address
 * but only really emails ones on the sign-in rule, so people who type another address wait forever.
 */
export function signInHint(owner: string): string {
	const masked = maskEmail(owner);
	return masked
		? `${SIGN_IN_HINT_START} codes are only emailed to addresses allowed in. The owner's is ${masked}.`
		: `${SIGN_IN_HINT_START} codes are only emailed to addresses allowed in.`;
}

/**
 * The account's sign-in page settings with our hint added, or null to leave them alone. The page is
 * shared by every Access app on the account, so someone's own header text is never replaced.
 */
export function withSignInHint(org: Record<string, unknown>, owner: string): Record<string, unknown> | null {
	const design = (org.login_design && typeof org.login_design === "object" ? org.login_design : {}) as Record<string, unknown>;
	const current = typeof design.header_text === "string" ? design.header_text.trim() : "";
	if (current && !current.startsWith(SIGN_IN_HINT_START)) return null;
	const hint = signInHint(owner);
	if (current === hint) return null;
	const { created_at: _c, updated_at: _u, ...rest } = org;
	return { ...rest, login_design: { ...design, header_text: hint } };
}

export function accessPolicyName(email: string): string {
	return `Mail App: only ${email}`;
}

/**
 * How long a sign-in lasts before Cloudflare asks for a new code: 30 days, so Mail App on your Dock or
 * home screen stays signed in, like other mail apps do on your own device.
 */
export const SIGN_IN_LASTS = "720h";

/**
 * Body for POST/PUT /accounts/:id/access/policies (a reusable policy). Lets in the owner and, once
 * they've invited people in Mail App, everyone else on the install's People list.
 */
export function accessPolicy(email: string, others: string[] = []) {
	const emails = [...new Set([email, ...others].map((e) => e.trim().toLowerCase()))].filter(Boolean);
	return { name: accessPolicyName(email), decision: "allow" as const, include: emails.map((e) => ({ email: { email: e } })), session_duration: SIGN_IN_LASTS };
}

/**
 * Who should be able to sign in, on an update. The People list in the install's storage decides
 * (Mail App's People page writes it). If it can't be read, everyone the sign-in rule already lets
 * in stays, so an update never locks anyone out.
 */
export function signInEmails(peopleJson: unknown, currentInclude: unknown): string[] {
	// Same rule as signInList in shared/people.ts: everyone on the list who isn't paused.
	const people = (peopleJson as { people?: unknown } | null)?.people;
	const listed = (Array.isArray(people) ? people : [])
		.filter((p) => p && typeof p === "object" && typeof p.email === "string" && EMAIL_RE.test(p.email.trim().toLowerCase()))
		.map((p: { email: string; status?: unknown }) => ({ email: p.email.trim().toLowerCase(), paused: p.status === "suspended" }));
	if (listed.length) return [...new Set(listed.filter((p) => !p.paused).map((p) => p.email))].sort();
	return (Array.isArray(currentInclude) ? currentInclude : [])
		.map((r) => (r && typeof r === "object" ? (r as { email?: { email?: unknown } }).email?.email : undefined))
		.filter((e): e is string => typeof e === "string");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The token Mail App uses to keep the sign-in list up to date when people are invited or removed. */
export const ACCESS_TOKEN_NAME = "Mail App: sign-in list";

/** Cloudflare permission groups the token needs: change Access policies, and sign people out. */
const ACCESS_TOKEN_PERMISSIONS = ["Access: Apps and Policies Write", "Access: Organizations, Identity Providers, and Groups Write"];

/** Picks the permission groups by name, or null if Cloudflare no longer offers one of them. */
export function accessTokenPermissions(groups: { id: string; name: string }[]): { id: string; name: string }[] | null {
	const picked = ACCESS_TOKEN_PERMISSIONS.map((name) => groups.find((g) => g.name === name));
	return picked.every(Boolean) ? (picked as { id: string; name: string }[]) : null;
}

/** Body for POST /accounts/:id/tokens: an account-owned token that only reaches this account's Access settings. */
export function accessTokenBody(accountId: string, permissions: { id: string; name: string }[]) {
	return {
		name: ACCESS_TOKEN_NAME,
		policies: [{ effect: "allow" as const, resources: { [`com.cloudflare.api.account.${accountId}`]: "*" }, permission_groups: permissions }],
	};
}

/** Body for POST /accounts/:id/access/apps. */
export function accessApp(hostname: string, policyId: string) {
	return {
		type: "self_hosted" as const,
		name: ACCESS_APP_NAME,
		domain: hostname,
		destinations: [{ type: "public" as const, uri: hostname }],
		session_duration: SIGN_IN_LASTS,
		app_launcher_visible: false,
		policies: [{ id: policyId, precedence: 1 }],
	};
}

/** Where download links live: <hostname>/f/<token>. */
export function linksPath(hostname: string): string {
	return `${hostname}/f/*`;
}

/**
 * Body for POST /accounts/:id/access/policies: lets anyone through to the download-link pages without
 * signing in. Only ever attached to the /f/ app below, never to the main one. The files there are
 * encrypted and each link needs its own secret or password, which the Worker checks.
 */
export function linksPolicy() {
	return { name: LINKS_POLICY_NAME, decision: "bypass" as const, include: [{ everyone: {} }] };
}

/** Body for POST /accounts/:id/access/apps. A more specific path than the main app, so it applies to /f/ only. */
export function linksApp(hostname: string, policyId: string) {
	return {
		type: "self_hosted" as const,
		name: LINKS_APP_NAME,
		domain: linksPath(hostname),
		destinations: [{ type: "public" as const, uri: linksPath(hostname) }],
		app_launcher_visible: false,
		policies: [{ id: policyId, precedence: 1 }],
	};
}

// -- API (Settings > API & webhooks) ------------------------------------------
// Other apps call <hostname>/api/ext/v1/... with an API key made by an admin. Cloudflare sign-in can't
// ask an app to sign in, so that one path is let through; the Worker refuses any request without a
// valid key there, and every other path stays behind sign-in.

/** Where the API lives: <hostname>/api/ext/. */
export function apiPath(hostname: string): string {
	return `${hostname}/api/ext/*`;
}

/** Body for POST /accounts/:id/access/policies: lets requests through to /api/ext/, where the Worker checks the key. */
export function apiPolicy() {
	return { name: API_POLICY_NAME, decision: "bypass" as const, include: [{ everyone: {} }] };
}

/** Body for POST /accounts/:id/access/apps. A more specific path than the main app, so it applies to /api/ext/ only. */
export function apiApp(hostname: string, policyId: string) {
	return {
		type: "self_hosted" as const,
		name: API_APP_NAME,
		domain: apiPath(hostname),
		destinations: [{ type: "public" as const, uri: apiPath(hostname) }],
		app_launcher_visible: false,
		policies: [{ id: policyId, precedence: 1 }],
	};
}

// -- Home screen icons (26 Oct 2026) ------------------------------------------
// An iPhone fetches the home screen icon without the sign-in cookie, so behind sign-in it got Cloudflare's
// sign-in page instead and drew a red letter tile. The icon files are public pictures anyway, so they are let
// through without signing in; nothing else is.

/** The icon files, by their exact paths (Mail App's public/ folder and its manifest), so no wildcard is needed. */
export const ICON_FILES = ["apple-touch-icon.png", "apple-touch-icon-precomposed.png", "favicon.ico", "favicon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];

export function iconPaths(hostname: string): string[] {
	return ICON_FILES.map((f) => `${hostname}/${f}`);
}

/** Body for POST /accounts/:id/access/policies: lets anyone load the icons. */
export function iconsPolicy() {
	return { name: ICONS_POLICY_NAME, decision: "bypass" as const, include: [{ everyone: {} }] };
}

/** Body for POST /accounts/:id/access/apps. More specific paths than the main app, so it applies to the icons only. */
export function iconsApp(hostname: string, policyId: string) {
	const paths = iconPaths(hostname);
	return {
		type: "self_hosted" as const,
		name: ICONS_APP_NAME,
		domain: paths[0],
		destinations: paths.map((uri) => ({ type: "public" as const, uri })),
		app_launcher_visible: false,
		policies: [{ id: policyId, precedence: 1 }],
	};
}

/** Mail App's old download-link apps on this domain: named for links, on the domain, and not for the one being kept. */
export function staleLinksApps<T extends { name: string; domain?: string }>(apps: T[], keep: string, domain: string, name = LINKS_APP_NAME): T[] {
	return apps.filter((a) => {
		if (a.name !== name || !a.domain) return false;
		const host = a.domain.split("/")[0];
		return host.toLowerCase() !== keep.toLowerCase() && isWebAddressOn(host, domain);
	});
}

/** A Zero Trust team name for accounts that have never set one up. */
export function teamSlug(accountName: string, random: string): string {
	const base = accountName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mail";
	return `${base}-${random}`.replace(/-+/g, "-");
}

/** TEAM_DOMAIN as the Mail App Worker expects it: the base Access URL. */
export function teamDomainUrl(authDomain: string): string {
	return `https://${authDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

// -- Permissions --------------------------------------------------------

/** Plain names for each scope, as Cloudflare lists them when creating the OAuth client. */
export const PERMISSION_NAMES: Record<string, string> = {
	"workers-scripts.admin": "Workers Admin",
	"workers-r2.write": "Workers R2 Storage Write",
	"workers-routes.write": "Workers Routes Write",
	"ai.read": "Workers AI Read",
	"dns.write": "DNS Write",
	"registrar-domains.read": "Registrar Domains Read",
	"zone.read": "Zone Read",
	"zone-settings.write": "Zone Settings Write",
	"zone-access.write": "Access: Apps and Policies Write (zone)",
	"access.write": "Access: Apps and Policies Write (account)",
	"access-org.write": "Access: Organizations Write",
	"access-idp.write": "Access: Identity Providers Write",
	"user-details.read": "User Details Read",
	"email-routing-address.write": "Email Routing Addresses Write",
	"email-routing-rule.write": "Email Routing Rules Write",
	"email-sending.write": "Email Sending Write",
	"account-api-tokens.write": "Account API Tokens Write",
};

/**
 * Which permissions Mail App asked for but Cloudflare didn't grant, by their plain names.
 * `granted` is the token response's `scope`; when Cloudflare leaves it out we can't tell, so nothing is reported.
 */
export function missingPermissions(required: string, granted: string | undefined | null): string[] {
	if (typeof granted !== "string") return [];
	const have = new Set(granted.split(/\s+/).filter(Boolean));
	return required
		.split(/\s+/)
		.filter((s) => s && !have.has(s))
		.map((s) => PERMISSION_NAMES[s] ?? s);
}

// -- Tidying up after a change of web address --------------------------

/** True for <label>.<domain> (one label), so we only ever touch web addresses on the chosen domain. */
function isWebAddressOn(hostname: string, domain: string): boolean {
	const h = hostname.toLowerCase();
	const suffix = `.${domain.toLowerCase()}`;
	return h.endsWith(suffix) && !h.slice(0, -suffix.length).includes(".");
}

/** Mail App's old web addresses on this domain: attached to our Worker, on the domain, and not the one being kept. */
export function staleWorkerDomains<T extends { hostname: string; service: string }>(domains: T[], keep: string, domain: string): T[] {
	return domains.filter((d) => d.service === SCRIPT_NAME && d.hostname.toLowerCase() !== keep.toLowerCase() && isWebAddressOn(d.hostname, domain));
}

/** Mail App's old sign-in apps on this domain: named "Mail App", on the domain, and not the one being kept. */
export function staleAccessApps<T extends { name: string; domain?: string }>(apps: T[], keep: string, domain: string): T[] {
	return apps.filter((a) => a.name === ACCESS_APP_NAME && !!a.domain && a.domain.toLowerCase() !== keep.toLowerCase() && isWebAddressOn(a.domain, domain));
}

// -- Automatic sign-in list ---------------------------------------------------
// Cloudflare Access asks the install itself whether someone may sign in (an External Evaluation rule),
// so people invited on the People page get in straight away. The Worker answers at /access-check/
// (workers/lib/access-check.ts), which has to be reachable without signing in.

export function checkPath(hostname: string): string {
	return `${hostname}/access-check/*`;
}

/** Body for POST /accounts/:id/access/policies: lets Cloudflare reach /access-check/ without signing in. */
export function checkPolicy() {
	return { name: CHECK_POLICY_NAME, decision: "bypass" as const, include: [{ everyone: {} }] };
}

/** Body for POST /accounts/:id/access/apps. A more specific path than the main app, so it applies to /access-check/ only. */
export function checkApp(hostname: string, policyId: string) {
	return {
		type: "self_hosted" as const,
		name: CHECK_APP_NAME,
		domain: checkPath(hostname),
		destinations: [{ type: "public" as const, uri: checkPath(hostname) }],
		app_launcher_visible: false,
		policies: [{ id: policyId, precedence: 1 }],
	};
}

/**
 * The sign-in rule with the automatic check: the owner always (so they can't be locked out if the
 * check ever fails), plus anyone Mail App says yes to.
 */
export function accessPolicyWithCheck(email: string, hostname: string, also: string[] = []) {
	const base = `https://${hostname}/access-check`;
	const emails = [...new Set([email, ...also].map((e) => e.trim().toLowerCase()))].filter(Boolean);
	return {
		name: accessPolicyName(email),
		decision: "allow" as const,
		include: [
			...emails.map((e) => ({ email: { email: e } })),
			// TODO(confirm): the API shape of an External Evaluation rule, taken from Cloudflare's docs.
			{ external_evaluation: { evaluate_url: `${base}/evaluate`, keys_url: `${base}/keys` } },
		],
		session_duration: SIGN_IN_LASTS,
	};
}

// -- Passkey sign-in ------------------------------------------------------------
// Each install is a small sign-in service of its own at /passkey/ (workers/lib/passkeys.ts). It's added
// to Cloudflare's sign-in page as "Passkey", next to the emailed code, and has to be reachable without
// signing in. Access still checks the address against the sign-in rule, so who may sign in is unchanged.

/** Must match PASSKEY_CLIENT_ID in shared/passkeys.ts. */
export const PASSKEY_CLIENT_ID = "mail-app";
/** What Cloudflare's sign-in page calls the button. */
export const PASSKEY_IDP_NAME = "Passkey";

export function passkeyPath(hostname: string): string {
	return `${hostname}/passkey/*`;
}

/** Body for POST /accounts/:id/access/policies: lets people reach /passkey/ to sign in. */
export function passkeyPolicy() {
	return { name: PASSKEY_POLICY_NAME, decision: "bypass" as const, include: [{ everyone: {} }] };
}

/** Body for POST /accounts/:id/access/apps. A more specific path than the main app, so it applies to /passkey/ only. */
export function passkeyApp(hostname: string, policyId: string) {
	return {
		type: "self_hosted" as const,
		name: PASSKEY_APP_NAME,
		domain: passkeyPath(hostname),
		destinations: [{ type: "public" as const, uri: passkeyPath(hostname) }],
		app_launcher_visible: false,
		policies: [{ id: policyId, precedence: 1 }],
	};
}

interface IdpLike { id?: string; name?: string; type?: string; config?: { auth_url?: unknown } }

/** This install's passkey sign-in on the account, found by its web address so a re-run reuses it. */
export function ourPasskeyIdp<T extends IdpLike>(idps: T[], hostname: string): T | undefined {
	const authUrl = `https://${hostname}/passkey/authorize`;
	return idps.find((i) => i.type === "oidc" && typeof i.config?.auth_url === "string" && i.config.auth_url.toLowerCase() === authUrl.toLowerCase());
}

/** "Passkey", unless another sign-in option on the account already has that name (a second install). */
export function passkeyIdpName(idps: IdpLike[], hostname: string): string {
	const ours = ourPasskeyIdp(idps, hostname);
	const taken = idps.some((i) => i !== ours && i.name === PASSKEY_IDP_NAME);
	return taken ? `${PASSKEY_IDP_NAME} (${hostname})` : PASSKEY_IDP_NAME;
}

/** Body for POST/PUT /accounts/:id/access/identity_providers: a generic OpenID Connect sign-in. */
export function passkeyIdp(hostname: string, clientSecret: string, name: string = PASSKEY_IDP_NAME) {
	const base = `https://${hostname}/passkey`;
	return {
		name,
		type: "oidc" as const,
		// TODO(confirm): field names taken from Cloudflare's API docs for a generic OIDC identity provider.
		config: {
			client_id: PASSKEY_CLIENT_ID,
			client_secret: clientSecret,
			auth_url: `${base}/authorize`,
			token_url: `${base}/token`,
			certs_url: `${base}/keys`,
			scopes: ["openid", "email"],
			email_claim_name: "email",
			pkce_enabled: true,
			claims: [],
		},
	};
}

/** A new random client secret, 32 bytes as hex. */
export function newClientSecret(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cloudflare's reason for refusing a code swap, short and safe to show: its HTTP status and OAuth error code. */
export async function tokenRefusal(res: Response): Promise<string> {
	const body = (await res.json().catch(() => ({}))) as { error?: unknown; error_description?: unknown };
	const code = typeof body.error === "string" ? body.error.replace(/[^\w.-]/g, "").slice(0, 40) : "";
	return code ? `${res.status} ${code}` : String(res.status);
}
