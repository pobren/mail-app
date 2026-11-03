// Runs one install action on the person's Cloudflare account with their OAuth token.
//
// The installer calls these one at a time, so each request stays small,
// progress can be shown step by step, and a failed step can be retried. Every action checks what
// already exists first, so running it again is safe. Nothing is written anywhere but the person's own Cloudflare account.
//
// API references (Cloudflare REST API v4, https://api.cloudflare.com/client/v4):
//  R2 buckets               https://developers.cloudflare.com/api/resources/r2/subresources/buckets/
//  Assets direct upload     https://developers.cloudflare.com/workers/static-assets/direct-upload/
//  Script upload metadata   https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
//  Workers custom domains   https://developers.cloudflare.com/api/resources/workers/subresources/domains/
//  workers.dev subdomain    https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/
//  Email Routing            https://developers.cloudflare.com/api/resources/email_routing/
//  Access apps / policies   https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/
//  DNS records              https://developers.cloudflare.com/api/resources/dns/subresources/records/
//  Worker secrets           https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/

import {
	ACCESS_APP_NAME,
	LINKS_APP_NAME,
	API_APP_NAME,
	ICONS_APP_NAME,
	ICONS_POLICY_NAME,
	iconPaths,
	iconsApp,
	iconsPolicy,
	API_POLICY_NAME,
	apiApp,
	apiPath,
	apiPolicy,
	CHECK_APP_NAME,
	PASSKEY_APP_NAME,
	PASSKEY_CLIENT_ID,
	PASSKEY_POLICY_NAME,
	newClientSecret,
	ourPasskeyIdp,
	passkeyApp,
	passkeyIdp,
	passkeyIdpName,
	passkeyPath,
	passkeyPolicy,
	CHECK_POLICY_NAME,
	accessPolicyWithCheck,
	checkApp,
	checkPath,
	checkPolicy,
	LINKS_POLICY_NAME,
	linksApp,
	linksPath,
	linksPolicy,
	staleLinksApps,
	BUCKET_NAME,
	SCRIPT_NAME,
	accessApp,
	accessPolicy,
	accessPolicyName,
	ACCESS_TOKEN_NAME,
	accessTokenBody,
	accessTokenPermissions,
	signInEmails,
	withSignInHint,
	assetUploadManifest,
	buildMetadata,
	catchAllRule,
	forwardingRules,
	isAppCatchAll,
	mailElsewhere,
	mailProviderLabel,
	mailToMove,
	r2DashboardUrl,
	r2NotEnabled,
	takeBuckets,
	teamDomainUrl,
	teamSlug,
	webHostname,
	staleAccessApps,
	staleWorkerDomains,
	type ActionId,
	type InstallChoice,
} from "./deploy";
import { ROUTING_DKIM_SELECTOR, checkDkim, checkDmarc, checkMx, checkSpf, joinTxt } from "../shared/dns-checks";
import type { SetupCheck } from "../shared/setup";
import { RELEASES_PATH, isReleaseManifest, isSafeVersion, type ReleaseManifest } from "./release";

const API = "https://api.cloudflare.com/client/v4";

/** Asset files uploaded per request. Keeps well inside Workers subrequest limits. */
const ASSET_FILES_PER_REQUEST = 25;

export interface ActionResult {
	ok: boolean;
	/** Plain-English summary for the person. */
	message?: string;
	/** Cloudflare's own wording, shown under "Details". */
	detail?: string;
	/** The assets action needs another call to finish. */
	more?: boolean;
	/** Where the web app lives, once known. */
	hostname?: string;
	/** The records action: each mail record's state, and whether we added it just now. */
	records?: { id: string; status: string; added: boolean }[];
	/** The email action: whether sending to anyone is switched on for the domain (see enableSending). */
	sending?: SendingSetup;
	/** The sending action also checks storage (R2) early: "off" means it needs switching on first. */
	storage?: "ok" | "off" | "unknown";
	/** The email action: the domain's email is at another service, so the page asks before moving it. */
	mailElsewhere?: { provider: string; hosts: string[] };
	/** A page in Cloudflare's dashboard that fixes the problem, shown as a button. */
	link?: { href: string; text: string };
}

/** "ok": switched on. "plan": Cloudflare wants the Workers Paid plan first. "failed": something else. */
export interface SendingSetup { status: "ok" | "plan" | "failed"; detail?: string }

/** A failure we can explain in plain words. */
export class InstallError extends Error {
	constructor(
		message: string,
		readonly detail?: string,
		readonly link?: { href: string; text: string },
	) {
		super(message);
	}
}

// -- Cloudflare API ---------------------------------------------------

interface CfEnvelope<T> {
	success: boolean;
	result: T;
	errors?: { code: number; message: string }[];
}

export interface CfResponse<T> {
	status: number;
	ok: boolean;
	result: T | null;
	errors: { code: number; message: string }[];
}

const GATEWAY_ERRORS = new Set([502, 503, 504]);
const RETRY_AFTER_MS = 2000;

export async function call<T>(token: string, method: string, path: string, body?: unknown | FormData): Promise<CfResponse<T>> {
	const headers: Record<string, string> = { authorization: `Bearer ${token}` };
	let payload: BodyInit | undefined;
	if (body instanceof FormData) payload = body;
	else if (body !== undefined) {
		headers["content-type"] = "application/json";
		payload = JSON.stringify(body);
	}
	let res: Response;
	try {
		res = await fetch(`${API}${path}`, { method, headers, body: payload });
		// Cloudflare's API sometimes gives up with a 502, 503 or 504 when it's busy. Asking again once
		// is safe for reads, replacements and starting an upload session, which can all be repeated.
		if (GATEWAY_ERRORS.has(res.status) && (method === "GET" || method === "PUT" || path.endsWith("/assets-upload-session"))) {
			await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
			res = await fetch(`${API}${path}`, { method, headers, body: payload });
		}
	} catch (e) {
		throw new InstallError("We couldn't reach Cloudflare. Please check your connection and try again.", String(e));
	}
	let parsed: CfEnvelope<T> | null = null;
	try {
		parsed = (await res.json()) as CfEnvelope<T>;
	} catch {
		parsed = null;
	}
	return {
		status: res.status,
		ok: res.ok && Boolean(parsed?.success),
		result: parsed?.result ?? null,
		errors: parsed?.errors ?? [],
	};
}

export function describe(r: CfResponse<unknown>): string {
	const text = r.errors.map((e) => `${e.code}: ${e.message}`).join("; ");
	return `HTTP ${r.status}${text ? ` (${text})` : ""}`;
}

/** Throws a plain-English error unless the call worked. Permission problems get their own wording. */
export function must<T>(r: CfResponse<T>, whatFailed: string): T {
	if (r.ok) return r.result as T;
	if (r.status === 401 || r.status === 403) {
		throw new InstallError(
			`${whatFailed} Cloudflare says Mail App doesn't have permission. Please sign out, sign in again and allow everything on Cloudflare's page.`,
			describe(r),
		);
	}
	throw new InstallError(whatFailed, describe(r));
}

// -- Reading the release from mailapp.com's own assets ----------------------

export async function readAsset(assets: Fetcher, base: string, path: string): Promise<Response> {
	const res = await assets.fetch(new Request(new URL(path, base)));
	if (!res.ok) throw new InstallError("Mail App's install files are missing from this package. Please reinstall it and try again.", `${path}: HTTP ${res.status}`);
	return res;
}

export async function loadRelease(assets: Fetcher, base: string): Promise<ReleaseManifest> {
	const latest = (await (await readAsset(assets, base, `${RELEASES_PATH}/latest.json`)).json()) as { version?: string };
	if (!latest.version || !isSafeVersion(latest.version)) throw new InstallError("Mail App's install files in this package look damaged.", "latest.json");
	const manifest = await (await readAsset(assets, base, `${RELEASES_PATH}/${latest.version}/manifest.json`)).json();
	if (!isReleaseManifest(manifest)) throw new InstallError("Mail App's install files in this package look damaged.", "manifest.json");
	return manifest;
}

export function base64(bytes: ArrayBuffer): string {
	const view = new Uint8Array(bytes);
	let out = "";
	for (let i = 0; i < view.length; i += 0x8000) out += String.fromCharCode(...view.subarray(i, i + 0x8000));
	return btoa(out);
}

// -- Context ----------------------------------------------------------

export interface RunContext {
	token: string;
	choice: InstallChoice;
	/** mailapp.com's ASSETS binding and the request URL, to read the release. */
	assets: Fetcher;
	base: string;
}

const acct = (ctx: RunContext) => `/accounts/${ctx.choice.accountId}`;

export async function findZoneId(ctx: RunContext): Promise<string> {
	const domain = ctx.choice.domain!;
	const zones = must(
		await call<{ id: string; name: string }[]>(ctx.token, "GET", `/zones?name=${encodeURIComponent(domain)}&account.id=${ctx.choice.accountId}`),
		`We couldn't find ${domain} on your Cloudflare account.`,
	);
	const zone = zones.find((z) => z.name.toLowerCase() === domain);
	if (!zone) throw new InstallError(`We couldn't find ${domain} on this Cloudflare account. Please pick it again.`);
	return zone.id;
}

export async function workersSubdomain(ctx: RunContext): Promise<string> {
	const r = await call<{ subdomain: string }>(ctx.token, "GET", `${acct(ctx)}/workers/subdomain`);
	if (r.ok && r.result?.subdomain) return r.result.subdomain;
	// TODO(confirm): what this returns for an account that has never opened Workers. We don't
	// create the subdomain for them (PUT /accounts/:id/workers/subdomain), as it becomes part of
	// every Worker address on their account and they should choose it.
	throw new InstallError(
		"Your Cloudflare account doesn't have its free workers.dev address yet. Open Workers & Pages in your Cloudflare dashboard once, pick a name, then try again.",
		describe(r),
	);
}

async function hostnameFor(ctx: RunContext): Promise<string> {
	return ctx.choice.domain ? webHostname(ctx.choice) : webHostname(ctx.choice, await workersSubdomain(ctx));
}

// -- Actions ----------------------------------------------------------

/** Explains how to switch R2 on, with a link to the R2 page on the person's own account. */
function r2OffError(ctx: RunContext, r: CfResponse<unknown>): InstallError {
	return new InstallError(
		"Storage (R2) isn't switched on for your Cloudflare account yet. Open R2 in your Cloudflare dashboard and switch it on. Cloudflare asks for a payment card once, even for its free allowance, which is plenty for email. Then come back here and press Try again.",
		describe(r),
		{ href: r2DashboardUrl(ctx.choice.accountId), text: "Open R2 in Cloudflare" },
	);
}

/** Read-only: can this account use R2 yet? Asked at the Sending step, before anything is installed. */
async function storageReady(ctx: RunContext): Promise<"ok" | "off" | "unknown"> {
	const r = await call(ctx.token, "GET", `${acct(ctx)}/r2/buckets?per_page=1`);
	if (r.ok) return "ok";
	return r2NotEnabled(r.errors) ? "off" : "unknown";
}

/** 1. "Creating storage": the R2 bucket for mailboxes and attachments. */
async function storage(ctx: RunContext): Promise<ActionResult> {
	const existing = await call(ctx.token, "GET", `${acct(ctx)}/r2/buckets/${BUCKET_NAME}`);
	if (existing.ok) return { ok: true };
	if (r2NotEnabled(existing.errors)) throw r2OffError(ctx, existing);
	const created = await call(ctx.token, "POST", `${acct(ctx)}/r2/buckets`, { name: BUCKET_NAME });
	if (!created.ok && r2NotEnabled(created.errors)) throw r2OffError(ctx, created);
	must(created, "We couldn't create storage for your mail.");
	return { ok: true };
}

/**
 * Starts (or resumes) an assets upload session and uploads up to `maxFiles` files.
 * Returns the completion token once Cloudflare has every file.
 */
async function syncAssets(ctx: RunContext, manifest: ReleaseManifest, maxFiles: number): Promise<{ jwt: string | null; more: boolean }> {
	const session = must(
		await call<{ jwt: string; buckets: string[][] }>(ctx.token, "POST", `${acct(ctx)}/workers/scripts/${SCRIPT_NAME}/assets-upload-session`, assetUploadManifest(manifest)),
		"We couldn't start uploading Mail App.",
	);
	const { now, later } = takeBuckets(session.buckets ?? [], maxFiles);
	// No buckets means Cloudflare already has every file, and the session token is the completion token.
	if (now.length === 0) return { jwt: session.jwt, more: false };

	const byHash = new Map(manifest.assets.map((a) => [a.hash, a]));
	let completion: string | null = null;
	for (const bucket of now) {
		const form = new FormData();
		for (const hash of bucket) {
			const asset = byHash.get(hash);
			if (!asset) throw new InstallError("Mail App's install files in this package don't match. Please reinstall it and try again.", `unknown asset hash ${hash}`);
			const bytes = await (await readAsset(ctx.assets, ctx.base, `${RELEASES_PATH}/${manifest.version}/assets${asset.path}`)).arrayBuffer();
			form.append(hash, new File([base64(bytes)], hash, { type: asset.contentType }));
		}
		// This call is authorised by the upload session's token, not the person's OAuth token.
		const r = await call<{ jwt?: string }>(session.jwt, "POST", `${acct(ctx)}/workers/assets/upload?base64=true`, form);
		const result = must(r, "We couldn't upload part of Mail App.");
		if (result?.jwt) completion = result.jwt;
	}
	if (later.length > 0) return { jwt: null, more: true };
	return { jwt: completion ?? null, more: completion === null };
}

/** 2a. Upload the web app's files, a batch per call. */
async function assetsAction(ctx: RunContext): Promise<ActionResult> {
	const manifest = await loadRelease(ctx.assets, ctx.base);
	const { more } = await syncAssets(ctx, manifest, ASSET_FILES_PER_REQUEST);
	return { ok: true, more };
}

/** 2b. Upload the Worker itself with its bindings, attached to the uploaded files. */
async function worker(ctx: RunContext): Promise<ActionResult> {
	const manifest = await loadRelease(ctx.assets, ctx.base);
	// After the assets action, a fresh session normally has nothing left to upload and hands back a
	// completion token. If Cloudflare still wants some files, upload them here rather than fail.
	// TODO(confirm): the docs say files are skipped if "recently uploaded in previous versions"; we
	// rely on that also covering files uploaded in an earlier session that no version used yet.
	let sync = await syncAssets(ctx, manifest, Number.MAX_SAFE_INTEGER);
	if (!sync.jwt) sync = await syncAssets(ctx, manifest, Number.MAX_SAFE_INTEGER);
	if (!sync.jwt) throw new InstallError("Cloudflare didn't confirm Mail App's files arrived. Please try again.");

	const scripts = must(await call<{ id: string; migration_tag?: string }[]>(ctx.token, "GET", `${acct(ctx)}/workers/scripts`), "We couldn't look at your Workers.");
	const current = scripts.find((s) => s.id === SCRIPT_NAME);

	const metadata = buildMetadata(manifest, ctx.choice, { assetsJwt: sync.jwt, currentMigrationTag: current?.migration_tag });
	const form = new FormData();
	form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
	for (const m of manifest.worker.modules) {
		const code = await (await readAsset(ctx.assets, ctx.base, `${RELEASES_PATH}/${manifest.version}/worker/${m.name}`)).arrayBuffer();
		form.append(m.name, new File([code], m.name, { type: m.contentType }));
	}
	must(await call(ctx.token, "PUT", `${acct(ctx)}/workers/scripts/${SCRIPT_NAME}`, form), "We couldn't install Mail App.");
	return { ok: true };
}

/** 2c. Give the web app its address: mail.<domain>, or <script>.<subdomain>.workers.dev for a trial. */
async function address(ctx: RunContext): Promise<ActionResult> {
	if (ctx.choice.domain) {
		const hostname = webHostname(ctx.choice);
		const zoneId = await findZoneId(ctx);
		// PUT attaches (or re-attaches) the Worker to the hostname and creates its DNS record and certificate.
		const r = await call(ctx.token, "PUT", `${acct(ctx)}/workers/domains`, { environment: "production", hostname, service: SCRIPT_NAME, zone_id: zoneId });
		if (!r.ok && r.status === 409) {
			// TODO(confirm): the exact status/code Cloudflare uses when a DNS record already exists for the hostname.
			throw new InstallError(`${hostname} is already in use on your domain. Remove its DNS record in Cloudflare, or tell us, then try again.`, describe(r));
		}
		must(r, `We couldn't set up ${hostname}.`);
		return { ok: true, hostname };
	}
	const hostname = webHostname(ctx.choice, await workersSubdomain(ctx));
	must(await call(ctx.token, "POST", `${acct(ctx)}/workers/scripts/${SCRIPT_NAME}/subdomain`, { enabled: true }), "We couldn't switch on your Mail App address.");
	return { ok: true, hostname };
}

/** The person agreed: delete the old service's MX and SPF records so Email Routing can take over. */
async function moveMailHere(ctx: RunContext, zoneId: string, domain: string): Promise<void> {
	const all = must(
		await call<{ id: string; type: string; name: string; content: string }[]>(ctx.token, "GET", `/zones/${zoneId}/dns_records?name=${encodeURIComponent(domain)}&per_page=100`),
		`We couldn't read ${domain}'s email settings.`,
	);
	for (const rec of mailToMove(all ?? [], domain)) {
		must(await call(ctx.token, "DELETE", `/zones/${zoneId}/dns_records/${rec.id}`), `We couldn't move ${domain}'s email from its old service.`);
	}
}

/** 3. "Switching on email": Email Routing on the zone, with a catch-all that hands mail to the Worker. */
async function email(ctx: RunContext): Promise<ActionResult> {
	if (!ctx.choice.domain) return { ok: true };
	const domain = ctx.choice.domain;
	const zoneId = await findZoneId(ctx);
	const settings = await call<{ enabled?: boolean; status?: string }>(ctx.token, "GET", `/zones/${zoneId}/email/routing`);
	if (!(settings.ok && settings.result?.enabled)) {
		// Never take a domain's email away from where it goes now (Google, Microsoft...) as a side effect:
		// that has to be the person's own decision, so the page explains it and asks first.
		const mx = await zoneRecords(ctx, zoneId, domain, "MX");
		const elsewhere = mx ? mailElsewhere(mx) : null;
		if (elsewhere && !ctx.choice.moveMail) {
			// The page explains what moving means and asks; ticking the box re-runs this with moveMail.
			const provider = mailProviderLabel(mx!);
			return {
				ok: false,
				message: `${domain} gets its email at ${provider} at the moment. Mail App needs your OK before moving it.`,
				detail: `MX: ${mx!.join(", ")}`,
				mailElsewhere: { provider, hosts: mx! },
			};
		}
		if (elsewhere) await moveMailHere(ctx, zoneId, domain);
		// Adds and locks the MX and SPF records Email Routing needs. `name` is only for a subdomain;
		// for the zone itself Cloudflare rejects it ("must be a subdomain"), so send an empty body.
		const enabled = await call(ctx.token, "POST", `/zones/${zoneId}/email/routing/dns`, {});
		// TODO(confirm): the error Cloudflare returns when the zone already has other MX records
		// (mail handled elsewhere). The dashboard asks people to delete them first; we explain that.
		if (enabled.status === 401 || enabled.status === 403) must(enabled, `We couldn't switch on email for ${domain}.`);
		if (!enabled.ok) {
			throw new InstallError(
				`We couldn't switch on email for ${domain}. If ${domain} already gets email somewhere else (such as Google or Microsoft), that needs to be moved or switched off first.`,
				describe(enabled),
			);
		}
	}
	must(await call(ctx.token, "PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, catchAllRule()), `We couldn't send ${domain}'s email to Mail App.`);
	return { ok: true };
}

/**
 * 5. "Switching on sending": the domain onboarded on Email Sending, so mail can go to anyone. Never
 * fails the install. When Cloudflare wants the Workers Paid plan first, the page asks the person to
 * turn it on in another tab and press Continue (which runs this again), or to skip and only receive.
 */
async function sendingAction(ctx: RunContext): Promise<ActionResult> {
	if (!ctx.choice.domain) return { ok: true };
	const zoneId = await findZoneId(ctx);
	const [sending, storageState] = await Promise.all([enableSending(ctx, zoneId, ctx.choice.domain), storageReady(ctx)]);
	return { ok: true, sending, storage: storageState };
}

interface ExpectedRecord { type: string; name: string; content: string; priority?: number; ttl?: number }

/**
 * Email Routing only receives. Sending from the domain to anyone (not just the person's verified
 * addresses) needs the domain onboarded on Email Sending too, as the dashboard's "Onboard Domain" does:
 * that adds bounce (cf-bounce.<domain>), SPF and DKIM records. It needs the Workers Paid plan, so on
 * a free account it can't happen yet. Never fails the install: the last screen says how it went, and
 * running the installer again after turning the plan on finishes the job.
 */
async function enableSending(ctx: RunContext, zoneId: string, domain: string): Promise<SendingSetup> {
	try {
		const list = await call<{ tag: string; name: string; enabled: boolean }[]>(ctx.token, "GET", `/zones/${zoneId}/email/sending/subdomains`);
		let entry = list.ok ? (list.result ?? []).find((s) => s.name.toLowerCase() === domain) : undefined;
		if (!entry || !entry.enabled) {
			const created = await call<{ tag: string; name: string; enabled: boolean }>(ctx.token, "POST", `/zones/${zoneId}/email/sending/subdomains`, { name: domain });
			if (!created.ok || !created.result) {
				// Either call can be the one Cloudflare refuses for a free account.
				const refusal = !created.ok ? created : list;
				return { status: needsPaidPlan(refusal) ? "plan" : "failed", detail: describe(refusal) };
			}
			entry = created.result;
		}
		// Make sure the records Cloudflare expects are there; add only the missing ones.
		const expected = await call<ExpectedRecord[]>(ctx.token, "GET", `/zones/${zoneId}/email/sending/subdomains/${entry.tag}/dns`);
		if (!expected.ok) return { status: "failed", detail: describe(expected) };
		for (const rec of expected.result ?? []) {
			const name = rec.name.toLowerCase();
			const type = rec.type.toUpperCase() as "MX" | "TXT";
			if (type !== "MX" && type !== "TXT") continue;
			const have = await zoneRecords(ctx, zoneId, name, type);
			if (have === null) continue;
			// Never add a second DMARC record; the records step looks after DMARC.
			if (name.startsWith("_dmarc.") && have.some((c) => /^v=DMARC1/i.test(c))) continue;
			if (have.some((c) => joinTxt(c).toLowerCase() === joinTxt(rec.content).toLowerCase())) continue;
			await call(ctx.token, "POST", `/zones/${zoneId}/dns_records`, {
				type, name, content: rec.content, ttl: 1,
				...(type === "MX" ? { priority: rec.priority ?? 10 } : {}),
				comment: "Added by the Mail App installer for Email Sending",
			});
		}
		return { status: "ok" };
	} catch (e) {
		return { status: "failed", detail: (e as Error)?.message };
	}
}

/**
 * True when Cloudflare refused because the account isn't on Workers Paid. TODO(confirm): the exact
 * error a free account gets from the Email Sending API; we go by its wording and by "not allowed".
 */
function needsPaidPlan(r: CfResponse<unknown>): boolean {
	const text = r.errors.map((e) => e.message).join(" ");
	return /paid|plan|subscription|upgrade|entitle|not (enabled|allowed|available)/i.test(text) || r.status === 402;
}

async function zoneRecords(ctx: RunContext, zoneId: string, name: string, type: "MX" | "TXT"): Promise<string[] | null> {
	const r = await call<{ content: string; type: string; name: string }[]>(
		ctx.token, "GET", `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}&per_page=50`,
	);
	if (!r.ok) return null;
	return (r.result ?? []).filter((d) => d.name.toLowerCase() === name).map((d) => joinTxt(d.content));
}

async function recordChecks(ctx: RunContext, zoneId: string): Promise<SetupCheck[]> {
	const domain = ctx.choice.domain!;
	const [mx, spf, dkim, dmarc] = await Promise.all([
		zoneRecords(ctx, zoneId, domain, "MX"),
		zoneRecords(ctx, zoneId, domain, "TXT"),
		zoneRecords(ctx, zoneId, `${ROUTING_DKIM_SELECTOR}._domainkey.${domain}`, "TXT"),
		zoneRecords(ctx, zoneId, `_dmarc.${domain}`, "TXT"),
	]);
	return [checkMx(mx), checkSpf(domain, spf), checkDkim(dkim), checkDmarc(domain, undefined, dmarc)];
}

// Only mail sent through Cloudflare comes from this domain once Email Routing has its MX records,
// so other servers can be told to treat anything else as suspicious. No reporting address, so
// nobody's inbox fills with DMARC reports.
export const DMARC_RECORD = "v=DMARC1; p=quarantine";

/**
 * 3b. Part of "Switching on email": check the records other mail services look at before trusting
 * mail from this domain (MX, SPF, DKIM, DMARC), and repair what's missing. Email Routing owns MX, SPF
 * and DKIM, so asking it to set up its records again fixes those; DMARC is added only if there is none.
 * Never fails the install: anything still wrong is listed on the last screen with how to fix it.
 */
async function records(ctx: RunContext): Promise<ActionResult> {
	if (!ctx.choice.domain) return { ok: true };
	try {
		const zoneId = await findZoneId(ctx);
		let checks = await recordChecks(ctx, zoneId);
		const added: string[] = [];
		const bad = (id: string) => checks.find((c) => c.id === id)?.status === "fix";
		if (bad("mx") || bad("spf") || bad("dkim")) {
			await call(ctx.token, "POST", `/zones/${zoneId}/email/routing/dns`, {});
		}
		const dmarc = checks.find((c) => c.id === "dmarc");
		if (dmarc?.status === "fix" && !dmarc.found) {
			const r = await call(ctx.token, "POST", `/zones/${zoneId}/dns_records`, {
				type: "TXT", name: `_dmarc.${ctx.choice.domain}`, content: DMARC_RECORD, ttl: 1,
				comment: "Added by the Mail App installer",
			});
			if (r.ok) added.push("dmarc");
		}
		if (added.length || bad("mx") || bad("spf") || bad("dkim")) checks = await recordChecks(ctx, zoneId);
		return { ok: true, records: checks.map((c) => ({ id: c.id, status: c.status, added: added.includes(c.id) })) };
	} catch {
		return { ok: true, records: [] };
	}
}

/**
 * Before installing: is the chosen web address free? "ours" means Mail App already lives there (an
 * update), "taken" means something else does, so the person can pick another name first.
 */
export async function webAddressStatus(ctx: RunContext): Promise<{ hostname: string; status: "free" | "ours" | "taken" | "unknown" }> {
	const hostname = webHostname(ctx.choice);
	try {
		const attached = await call<{ hostname: string; service: string }[]>(
			ctx.token, "GET", `${acct(ctx)}/workers/domains?hostname=${encodeURIComponent(hostname)}`,
		);
		const here = (attached.result ?? []).filter((d) => d.hostname.toLowerCase() === hostname);
		if (here.some((d) => d.service === SCRIPT_NAME)) return { hostname, status: "ours" };
		if (here.length) return { hostname, status: "taken" };
		const zoneId = await findZoneId(ctx);
		const r = await call<{ name: string }[]>(ctx.token, "GET", `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=5`);
		if (!r.ok || !attached.ok) return { hostname, status: "unknown" };
		return { hostname, status: (r.result ?? []).some((d) => d.name.toLowerCase() === hostname) ? "taken" : "free" };
	} catch {
		return { hostname, status: "unknown" };
	}
}

/** 4. "Setting up sign-in protection": an Access app only the person can open, then tell the Worker about it. */
async function access(ctx: RunContext): Promise<ActionResult> {
	const hostname = await hostnameFor(ctx);

	const user = must(await call<{ email?: string }>(ctx.token, "GET", "/user"), "We couldn't read your Cloudflare email address.");
	// The sign-in rule is named after the Cloudflare account's email, so a re-run always finds it. The
	// address the person chose to sign in with (often their everyday one) is let in too, and owns Mail App.
	const email = user?.email?.toLowerCase();
	if (!email) throw new InstallError("We couldn't read your Cloudflare email address.");
	// On an update with no choice made, keep whoever Mail App already knows as its owner.
	const people = await readPeopleList(ctx);
	const known = (people as { owner?: unknown } | null)?.owner;
	const signIn = ctx.choice.signInEmail || (typeof known === "string" && known.includes("@") ? known.trim().toLowerCase() : email);
	// A fresh install says whether there's a backup address; an update keeps the one saved last time.
	const backup = ctx.choice.signInEmail ? ctx.choice.backupEmail ?? null : await readBackupEmail(ctx);
	const owners = backup ? [signIn, backup] : [signIn];

	// Zero Trust team domain (<team>.cloudflareaccess.com). Accounts that never opened Zero Trust have none.
	let org = await call<{ auth_domain?: string }>(ctx.token, "GET", `${acct(ctx)}/access/organizations`);
	if (!(org.ok && org.result?.auth_domain)) {
		const accounts = await call<{ name: string }>(ctx.token, "GET", acct(ctx));
		const random = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("");
		const slug = teamSlug(accounts.result?.name ?? "mail", random);
		org = await call<{ auth_domain?: string }>(ctx.token, "POST", `${acct(ctx)}/access/organizations`, { name: slug, auth_domain: `${slug}.cloudflareaccess.com` });
		// TODO(confirm): whether an account that has never chosen a Zero Trust plan can create an
		// organization through the API, or must go through the dashboard's onboarding first.
		if (!(org.ok && org.result?.auth_domain)) {
			throw new InstallError(
				"Sign-in protection uses Cloudflare Zero Trust, which isn't set up on your account yet. Open Zero Trust in your Cloudflare dashboard, choose the Free plan, then try again.",
				describe(org),
			);
		}
	}
	const authDomain = org.result!.auth_domain!;

	// One-time PIN: Access emails a code to the person's address. No other sign-in service needed.
	const idps = must(await call<{ type: string }[]>(ctx.token, "GET", `${acct(ctx)}/access/identity_providers`), "We couldn't check your sign-in options.");
	if (!idps.some((i) => i.type === "onetimepin")) {
		must(
			await call(ctx.token, "POST", `${acct(ctx)}/access/identity_providers`, { name: "One-time PIN", type: "onetimepin", config: {} }),
			"We couldn't switch on sign-in codes by email.",
		);
	}

	// The app, found by its exact hostname so a re-run reuses it.
	const apps = must(
		await call<{ id: string; aud: string; name: string; domain?: string; self_hosted_domains?: string[] }[]>(ctx.token, "GET", `${acct(ctx)}/access/apps?domain=${encodeURIComponent(hostname)}&exact=true`),
		"We couldn't check your sign-in protection.",
	);
	// Match the hostname ourselves too, in case Cloudflare ignores the filter and lists every app.
	let aud = apps.find((a) => [a.domain, ...(a.self_hosted_domains ?? [])].some((d) => d?.toLowerCase() === hostname))?.aud;

	// Our sign-in rule. On an update it's brought up to date: everyone on the People list in Mail App
	// (so people invited while Mail App couldn't update the list itself get in now) and the sign-in length.
	const policies = must(
		await call<{ id: string; name: string; include?: unknown }[]>(ctx.token, "GET", `${acct(ctx)}/access/policies?per_page=100`),
		"We couldn't check your sign-in rules.",
	);
	let policyId = policies.find((p) => p.name === accessPolicyName(email))?.id;
	if (policyId) {
		const current = policies.find((p) => p.id === policyId)?.include;
		const body = accessPolicy(email, [...owners, ...signInEmails(people, current)]);
		const r = await call(ctx.token, "PUT", `${acct(ctx)}/access/policies/${policyId}`, body);
		if (!r.ok) console.warn("Couldn't update the sign-in rule:", describe(r));
	} else {
		const created = must(await call<{ id: string }>(ctx.token, "POST", `${acct(ctx)}/access/policies`, accessPolicy(email, owners)), "We couldn't create your sign-in rule.");
		policyId = created.id;
	}
	if (!aud) {
		const app = must(
			await call<{ aud: string }>(ctx.token, "POST", `${acct(ctx)}/access/apps`, accessApp(hostname, policyId)),
			`We couldn't protect ${hostname} with ${ACCESS_APP_NAME} sign-in.`,
		);
		aud = app.aud;
	}

	// The Worker checks every request against these. Stored as secrets so script re-uploads keep them.
	for (const [name, text] of [
		["POLICY_AUD", aud],
		["TEAM_DOMAIN", teamDomainUrl(authDomain)],
	] as const) {
		must(
			await call(ctx.token, "PUT", `${acct(ctx)}/workers/scripts/${SCRIPT_NAME}/secrets`, { name, text, type: "secret_text" }),
			"We couldn't finish setting up sign-in protection.",
		);
	}
	await teamSignIn(ctx, signIn, policyId);
	if (ctx.choice.signInEmail) await saveBackupEmail(ctx, backup);
	await signInPageHint(ctx, signIn);
	await automaticSignIn(ctx, email, policyId, hostname, owners);
	await openDownloadLinks(ctx, hostname);
	await openApi(ctx, hostname);
	await openIcons(ctx, hostname);
	await passkeySignIn(ctx, hostname);
	if (ctx.choice.domain) await removeOldWebAddresses(ctx, hostname, aud);
	return { ok: true, hostname };
}

/** Where the installer keeps the backup sign-in address, so an update can keep it on the sign-in rule. */
const BACKUP_KEY = "sign-in-backup.json";

async function readBackupEmail(ctx: RunContext): Promise<string | null> {
	try {
		const res = await fetch(objectPath(ctx, BACKUP_KEY), { headers: { authorization: `Bearer ${ctx.token}` } });
		const saved = res.ok ? ((await res.json()) as { email?: unknown }).email : null;
		return typeof saved === "string" && saved.includes("@") ? saved.trim().toLowerCase() : null;
	} catch {
		return null;
	}
}

/** Saves (or clears) the backup address, and tells Mail App it belongs to the owner. Best effort. */
async function saveBackupEmail(ctx: RunContext, backup: string | null): Promise<void> {
	const secrets = `${acct(ctx)}/workers/scripts/${SCRIPT_NAME}/secrets`;
	try {
		if (backup) {
			await fetch(objectPath(ctx, BACKUP_KEY), {
				method: "PUT",
				headers: { authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
				body: JSON.stringify({ email: backup }),
			});
			const r = await call(ctx.token, "PUT", secrets, { name: "BACKUP_EMAIL", text: backup, type: "secret_text" });
			if (!r.ok) console.warn("Couldn't save the backup sign-in address:", describe(r));
		} else {
			await fetch(objectPath(ctx, BACKUP_KEY), { method: "DELETE", headers: { authorization: `Bearer ${ctx.token}` } });
			await call(ctx.token, "DELETE", `${secrets}/BACKUP_EMAIL`);
		}
	} catch (e) {
		console.warn("Couldn't save the backup sign-in address:", e);
	}
}

/** Says on Cloudflare's sign-in page which address gets codes. Best effort: sign-in works without it. */
async function signInPageHint(ctx: RunContext, owner: string): Promise<void> {
	try {
		const org = await call<Record<string, unknown>>(ctx.token, "GET", `${acct(ctx)}/access/organizations`);
		const body = org.ok && org.result ? withSignInHint(org.result, owner) : null;
		if (!body) return;
		const r = await call(ctx.token, "PUT", `${acct(ctx)}/access/organizations`, body);
		if (!r.ok) console.warn("Couldn't add the sign-in page hint:", describe(r));
	} catch (e) {
		console.warn("Couldn't add the sign-in page hint:", e);
	}
}

/** The People list Mail App keeps in its storage, or null if there isn't one (or it can't be read). */
async function readPeopleList(ctx: RunContext): Promise<unknown> {
	try {
		const res = await fetch(`${API}${acct(ctx)}/r2/buckets/${BUCKET_NAME}/objects/people.json`, { headers: { authorization: `Bearer ${ctx.token}` } });
		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
}

/**
 * Team access: tells Mail App who owns it (they're always an admin), and gives it a token that can
 * only change this account's Access settings, so it can add and remove people from the sign-in list
 * itself. Best effort: without the token, Mail App asks for the installer to be run again after
 * inviting someone, and this step brings the list up to date.
 */
async function teamSignIn(ctx: RunContext, email: string, policyId: string): Promise<void> {
	const secret = (name: string, text: string) =>
		call(ctx.token, "PUT", `${acct(ctx)}/workers/scripts/${SCRIPT_NAME}/secrets`, { name, text, type: "secret_text" });
	await secret("OWNER_EMAIL", email);
	await secret("ACCESS_POLICY_ID", policyId);
	await secret("CF_ACCOUNT_ID", ctx.choice.accountId);
	try {
		// TODO(confirm): needs the account-api-tokens.write scope, which Cloudflare's sign-in refused for the
		// Mail App client on 12 Oct 2026 even with it ticked, so it's not in OAUTH_SCOPES. Without it these
		// calls fail with 403 and the fallback above applies (re-run the installer after inviting).
		const groups = await call<{ id: string; name: string }[]>(ctx.token, "GET", `${acct(ctx)}/tokens/permission_groups`);
		const permissions = groups.ok ? accessTokenPermissions(groups.result ?? []) : null;
		if (!permissions) return;
		// One token at a time: remove the one an earlier run made.
		const tokens = await call<{ id: string; name: string }[]>(ctx.token, "GET", `${acct(ctx)}/tokens?per_page=50`);
		for (const t of (tokens.result ?? []).filter((t) => t.name === ACCESS_TOKEN_NAME)) {
			await call(ctx.token, "DELETE", `${acct(ctx)}/tokens/${t.id}`);
		}
		const made = await call<{ value?: string }>(ctx.token, "POST", `${acct(ctx)}/tokens`, accessTokenBody(ctx.choice.accountId, permissions));
		if (made.ok && made.result?.value) await secret("ACCESS_API_TOKEN", made.result.value);
		else console.warn("Couldn't make the sign-in list token:", describe(made));
	} catch (e) {
		console.warn("Couldn't make the sign-in list token:", e);
	}
}

/**
 * Team access without re-running the installer: Cloudflare asks Mail App who may sign in, so the
 * People list is the sign-in list. Best effort: if any part fails, the sign-in rule keeps the email
 * list set above and Mail App asks for the installer to be run again after inviting someone.
 */
async function automaticSignIn(ctx: RunContext, email: string, policyId: string, hostname: string, owners: string[]): Promise<void> {
	try {
		const path = checkPath(hostname);
		const apps = await call<{ id: string; domain?: string; self_hosted_domains?: string[] }[]>(
			ctx.token, "GET", `${acct(ctx)}/access/apps?name=${encodeURIComponent(CHECK_APP_NAME)}&exact=true`,
		);
		if (!apps.ok) return;
		const exists = (apps.result ?? []).some((a) => [a.domain, ...(a.self_hosted_domains ?? [])].some((d) => d?.toLowerCase() === path.toLowerCase()));
		if (!exists) {
			const policies = await call<{ id: string; name: string }[]>(ctx.token, "GET", `${acct(ctx)}/access/policies?per_page=100`);
			if (!policies.ok) return;
			let bypassId = (policies.result ?? []).find((p) => p.name === CHECK_POLICY_NAME)?.id;
			if (!bypassId) {
				const created = await call<{ id: string }>(ctx.token, "POST", `${acct(ctx)}/access/policies`, checkPolicy());
				if (!created.ok || !created.result?.id) return console.warn("Couldn't make the sign-in check policy:", describe(created));
				bypassId = created.result.id;
			}
			const app = await call(ctx.token, "POST", `${acct(ctx)}/access/apps`, checkApp(hostname, bypassId));
			if (!app.ok) return console.warn("Couldn't open the sign-in check:", describe(app));
		}
		const rule = await call(ctx.token, "PUT", `${acct(ctx)}/access/policies/${policyId}`, accessPolicyWithCheck(email, hostname, owners));
		if (!rule.ok) return console.warn("Couldn't switch on the automatic sign-in list:", describe(rule));
		await call(ctx.token, "PUT", `${acct(ctx)}/workers/scripts/${SCRIPT_NAME}/secrets`, { name: "ACCESS_CHECK", text: "on", type: "secret_text" });
	} catch (e) {
		console.warn("Couldn't switch on the automatic sign-in list:", e);
	}
}

/**
 * Download links: lets people the person emails open <hostname>/f/... without signing in, and tells the
 * Worker links are switched on. Everything else stays behind sign-in. Best effort: if it fails, Mail App works
 * as before and big files simply can't be sent until the installer is run again.
 */
async function openDownloadLinks(ctx: RunContext, hostname: string): Promise<void> {
	try {
		const path = linksPath(hostname);
		const apps = await call<{ id: string; name: string; domain?: string; self_hosted_domains?: string[] }[]>(
			ctx.token, "GET", `${acct(ctx)}/access/apps?name=${encodeURIComponent(LINKS_APP_NAME)}&exact=true`,
		);
		if (!apps.ok) return;
		const exists = (apps.result ?? []).some((a) => [a.domain, ...(a.self_hosted_domains ?? [])].some((d) => d?.toLowerCase() === path.toLowerCase()));
		if (!exists) {
			const policies = await call<{ id: string; name: string }[]>(ctx.token, "GET", `${acct(ctx)}/access/policies?per_page=100`);
			if (!policies.ok) return;
			let policyId = (policies.result ?? []).find((p) => p.name === LINKS_POLICY_NAME)?.id;
			if (!policyId) {
				// TODO(confirm): that a reusable policy accepts the "bypass" decision through the API, as the dashboard allows.
				const created = await call<{ id: string }>(ctx.token, "POST", `${acct(ctx)}/access/policies`, linksPolicy());
				if (!created.ok || !created.result?.id) return;
				policyId = created.result.id;
			}
			const app = await call(ctx.token, "POST", `${acct(ctx)}/access/apps`, linksApp(hostname, policyId));
			if (!app.ok) return;
		}
		await call(ctx.token, "PUT", `${acct(ctx)}/workers/scripts/${SCRIPT_NAME}/secrets`, { name: "PUBLIC_LINKS", text: "on", type: "secret_text" });
	} catch {
		// Download links stay off; the rest of the install is unaffected.
	}
}

/**
 * The API: lets other apps reach <hostname>/api/ext/... without signing in (each request needs an API key
 * an admin made, which the Worker checks), and tells the Worker the API is switched on. Best effort: if it
 * fails, the API stays off and the API & webhooks page says to run the installer again.
 */
async function openApi(ctx: RunContext, hostname: string): Promise<void> {
	try {
		const path = apiPath(hostname);
		const apps = await call<{ id: string; name: string; domain?: string; self_hosted_domains?: string[] }[]>(
			ctx.token, "GET", `${acct(ctx)}/access/apps?name=${encodeURIComponent(API_APP_NAME)}&exact=true`,
		);
		if (!apps.ok) return;
		const exists = (apps.result ?? []).some((a) => [a.domain, ...(a.self_hosted_domains ?? [])].some((d) => d?.toLowerCase() === path.toLowerCase()));
		if (!exists) {
			const policies = await call<{ id: string; name: string }[]>(ctx.token, "GET", `${acct(ctx)}/access/policies?per_page=100`);
			if (!policies.ok) return;
			let policyId = (policies.result ?? []).find((p) => p.name === API_POLICY_NAME)?.id;
			if (!policyId) {
				const created = await call<{ id: string }>(ctx.token, "POST", `${acct(ctx)}/access/policies`, apiPolicy());
				if (!created.ok || !created.result?.id) return;
				policyId = created.result.id;
			}
			const app = await call(ctx.token, "POST", `${acct(ctx)}/access/apps`, apiApp(hostname, policyId));
			if (!app.ok) return;
		}
		await call(ctx.token, "PUT", `${acct(ctx)}/workers/scripts/${SCRIPT_NAME}/secrets`, { name: "PUBLIC_API", text: "on", type: "secret_text" });
	} catch {
		// The API stays off; the rest of the install is unaffected.
	}
}

/**
 * Home screen icons: lets <hostname>/apple-touch-icon.png and the other icon files load without signing in,
 * because an iPhone fetches them without the sign-in cookie and otherwise draws a letter tile. Best effort:
 * if it fails, the home screen shows a letter as before.
 */
async function openIcons(ctx: RunContext, hostname: string): Promise<void> {
	try {
		const path = iconPaths(hostname)[0];
		const apps = await call<{ id: string; name: string; domain?: string; self_hosted_domains?: string[] }[]>(
			ctx.token, "GET", `${acct(ctx)}/access/apps?name=${encodeURIComponent(ICONS_APP_NAME)}&exact=true`,
		);
		if (!apps.ok) return;
		const mine = (apps.result ?? []).filter((a) => a.name === ICONS_APP_NAME && a.domain?.toLowerCase().startsWith(`${hostname.toLowerCase()}/`));
		if (mine.some((a) => a.domain!.toLowerCase() === path.toLowerCase())) return;
		// The first version (26 Oct 2026) used wildcard paths: replace it with the exact files.
		for (const a of mine) await call(ctx.token, "DELETE", `${acct(ctx)}/access/apps/${a.id}`);
		const policies = await call<{ id: string; name: string }[]>(ctx.token, "GET", `${acct(ctx)}/access/policies?per_page=100`);
		if (!policies.ok) return;
		let policyId = (policies.result ?? []).find((p) => p.name === ICONS_POLICY_NAME)?.id;
		if (!policyId) {
			const created = await call<{ id: string }>(ctx.token, "POST", `${acct(ctx)}/access/policies`, iconsPolicy());
			if (!created.ok || !created.result?.id) return console.warn("Couldn't make the icons policy:", describe(created));
			policyId = created.result.id;
		}
		const app = await call(ctx.token, "POST", `${acct(ctx)}/access/apps`, iconsApp(hostname, policyId));
		if (!app.ok) console.warn("Couldn't open the home screen icons:", describe(app));
	} catch {
		// The home screen shows a letter tile; the rest of the install is unaffected.
	}
}

/**
 * Passkey sign-in: adds "Passkey" to Cloudflare's sign-in page, next to the emailed code, pointing at
 * this install's own sign-in service at /passkey/. A new client secret each run, given to both sides.
 * Best effort: if any part fails, people sign in with an emailed code as before, and Settings says
 * passkeys switch on with the next update.
 */
async function passkeySignIn(ctx: RunContext, hostname: string): Promise<void> {
	try {
		const path = passkeyPath(hostname);
		const apps = await call<{ id: string; domain?: string; self_hosted_domains?: string[] }[]>(
			ctx.token, "GET", `${acct(ctx)}/access/apps?name=${encodeURIComponent(PASSKEY_APP_NAME)}&exact=true`,
		);
		if (!apps.ok) return;
		const exists = (apps.result ?? []).some((a) => [a.domain, ...(a.self_hosted_domains ?? [])].some((d) => d?.toLowerCase() === path.toLowerCase()));
		if (!exists) {
			const policies = await call<{ id: string; name: string }[]>(ctx.token, "GET", `${acct(ctx)}/access/policies?per_page=100`);
			if (!policies.ok) return;
			let bypassId = (policies.result ?? []).find((p) => p.name === PASSKEY_POLICY_NAME)?.id;
			if (!bypassId) {
				const created = await call<{ id: string }>(ctx.token, "POST", `${acct(ctx)}/access/policies`, passkeyPolicy());
				if (!created.ok || !created.result?.id) return console.warn("Couldn't make the passkey sign-in policy:", describe(created));
				bypassId = created.result.id;
			}
			const app = await call(ctx.token, "POST", `${acct(ctx)}/access/apps`, passkeyApp(hostname, bypassId));
			if (!app.ok) return console.warn("Couldn't open passkey sign-in:", describe(app));
		}

		const idps = await call<{ id: string; name: string; type: string; config?: { auth_url?: unknown; client_id?: unknown } }[]>(
			ctx.token, "GET", `${acct(ctx)}/access/identity_providers`,
		);
		if (!idps.ok) return console.warn("Couldn't check sign-in options for passkeys:", describe(idps));
		const list = idps.result ?? [];
		// Ours at this web address, or ours from before a change of web address on the same domain.
		const domain = ctx.choice.domain?.toLowerCase();
		const existing = ourPasskeyIdp(list, hostname) ?? (domain
			? list.find((i) => {
				if (i.type !== "oidc" || i.config?.client_id !== PASSKEY_CLIENT_ID || typeof i.config?.auth_url !== "string") return false;
				try {
					const host = new URL(i.config.auth_url).hostname.toLowerCase();
					return host === domain || host.endsWith(`.${domain}`);
				} catch {
					return false;
				}
			})
			: undefined);

		// The Worker first, so it's ready for the secret before Cloudflare starts using it.
		const secret = newClientSecret();
		const saved = await call(ctx.token, "PUT", `${acct(ctx)}/workers/scripts/${SCRIPT_NAME}/secrets`, { name: "PASSKEY_CLIENT_SECRET", text: secret, type: "secret_text" });
		if (!saved.ok) return console.warn("Couldn't give Mail App its passkey secret:", describe(saved));
		const body = passkeyIdp(hostname, secret, passkeyIdpName(list, hostname));
		const idp = existing
			? await call(ctx.token, "PUT", `${acct(ctx)}/access/identity_providers/${existing.id}`, body)
			: await call(ctx.token, "POST", `${acct(ctx)}/access/identity_providers`, body);
		if (!idp.ok) {
			console.warn("Couldn't add Passkey to the sign-in page:", describe(idp));
			// Without the sign-in option, Settings shouldn't offer passkeys either.
			await call(ctx.token, "DELETE", `${acct(ctx)}/workers/scripts/${SCRIPT_NAME}/secrets/PASSKEY_CLIENT_SECRET`);
		}
	} catch (e) {
		console.warn("Couldn't switch on passkey sign-in:", e);
	}
}

/**
 * After a change of web address (say mail. to webmail.), remove the old address and its sign-in app,
 * which would otherwise linger and show a sign-in error. Runs last, once the new address is protected.
 * Only touches addresses on the chosen domain that belong to Mail App. Best effort: never fails the install.
 */
async function removeOldWebAddresses(ctx: RunContext, keep: string, keepAud: string): Promise<void> {
	const domain = ctx.choice.domain!;
	const domains = await call<{ id: string; hostname: string; service: string }[]>(
		ctx.token, "GET", `${acct(ctx)}/workers/domains?service=${SCRIPT_NAME}`,
	);
	for (const d of staleWorkerDomains(domains.ok ? domains.result ?? [] : [], keep, domain)) {
		await call(ctx.token, "DELETE", `${acct(ctx)}/workers/domains/${d.id}`);
	}
	const apps = await call<{ id: string; name: string; domain?: string; aud?: string }[]>(
		ctx.token, "GET", `${acct(ctx)}/access/apps?name=${encodeURIComponent(ACCESS_APP_NAME)}&exact=true`,
	);
	// Never remove the app the Worker now trusts, whatever its listed domain says.
	for (const a of staleAccessApps(apps.ok ? apps.result ?? [] : [], keep, domain).filter((a) => a.aud !== keepAud)) {
		await call(ctx.token, "DELETE", `${acct(ctx)}/access/apps/${a.id}`);
	}
	// The old address's download-link opening goes with it.
	const linkApps = await call<{ id: string; name: string; domain?: string }[]>(
		ctx.token, "GET", `${acct(ctx)}/access/apps?name=${encodeURIComponent(LINKS_APP_NAME)}&exact=true`,
	);
	for (const a of staleLinksApps(linkApps.ok ? linkApps.result ?? [] : [], keep, domain)) {
		await call(ctx.token, "DELETE", `${acct(ctx)}/access/apps/${a.id}`);
	}
	// And its API opening.
	const apiApps = await call<{ id: string; name: string; domain?: string }[]>(
		ctx.token, "GET", `${acct(ctx)}/access/apps?name=${encodeURIComponent(API_APP_NAME)}&exact=true`,
	);
	for (const a of staleLinksApps(apiApps.ok ? apiApps.result ?? [] : [], keep, domain, API_APP_NAME)) {
		await call(ctx.token, "DELETE", `${acct(ctx)}/access/apps/${a.id}`);
	}
	// And its version number.
	// And its icons.
	const iconApps = await call<{ id: string; name: string; domain?: string }[]>(
		ctx.token, "GET", `${acct(ctx)}/access/apps?name=${encodeURIComponent(ICONS_APP_NAME)}&exact=true`,
	);
	for (const a of staleLinksApps(iconApps.ok ? iconApps.result ?? [] : [], keep, domain, ICONS_APP_NAME)) {
		await call(ctx.token, "DELETE", `${acct(ctx)}/access/apps/${a.id}`);
	}
}

const objectPath = (ctx: RunContext, key: string) => `${API}${acct(ctx)}/r2/buckets/${BUCKET_NAME}/objects/${key}`;

const ACTIONS: Record<ActionId, (ctx: RunContext) => Promise<ActionResult>> = {
	storage,
	assets: assetsAction,
	worker,
	address,
	email,
	records,
	access,
	sending: sendingAction,
};

/** True if this account already runs Mail App, so re-running the installer is an update. */
export async function appInstalled(token: string, accountId: string): Promise<boolean> {
	const r = await call(token, "GET", `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/settings`);
	return r.ok;
}

/**
 * What the "your details" email needs, worked out on our side so the email can only ever point at
 * the person's own Mail App: the web address (checked to be attached to their Mail App Worker) and the
 * address Cloudflare sends sign-in codes to. Null if anything doesn't check out.
 */
export async function installDetails(ctx: RunContext): Promise<{ hostname: string; signInEmail: string } | null> {
	try {
		const hostname = await hostnameFor(ctx);
		if (ctx.choice.domain) {
			const attached = await call<{ hostname: string; service: string }[]>(
				ctx.token, "GET", `${acct(ctx)}/workers/domains?hostname=${encodeURIComponent(hostname)}&service=${SCRIPT_NAME}`,
			);
			if (!attached.ok || !attached.result?.some((d) => d.hostname.toLowerCase() === hostname && d.service === SCRIPT_NAME)) return null;
		}
		const user = ctx.choice.signInEmail ? null : await call<{ email?: string }>(ctx.token, "GET", "/user");
		const signInEmail = ctx.choice.signInEmail || (user?.ok ? user.result?.email?.toLowerCase() : undefined);
		return signInEmail ? { hostname, signInEmail } : null;
	} catch {
		return null;
	}
}

export async function runAction(action: ActionId, ctx: RunContext): Promise<ActionResult> {
	try {
		return await ACTIONS[action](ctx);
	} catch (e) {
		if (e instanceof InstallError) return { ok: false, message: e.message, detail: e.detail, link: e.link };
		return { ok: false, message: "Something unexpected went wrong. Nothing is lost: please try again.", detail: String(e) };
	}
}
