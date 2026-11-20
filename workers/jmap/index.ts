// Mail App 2.6: JMAP (RFC 8620 core, RFC 8621 mail), so JMAP apps can use Mail App.
//
//   GET  /api/ext/jmap/session                                  the Session resource (also at /api/ext/jmap)
//   POST /api/ext/jmap/api                                      method calls
//   GET  /api/ext/jmap/download/{accountId}/{blobId}/{name}     an email file, attachment or upload
//   POST /api/ext/jmap/upload/{accountId}                       a file to attach (kept 24 hours)
//   GET  /api/ext/jmap/eventsource                              push: a "state" event when mail changes
//   PushSubscription/get and /set (2.8)                         push to a phone app's https address (workers/jmap/push.ts)
//
// Sign-in is an API key (Admin > API & webhooks), as Bearer or as the password with Basic. Each mailbox the
// key reaches is one JMAP account, and the key's permissions apply: read to read, organise to mark and
// move, send to save drafts and send, delete to delete for good (only from the Bin or Spam; drafts the
// app itself saved can always be replaced).
//
// Reading goes straight to the mailbox (workers/durableObject/jmap.ts). Changes go through the app's own
// routes (the `internal` call), so sending, rules, webhooks and the change log behave exactly as they do
// in the web app.

import {
	CAP_CORE, CAP_MAIL, CAP_SUBMISSION, CORE_LIMITS, JMAP_PREFIX,
	addressesOf, attachmentBlobId, bodyBlobId, emailBlobId, flagsFromPatch, flattenFilter, folderFromPatch, fromJmapId,
	isHtmlBody, keyFromAuthorization, keywordsOf, mailboxesFor, userFromAuthorization, parseBlobId, previewOf, resolveBackRefs, roleOf, sortOf, sortOrderOf,
	textOf, toJmapId, type EmailAddress, type Invocation,
} from "../../shared/jmap";
import { findKey, keyFromHeaders, keyMailboxes, shouldMarkUsed, type ApiKey, type Scope } from "../../shared/api";
import { buildMessage, type StoredFile } from "../../shared/mbox";
import { aliasesOf } from "../../shared/addresses";
import type { Person } from "../../shared/people";
import { apiSwitchedOn, keyPerson, loadApiBook, updateApiBook, API_DOCS } from "../lib/api";
import { listMailboxes } from "../lib/email-helpers";
import { sendableFor } from "../lib/masked";
import { loadAddressBook } from "../lib/addresses";
import type { JmapEmailRow } from "../durableObject/jmap";
import {
	MAX_PER_KEY, PUSH_TYPES, clampExpires, loadPushSubs, newCode, pushKeysProblem, pushUrlProblem, sendVerification, typesProblem,
	updatePushSubs, type JmapPushSub,
} from "./push";
import type { Env } from "../types";

/** Runs a request through the app's own /api/v1 routes as the key's person. */
export type Internal = (person: Person, method: string, path: string, body?: BodyInit | null, contentType?: string) => Promise<Response>;

interface Ctx {
	env: Env;
	ctx: ExecutionContext;
	internal: Internal;
	origin: string;
	key: ApiKey;
	person: Person;
	/** accountId → mailbox address */
	accounts: Map<string, string>;
	scopes: Set<Scope>;
	/** The mailbox the app signed in as (Basic user name), when it's one of the key's. */
	signedInAs: string | null;
}

const UPLOADS = "jmap-uploads/";
const UPLOAD_LIFE_MS = 24 * 60 * 60 * 1000;
const IDENTITIES_KEY = "jmap/identities.json";
const EVENT_POLL_MS = 10_000;
const EVENT_MAX_MS = 25 * 60 * 1000;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

/** RFC 7807 problem details, as RFC 8620 3.6.1 asks for request-level errors. */
function problem(status: number, type: string, detail: string): Response {
	return new Response(JSON.stringify({ type, status, detail, docs: API_DOCS }), { status, headers: { "content-type": "application/problem+json; charset=utf-8", "cache-control": "no-store" } });
}

function stub(env: Env, mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox.toLowerCase()));
}

export function isJmapPath(pathname: string): boolean {
	return pathname === JMAP_PREFIX || pathname.startsWith(`${JMAP_PREFIX}/`);
}

// -- Sign-in ---------------------------------------------------------------------------------------

async function signIn(req: Request, env: Env, ctx: ExecutionContext, internal: Internal, dev: boolean): Promise<Ctx | Response> {
	if (!apiSwitchedOn(env, dev)) return problem(503, "about:blank", "The API isn't switched on yet. The README shows how to switch it on.");
	const raw = keyFromAuthorization(req.headers.get("authorization")) ?? keyFromHeaders(req.headers);
	const unauthorised = (detail: string) => new Response(JSON.stringify({ type: "about:blank", status: 401, detail, docs: API_DOCS }), {
		status: 401, headers: { "content-type": "application/problem+json; charset=utf-8", "www-authenticate": 'Basic realm="Mail App", charset="UTF-8"', "cache-control": "no-store" },
	});
	if (!raw) return unauthorised("Sign in with an API key: as the password (any user name), or as Authorization: Bearer mailapp_…");
	const book = await loadApiBook(env.BUCKET);
	const key = await findKey(book, raw);
	if (!key) return unauthorised("That API key isn't valid. It may have been deleted.");
	const mailboxes = key.allMailboxes ? keyMailboxes(key, (await listMailboxes(env.BUCKET)).map((m) => m.email)) : key.mailboxes;
	if (shouldMarkUsed(key, new Date())) {
		ctx.waitUntil(updateApiBook(env.BUCKET, (b) => {
			const k = b.keys.find((x) => x.id === key.id);
			if (k) k.lastUsedAt = new Date().toISOString();
		}).catch(() => {}));
	}
	const accounts = new Map<string, string>();
	// Mail App 2.8.1: signing in as one of the key's mailboxes puts that one first, so it's the app's main account.
	const user = userFromAuthorization(req.headers.get("authorization"));
	const ordered = mailboxesFor(user, mailboxes);
	for (const m of ordered) accounts.set(toJmapId(m), m);
	const signedInAs = user && ordered[0] === user ? user : null;
	return { env, ctx, internal, origin: new URL(req.url).origin, key, person: keyPerson(key, mailboxes), accounts, scopes: new Set(key.scopes), signedInAs };
}

// -- Entry -----------------------------------------------------------------------------------------

export async function handleJmap(req: Request, env: Env, ctx: ExecutionContext, internal: Internal, dev = false): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname.slice(JMAP_PREFIX.length) || "/";
	if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: "GET, POST, OPTIONS" } });
	const c = await signIn(req, env, ctx, internal, dev);
	if (c instanceof Response) return c;

	if ((path === "/" || path === "/session") && req.method === "GET") return json(await session(c));
	if (path === "/api" && req.method === "POST") return api(c, req);
	if (path.startsWith("/download/") && req.method === "GET") return download(c, path, url);
	if (path.startsWith("/upload/") && req.method === "POST") return upload(c, path, req);
	if (path === "/eventsource" && req.method === "GET") return eventSource(c, url);
	return problem(404, "about:blank", "Not found. The JMAP session is at /api/ext/jmap/session.");
}

// -- Session ---------------------------------------------------------------------------------------

async function session(c: Ctx) {
	const base = `${c.origin}${JMAP_PREFIX}`;
	const accounts: Record<string, unknown> = {};
	const readOnly = !c.scopes.has("organise") && !c.scopes.has("send");
	for (const [id, mailbox] of c.accounts) {
		accounts[id] = {
			name: mailbox,
			isPersonal: true,
			isReadOnly: readOnly,
			accountCapabilities: {
				[CAP_MAIL]: {
					maxMailboxesPerEmail: 1,
					maxMailboxDepth: 1,
					maxSizeMailboxName: 100,
					maxSizeAttachmentsPerEmail: CORE_LIMITS.maxSizeUpload,
					emailQuerySortOptions: ["receivedAt", "sentAt", "size", "from", "to", "subject"],
					mayCreateTopLevelMailbox: c.scopes.has("organise"),
				},
				...(c.scopes.has("send") ? { [CAP_SUBMISSION]: { maxDelayedSend: 30 * 24 * 60 * 60, submissionExtensions: { FUTURERELEASE: [] } } } : {}),
			},
		};
	}
	const first = [...c.accounts.keys()][0];
	const primary: Record<string, string> = {};
	if (first) {
		primary[CAP_MAIL] = first;
		if (c.scopes.has("send")) primary[CAP_SUBMISSION] = first;
	}
	const capabilities: Record<string, unknown> = { [CAP_CORE]: CORE_LIMITS, [CAP_MAIL]: {} };
	if (c.scopes.has("send")) capabilities[CAP_SUBMISSION] = {};
	const body = {
		capabilities,
		accounts,
		primaryAccounts: primary,
		username: c.signedInAs ?? c.key.name,
		apiUrl: `${base}/api`,
		downloadUrl: `${base}/download/{accountId}/{blobId}/{name}?type={type}`,
		uploadUrl: `${base}/upload/{accountId}`,
		eventSourceUrl: `${base}/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
		state: "",
	};
	body.state = shortHash(JSON.stringify({ ...body, state: "" }));
	return body;
}

function shortHash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
	return h.toString(36);
}

// -- Push subscriptions (RFC 8620 7.2) -----------------------------------------------------------------
// They aren't in any account: they belong to the API key that made them. The url and keys an app gave are never
// handed back.

function showPush(s: JmapPushSub, props: string[] | null) {
	const all: Record<string, unknown> = { id: s.id, deviceClientId: s.deviceClientId, verificationCode: s.verified ? s.verificationCode : null, expires: s.expires, types: s.types };
	if (!props) return all;
	const out: Record<string, unknown> = { id: s.id };
	for (const p of props) if (p in all) out[p] = all[p];
	return out;
}

async function pushGet(c: Ctx, args: Args): Promise<MethodResult> {
	const ids = idsArg(args);
	const props = Array.isArray(args.properties) ? (args.properties as string[]) : null;
	const mine = (await loadPushSubs(c.env.BUCKET)).filter((s) => s.keyId === c.key.id && Date.parse(s.expires) > Date.now());
	const list = ids ? mine.filter((s) => ids.includes(s.id)) : mine;
	const notFound = ids ? ids.filter((id) => !mine.some((s) => s.id === id)) : [];
	return [["PushSubscription/get", { list: list.map((s) => showPush(s, props)), notFound }, ""]];
}

async function pushSet(c: Ctx, args: Args): Promise<MethodResult> {
	if (!c.scopes.has("read")) throw new MethodError("forbidden", "This API key can't do that. It needs read permission.");
	const create = (args.create ?? {}) as Record<string, Record<string, unknown>>;
	const update = (args.update ?? {}) as Record<string, Record<string, unknown>>;
	const destroy = Array.isArray(args.destroy) ? (args.destroy as string[]) : [];
	const created: Record<string, unknown> = {}, notCreated: Record<string, unknown> = {};
	const updated: Record<string, unknown> = {}, notUpdated: Record<string, unknown> = {};
	const destroyed: string[] = [], notDestroyed: Record<string, unknown> = {};
	const verify: JmapPushSub[] = [];
	const now = new Date();

	await updatePushSubs(c.env.BUCKET, (list) => {
		for (const [cid, raw] of Object.entries(create)) {
			if (!raw || typeof raw !== "object") { notCreated[cid] = { type: "invalidProperties" }; continue; }
			const bad = (property: string, description: string) => { notCreated[cid] = { type: "invalidProperties", properties: [property], description }; };
			if (typeof raw.deviceClientId !== "string" || !raw.deviceClientId || raw.deviceClientId.length > 255) { bad("deviceClientId", "deviceClientId is needed."); continue; }
			const urlWhy = pushUrlProblem(raw.url);
			if (urlWhy) { bad("url", urlWhy); continue; }
			const keysWhy = pushKeysProblem(raw.keys);
			if (keysWhy) { bad("keys", keysWhy); continue; }
			const typesWhy = typesProblem(raw.types);
			if (typesWhy) { bad("types", typesWhy); continue; }
			if (raw.verificationCode != null) { bad("verificationCode", "verificationCode can't be set when creating."); continue; }
			// The same device asking again replaces its old subscription.
			for (let i = list.length - 1; i >= 0; i--) if (list[i].keyId === c.key.id && list[i].deviceClientId === raw.deviceClientId) list.splice(i, 1);
			if (list.filter((s) => s.keyId === c.key.id).length >= MAX_PER_KEY) { notCreated[cid] = { type: "overQuota", description: `An API key can have up to ${MAX_PER_KEY} push subscriptions.` }; continue; }
			const keys = raw.keys ? { p256dh: String((raw.keys as Record<string, unknown>).p256dh), auth: String((raw.keys as Record<string, unknown>).auth) } : null;
			const sub: JmapPushSub = {
				id: crypto.randomUUID(), keyId: c.key.id, mailbox: c.signedInAs, deviceClientId: raw.deviceClientId, url: raw.url as string, keys,
				verificationCode: newCode(), verified: false, expires: clampExpires(raw.expires, now.getTime()),
				types: Array.isArray(raw.types) ? (raw.types as string[]).filter((t) => PUSH_TYPES.includes(t)) : null,
				created: now.toISOString(),
			};
			list.push(sub);
			verify.push(sub);
			created[cid] = { id: sub.id, expires: sub.expires };
		}
		for (const [id, patch] of Object.entries(update)) {
			const sub = list.find((s) => s.id === id && s.keyId === c.key.id);
			if (!sub) { notUpdated[id] = { type: "notFound" }; continue; }
			if (!patch || typeof patch !== "object") { notUpdated[id] = { type: "invalidProperties" }; continue; }
			const change: Record<string, unknown> = {};
			if ("verificationCode" in patch) {
				if (patch.verificationCode !== sub.verificationCode) { notUpdated[id] = { type: "invalidProperties", properties: ["verificationCode"], description: "That isn't the code Mail App sent." }; continue; }
				sub.verified = true;
			}
			if ("expires" in patch) {
				sub.expires = clampExpires(patch.expires, now.getTime());
				if (sub.expires !== patch.expires) change.expires = sub.expires;
			}
			if ("types" in patch) {
				const why = typesProblem(patch.types);
				if (why) { notUpdated[id] = { type: "invalidProperties", properties: ["types"], description: why }; continue; }
				sub.types = Array.isArray(patch.types) ? (patch.types as string[]).filter((t) => PUSH_TYPES.includes(t)) : null;
			}
			for (const p of Object.keys(patch)) {
				if (!["verificationCode", "expires", "types"].includes(p)) { notUpdated[id] = { type: "invalidProperties", properties: [p], description: `${p} can't be changed.` }; break; }
			}
			if (notUpdated[id]) continue;
			updated[id] = Object.keys(change).length ? change : null;
		}
		for (const id of destroy) {
			const i = list.findIndex((s) => s.id === id && s.keyId === c.key.id);
			if (i < 0) { notDestroyed[id] = { type: "notFound" }; continue; }
			list.splice(i, 1);
			destroyed.push(id);
		}
	});

	const contact = [...c.accounts.values()][0] ?? "postmaster@invalid";
	for (const sub of verify) c.ctx.waitUntil(sendVerification(c.env, sub, contact).catch((e) => console.error("Push verification failed:", (e as Error).message)));
	return [["PushSubscription/set", {
		created: Object.keys(created).length ? created : null, notCreated: Object.keys(notCreated).length ? notCreated : null,
		updated: Object.keys(updated).length ? updated : null, notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
		destroyed: destroyed.length ? destroyed : null, notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
	}, ""]];
}

// -- API -------------------------------------------------------------------------------------------

type Args = Record<string, unknown>;
type MethodResult = Invocation[];

class MethodError extends Error {
	constructor(readonly type: string, description?: string) { super(description ?? type); }
}

interface RequestState {
	/** Creation ids ("#draft") to the ids made for them, for this request and the createdIds the app sent. */
	created: Map<string, string>;
}

async function api(c: Ctx, req: Request): Promise<Response> {
	const length = Number(req.headers.get("content-length") ?? 0);
	if (length > CORE_LIMITS.maxSizeRequest) return problem(400, "urn:ietf:params:jmap:error:limit", "That request is too big.");
	let body: { using?: unknown; methodCalls?: unknown; createdIds?: unknown };
	try { body = await req.json(); } catch { return problem(400, "urn:ietf:params:jmap:error:notJSON", "The request isn't JSON."); }
	if (!body || typeof body !== "object" || !Array.isArray(body.using) || !Array.isArray(body.methodCalls)) {
		return problem(400, "urn:ietf:params:jmap:error:notRequest", "A JMAP request needs using and methodCalls.");
	}
	const known = new Set([CAP_CORE, CAP_MAIL, CAP_SUBMISSION]);
	const unknown = (body.using as unknown[]).filter((u) => typeof u !== "string" || !known.has(u));
	if (unknown.length) return problem(400, "urn:ietf:params:jmap:error:unknownCapability", `Not supported: ${unknown.join(", ")}`);
	if (body.methodCalls.length > CORE_LIMITS.maxCallsInRequest) return problem(400, "urn:ietf:params:jmap:error:limit", "Too many method calls in one request.");

	const state: RequestState = { created: new Map() };
	if (body.createdIds && typeof body.createdIds === "object") {
		for (const [k, v] of Object.entries(body.createdIds as Record<string, unknown>)) if (typeof v === "string") state.created.set(k, v);
	}
	const done: Invocation[] = [];
	for (const call of body.methodCalls as unknown[]) {
		if (!Array.isArray(call) || call.length !== 3 || typeof call[0] !== "string" || typeof call[2] !== "string" || !call[1] || typeof call[1] !== "object") {
			return problem(400, "urn:ietf:params:jmap:error:notRequest", "Each method call is [name, arguments, call id].");
		}
		const [name, rawArgs, id] = call as Invocation;
		const resolved = resolveBackRefs(rawArgs, done);
		if (!resolved.ok) { done.push(["error", resolved.error, id]); continue; }
		try {
			const out = await run(c, state, name, resolved.args);
			for (const [n, a] of out) done.push([n, a, id]);
		} catch (e) {
			if (e instanceof MethodError) done.push(["error", { type: e.type, ...(e.message !== e.type ? { description: e.message } : {}) }, id]);
			else {
				console.error("JMAP method failed:", name, (e as Error).message);
				done.push(["error", { type: "serverFail", description: "Something went wrong on the server." }, id]);
			}
		}
	}
	const out: Record<string, unknown> = { methodResponses: done, sessionState: (await session(c)).state };
	if (body.createdIds) out.createdIds = Object.fromEntries(state.created);
	return json(out);
}

function need(c: Ctx, ...any: Scope[]) {
	if (!any.some((s) => c.scopes.has(s))) throw new MethodError("forbidden", `This API key can't do that. It needs ${any.join(" or ")} permission.`);
}

function accountOf(c: Ctx, args: Args): { accountId: string; mailbox: string } {
	const accountId = typeof args.accountId === "string" ? args.accountId : [...c.accounts.keys()][0];
	const mailbox = accountId ? c.accounts.get(accountId) : undefined;
	if (!accountId || !mailbox) throw new MethodError("accountNotFound");
	return { accountId, mailbox };
}

function idsArg(args: Args, limit = CORE_LIMITS.maxObjectsInGet): string[] | null {
	if (args.ids == null) return null;
	if (!Array.isArray(args.ids) || args.ids.some((x) => typeof x !== "string")) throw new MethodError("invalidArguments", "ids must be a list of ids.");
	if (args.ids.length > limit) throw new MethodError("requestTooLarge");
	return args.ids as string[];
}

async function run(c: Ctx, st: RequestState, name: string, args: Args): Promise<MethodResult> {
	switch (name) {
		case "Core/echo": return [["Core/echo", args, ""]];
		case "Mailbox/get": need(c, "read"); return mailboxGet(c, args);
		case "Mailbox/changes": need(c, "read"); return mailboxChanges(c, args);
		case "Mailbox/query": need(c, "read"); return mailboxQuery(c, args);
		case "Mailbox/queryChanges": throw new MethodError("cannotCalculateChanges");
		case "Mailbox/set": return mailboxSet(c, st, args);
		case "Thread/get": need(c, "read"); return threadGet(c, args);
		case "Thread/changes": need(c, "read"); return threadChanges(c, args);
		case "Email/get": need(c, "read"); return emailGet(c, args);
		case "Email/query": need(c, "read"); return emailQuery(c, args);
		case "Email/queryChanges": throw new MethodError("cannotCalculateChanges");
		case "Email/changes": need(c, "read"); return emailChanges(c, args);
		case "Email/set": return emailSet(c, st, args);
		case "Email/import": return emailImport(c, st, args);
		case "SearchSnippet/get": need(c, "read"); return searchSnippets(c, args);
		case "Identity/get": need(c, "read"); return identityGet(c, args);
		case "Identity/changes": throw new MethodError("cannotCalculateChanges");
		case "Identity/set": return identitySet(c, st, args);
		case "EmailSubmission/set": return submissionSet(c, st, args);
		case "PushSubscription/get": return pushGet(c, args);
		case "PushSubscription/set": return pushSet(c, args);
		case "EmailSubmission/get": need(c, "send"); { const { accountId } = accountOf(c, args); return [["EmailSubmission/get", { accountId, state: "0", list: [], notFound: idsArg(args) ?? [] }, ""]]; }
		default: throw new MethodError("unknownMethod", `${name} isn't supported.`);
	}
}

// -- Mailboxes -------------------------------------------------------------------------------------

function rightsFor(c: Ctx) {
	const org = c.scopes.has("organise");
	return {
		mayReadItems: c.scopes.has("read"), mayAddItems: org, mayRemoveItems: org, maySetSeen: org, maySetKeywords: org,
		mayCreateChild: false, mayRename: org, mayDelete: org, maySubmit: c.scopes.has("send"),
	};
}

async function mailboxState(c: Ctx, mailbox: string) {
	const r = await stub(c.env, mailbox).jmapMailboxes();
	return { ...r, state: `${r.folderState}.${r.cursor}` };
}

async function mailboxGet(c: Ctx, args: Args): Promise<MethodResult> {
	const { accountId, mailbox } = accountOf(c, args);
	const { mailboxes, state } = await mailboxState(c, mailbox);
	const ids = idsArg(args);
	const rights = rightsFor(c);
	const builtIn = new Set(["inbox", "sent", "draft", "archive", "trash", "spam", "snoozed", "scheduled"]);
	const list = mailboxes
		.filter((m) => !ids || ids.includes(m.id))
		.map((m) => ({
			id: m.id, name: m.name, parentId: null, role: roleOf(m.id), sortOrder: sortOrderOf(m.id),
			totalEmails: m.totalEmails, unreadEmails: m.unreadEmails, totalThreads: m.totalThreads, unreadThreads: m.unreadThreads,
			myRights: { ...rights, mayRename: rights.mayRename && !builtIn.has(m.id), mayDelete: rights.mayDelete && !builtIn.has(m.id) },
			isSubscribed: true,
		}));
	const props = Array.isArray(args.properties) ? new Set(["id", ...(args.properties as string[])]) : null;
	const shown = props ? list.map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => props.has(k)))) : list;
	const notFound = ids ? ids.filter((id) => !mailboxes.some((m) => m.id === id)) : [];
	return [["Mailbox/get", { accountId, state, list: shown, notFound }, ""]];
}

async function mailboxChanges(c: Ctx, args: Args): Promise<MethodResult> {
	const { accountId, mailbox } = accountOf(c, args);
	const { mailboxes, folderState, state } = await mailboxState(c, mailbox);
	const since = String(args.sinceState ?? "");
	const [oldFolders] = since.split(".");
	// Folders the same: only counts can have changed. Folders added or renamed: start again.
	if (oldFolders !== folderState) throw new MethodError("cannotCalculateChanges");
	const changed = since !== state;
	return [["Mailbox/changes", {
		accountId, oldState: since, newState: state, hasMoreChanges: false, created: [], updated: changed ? mailboxes.map((m) => m.id) : [], destroyed: [],
		updatedProperties: changed ? ["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"] : null,
	}, ""]];
}

async function mailboxQuery(c: Ctx, args: Args): Promise<MethodResult> {
	const { accountId, mailbox } = accountOf(c, args);
	const { mailboxes, state } = await mailboxState(c, mailbox);
	const ids = mailboxes.sort((a, b) => sortOrderOf(a.id) - sortOrderOf(b.id) || a.name.localeCompare(b.name)).map((m) => m.id);
	return [["Mailbox/query", { accountId, queryState: state, canCalculateChanges: false, position: 0, ids, total: ids.length }, ""]];
}

async function mailboxSet(c: Ctx, st: RequestState, args: Args): Promise<MethodResult> {
	need(c, "organise");
	const { accountId, mailbox } = accountOf(c, args);
	const before = await mailboxState(c, mailbox);
	if (typeof args.ifInState === "string" && args.ifInState !== before.state) throw new MethodError("stateMismatch");
	const base = `/mailboxes/${encodeURIComponent(mailbox)}/folders`;
	const created: Record<string, unknown> = {}, notCreated: Record<string, unknown> = {};
	const updated: Record<string, unknown> = {}, notUpdated: Record<string, unknown> = {};
	const destroyed: string[] = [], notDestroyed: Record<string, unknown> = {};

	for (const [cid, raw] of Object.entries((args.create ?? {}) as Record<string, Args>)) {
		const name = typeof raw?.name === "string" ? raw.name.trim() : "";
		if (!name) { notCreated[cid] = { type: "invalidProperties", properties: ["name"] }; continue; }
		if (raw.parentId != null) { notCreated[cid] = { type: "invalidProperties", properties: ["parentId"], description: "Folders can't go inside other folders." }; continue; }
		const res = await c.internal(c.person, "POST", base, JSON.stringify({ name }), "application/json");
		const out = await res.json().catch(() => ({})) as { id?: string; error?: string };
		if (!res.ok || !out.id) { notCreated[cid] = { type: res.status === 409 ? "invalidProperties" : "forbidden", description: out.error ?? "Couldn't add that folder." }; continue; }
		st.created.set(cid, out.id);
		created[cid] = { id: out.id, role: null, sortOrder: sortOrderOf(out.id), totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, myRights: rightsFor(c), isSubscribed: true, parentId: null };
	}
	for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Args>)) {
		const keys = Object.keys(patch ?? {}).filter((k) => k !== "isSubscribed" && k !== "sortOrder");
		if (keys.some((k) => k !== "name")) { notUpdated[id] = { type: "invalidProperties", properties: keys.filter((k) => k !== "name") }; continue; }
		if (keys.length === 0) { updated[id] = null; continue; }
		const res = await c.internal(c.person, "PUT", `${base}/${encodeURIComponent(id)}`, JSON.stringify({ name: String(patch.name) }), "application/json");
		if (res.ok) updated[id] = null;
		else notUpdated[id] = { type: res.status === 404 ? "notFound" : "forbidden" };
	}
	for (const id of (Array.isArray(args.destroy) ? args.destroy : []) as string[]) {
		const res = await c.internal(c.person, "DELETE", `${base}/${encodeURIComponent(id)}`);
		if (res.ok) destroyed.push(id);
		else notDestroyed[id] = { type: "forbidden", description: "That folder can't be removed." };
	}
	const after = await mailboxState(c, mailbox);
	return [["Mailbox/set", {
		accountId, oldState: before.state, newState: after.state,
		created: orNull(created), updated: orNull(updated), destroyed: destroyed.length ? destroyed : null,
		notCreated: orNull(notCreated), notUpdated: orNull(notUpdated), notDestroyed: orNull(notDestroyed),
	}, ""]];
}

function orNull(o: Record<string, unknown>) {
	return Object.keys(o).length ? o : null;
}

// -- Threads ---------------------------------------------------------------------------------------

async function threadGet(c: Ctx, args: Args): Promise<MethodResult> {
	const { accountId, mailbox } = accountOf(c, args);
	const ids = idsArg(args) ?? [];
	const real = new Map<string, string>();
	for (const id of ids) { const r = fromJmapId(id); if (r) real.set(r, id); }
	const { threads, cursor } = await stub(c.env, mailbox).jmapThreads([...real.keys()]);
	const list = Object.entries(threads).map(([t, emailIds]) => ({ id: real.get(t) ?? toJmapId(t), emailIds }));
	const found = new Set(list.map((t) => t.id));
	return [["Thread/get", { accountId, state: String(cursor), list, notFound: ids.filter((id) => !found.has(id)) }, ""]];
}

async function threadChanges(c: Ctx, args: Args): Promise<MethodResult> {
	const { accountId, mailbox } = accountOf(c, args);
	const since = stateNumber(args.sinceState);
	const r = await stub(c.env, mailbox).jmapChanges(since, maxChanges(args));
	if (r === "gone") throw new MethodError("cannotCalculateChanges");
	return [["Thread/changes", {
		accountId, oldState: String(since), newState: String(r.newState), hasMoreChanges: r.hasMore,
		created: [], updated: r.threads.updated.map(toJmapId), destroyed: [],
	}, ""]];
}

function stateNumber(v: unknown): number {
	const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
	if (!Number.isSafeInteger(n)) throw new MethodError("cannotCalculateChanges");
	return n;
}

function maxChanges(args: Args): number {
	const n = typeof args.maxChanges === "number" && args.maxChanges > 0 ? args.maxChanges : 500;
	return Math.min(n, 1000);
}

// -- Emails: reading -------------------------------------------------------------------------------

const DEFAULT_EMAIL_PROPS = ["id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt", "messageId", "inReplyTo", "references", "sender", "from", "to", "cc", "bcc", "replyTo", "subject", "sentAt", "hasAttachment", "preview", "bodyValues", "textBody", "htmlBody", "attachments"];
const DEFAULT_BODY_PROPS = ["partId", "blobId", "size", "name", "type", "charset", "disposition", "cid", "language", "location"];
const BODY_PROPS = new Set(["textBody", "htmlBody", "attachments", "bodyStructure", "bodyValues"]);

function headersOf(row: JmapEmailRow): { name: string; value: string }[] {
	try {
		const parsed = JSON.parse(row.raw_headers || "[]");
		if (Array.isArray(parsed)) return parsed.filter((h) => h && typeof h.key === "string" && typeof h.value === "string").map((h) => ({ name: h.key, value: h.value }));
	} catch { /* none kept */ }
	return [];
}

/** "Name <a@b>, c@d" as JMAP addresses, for headers kept as they arrived (Reply-To). */
function parseAddressHeader(value: string): EmailAddress[] {
	const out: EmailAddress[] = [];
	for (const part of value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
		const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/.exec(part);
		if (m) out.push({ name: m[1]?.trim() || null, email: m[2].toLowerCase() });
		else if (part.trim().includes("@")) out.push({ name: null, email: part.trim().toLowerCase() });
	}
	return out;
}

function references(row: JmapEmailRow): string[] | null {
	if (!row.email_references) return null;
	try {
		const r = JSON.parse(row.email_references);
		if (Array.isArray(r) && r.length) return r.map((x) => String(x).replace(/^<|>$/g, ""));
	} catch { /* not a list */ }
	return null;
}

interface BodyPart { partId: string; blobId: string; size: number; name: string | null; type: string; charset: string | null; disposition: string | null; cid: string | null; language: null; location: null; subParts?: BodyPart[] }

function partsOf(row: JmapEmailRow) {
	const body = row.body ?? "";
	const html = isHtmlBody(body);
	const text = html ? textOf(body) : body;
	const enc = new TextEncoder();
	const textPart: BodyPart = { partId: "text", blobId: bodyBlobId(row.id, "text"), size: enc.encode(text).length, name: null, type: "text/plain", charset: "utf-8", disposition: null, cid: null, language: null, location: null };
	const htmlPart: BodyPart | null = html ? { partId: "html", blobId: bodyBlobId(row.id, "html"), size: enc.encode(body).length, name: null, type: "text/html", charset: "utf-8", disposition: null, cid: null, language: null, location: null } : null;
	const attachments: BodyPart[] = row.attachments.map((a) => ({
		partId: `a${a.id}`, blobId: attachmentBlobId(row.id, a.id), size: a.size, name: a.filename, type: a.mimetype || "application/octet-stream",
		charset: null, disposition: a.disposition || "attachment", cid: a.content_id ? a.content_id.replace(/^<|>$/g, "") : null, language: null, location: null,
	}));
	const values: Record<string, string> = { text };
	if (htmlPart) values.html = body;
	return { textPart, htmlPart, attachments, values };
}

function pick(part: BodyPart, props: string[]) {
	return Object.fromEntries(props.map((p) => [p, (part as unknown as Record<string, unknown>)[p] ?? null]));
}

function emailObject(c: Ctx, row: JmapEmailRow, props: string[], args: Args): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const bodyProps = Array.isArray(args.bodyProperties) ? (args.bodyProperties as string[]) : DEFAULT_BODY_PROPS;
	const headers = headersOf(row);
	const header = (n: string) => headers.find((h) => h.name.toLowerCase() === n)?.value;
	const needsParts = props.some((p) => BODY_PROPS.has(p));
	const parts = needsParts ? partsOf(row) : null;
	for (const p of props) {
		switch (p) {
			case "id": out.id = row.id; break;
			case "blobId": out.blobId = emailBlobId(row.id); break;
			case "threadId": out.threadId = toJmapId(row.thread_id || row.id); break;
			case "mailboxIds": out.mailboxIds = { [row.folder_id]: true }; break;
			case "keywords": out.keywords = keywordsOf({ read: row.read, starred: row.starred, folder: row.folder_id }); break;
			case "size": out.size = row.size; break;
			case "receivedAt": out.receivedAt = isoDate(row.date); break;
			case "sentAt": out.sentAt = isoDate(row.date); break;
			case "messageId": out.messageId = row.message_id ? [row.message_id.replace(/^<|>$/g, "")] : null; break;
			case "inReplyTo": out.inReplyTo = row.in_reply_to ? [row.in_reply_to.replace(/^<|>$/g, "")] : null; break;
			case "references": out.references = references(row); break;
			case "sender": out.sender = null; break;
			case "from": out.from = row.sender ? [{ name: row.sender_name || null, email: row.sender }] : null; break;
			case "to": out.to = addressesOf(row.recipient); break;
			case "cc": out.cc = addressesOf(row.cc); break;
			case "bcc": out.bcc = addressesOf(row.bcc); break;
			case "replyTo": { const r = header("reply-to"); out.replyTo = r ? parseAddressHeader(r) : null; break; }
			case "subject": out.subject = row.subject ?? ""; break;
			case "hasAttachment": out.hasAttachment = row.attachments.some((a) => a.disposition !== "inline"); break;
			case "preview": out.preview = previewOf(row.body); break;
			case "headers": out.headers = headers; break;
			case "textBody": out.textBody = [pick(parts!.textPart, bodyProps)]; break;
			case "htmlBody": out.htmlBody = [pick(parts!.htmlPart ?? parts!.textPart, bodyProps)]; break;
			case "attachments": out.attachments = parts!.attachments.map((a) => pick(a, bodyProps)); break;
			case "bodyStructure": {
				const main = parts!.htmlPart ? { ...pick({ ...parts!.textPart, partId: null as unknown as string, blobId: null as unknown as string, type: "multipart/alternative" }, bodyProps), subParts: [pick(parts!.textPart, bodyProps), pick(parts!.htmlPart, bodyProps)] } : pick(parts!.textPart, bodyProps);
				out.bodyStructure = parts!.attachments.length
					? { partId: null, blobId: null, type: "multipart/mixed", size: row.size, subParts: [main, ...parts!.attachments.map((a) => pick(a, bodyProps))] }
					: main;
				break;
			}
			case "bodyValues": {
				const all = args.fetchAllBodyValues === true;
				const wantText = all || args.fetchTextBodyValues === true;
				const wantHtml = all || args.fetchHTMLBodyValues === true;
				const max = typeof args.maxBodyValueBytes === "number" && args.maxBodyValueBytes > 0 ? args.maxBodyValueBytes : 0;
				const values: Record<string, unknown> = {};
				const add = (id: string) => {
					const v = parts!.values[id];
					if (v == null) return;
					const cut = max ? truncateUtf8(v, max) : v;
					values[id] = { value: cut, isEncodingProblem: false, isTruncated: cut.length < v.length };
				};
				if (wantText) add("text");
				// htmlBody falls back to the text part when there's no HTML.
				if (wantHtml) add(parts!.htmlPart ? "html" : "text");
				out.bodyValues = values;
				break;
			}
			default:
				if (p.startsWith("header:")) {
					const [, name, form] = p.split(":");
					const v = header((name ?? "").toLowerCase());
					out[p] = v == null ? null : form === "asAddresses" ? parseAddressHeader(v) : form === "asMessageIds" ? v.match(/[^<>\s]+@[^<>\s]+/g) : form === "asDate" ? isoDate(v) : v.trim();
				} else throw new MethodError("invalidArguments", `Unknown property: ${p}`);
		}
	}
	return out;
}

function isoDate(v: string | null | undefined): string {
	const d = v ? new Date(v) : new Date(0);
	return (Number.isNaN(d.getTime()) ? new Date(0) : d).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function truncateUtf8(s: string, bytes: number): string {
	const enc = new TextEncoder().encode(s);
	if (enc.length <= bytes) return s;
	return new TextDecoder().decode(enc.slice(0, bytes)).replace(/\uFFFD$/, "");
}

async function emailGet(c: Ctx, args: Args): Promise<MethodResult> {
	const { accountId, mailbox } = accountOf(c, args);
	const ids = idsArg(args);
	const props = Array.isArray(args.properties) ? ["id", ...(args.properties as string[]).filter((p) => p !== "id")] : DEFAULT_EMAIL_PROPS;
	const s = stub(c.env, mailbox);
	if (!ids) {
		// Every email isn't something to hand out in one go: apps ask for ids from Email/query.
		const { cursor } = await s.jmapCursor();
		return [["Email/get", { accountId, state: String(cursor), list: [], notFound: [] }, ""]];
	}
	const withBody = props.includes("bodyValues") || props.includes("htmlBody") || props.includes("textBody") || props.includes("bodyStructure");
	const { emails, cursor } = await s.jmapGet(ids, withBody);
	const byId = new Map(emails.map((e) => [e.id, e]));
	const list = ids.filter((id) => byId.has(id)).map((id) => emailObject(c, byId.get(id)!, props, args));
	return [["Email/get", { accountId, state: String(cursor), list, notFound: ids.filter((id) => !byId.has(id)) }, ""]];
}

async function emailQuery(c: Ctx, args: Args): Promise<MethodResult> {
	const { accountId, mailbox } = accountOf(c, args);
	const f = flattenFilter(args.filter);
	if (!f.ok) throw new MethodError("unsupportedFilter", f.reason);
	const sort = sortOf(args.sort);
	if (sort === "unsupported") throw new MethodError("unsupportedSort");
	if (args.anchor != null) throw new MethodError("unsupportedFilter", "anchor isn't supported: use position.");
	const position = typeof args.position === "number" ? Math.trunc(args.position) : 0;
	const limit = typeof args.limit === "number" && args.limit >= 0 ? Math.min(Math.trunc(args.limit), 5000) : 256;
	const r = await stub(c.env, mailbox).jmapQuery(f.filter, sort, position, limit, args.collapseThreads === true);
	const out: Record<string, unknown> = { accountId, queryState: String(r.cursor), canCalculateChanges: false, position: r.position, ids: r.ids, limit };
	if (args.calculateTotal === true) out.total = r.total;
	return [["Email/query", out, ""]];
}

async function emailChanges(c: Ctx, args: Args): Promise<MethodResult> {
	const { accountId, mailbox } = accountOf(c, args);
	const since = stateNumber(args.sinceState);
	const r = await stub(c.env, mailbox).jmapChanges(since, maxChanges(args));
	if (r === "gone") throw new MethodError("cannotCalculateChanges");
	return [["Email/changes", {
		accountId, oldState: String(since), newState: String(r.newState), hasMoreChanges: r.hasMore,
		created: r.created, updated: r.updated, destroyed: r.destroyed,
	}, ""]];
}

async function searchSnippets(c: Ctx, args: Args): Promise<MethodResult> {
	const { accountId } = accountOf(c, args);
	const ids = Array.isArray(args.emailIds) ? (args.emailIds as string[]) : [];
	return [["SearchSnippet/get", { accountId, list: ids.map((emailId) => ({ emailId, subject: null, preview: null })), notFound: [] }, ""]];
}

// -- Emails: changing ------------------------------------------------------------------------------

function resolveId(st: RequestState, id: string): string {
	return id.startsWith("#") ? (st.created.get(id.slice(1)) ?? id) : id;
}

async function emailSet(c: Ctx, st: RequestState, args: Args): Promise<MethodResult> {
	const { accountId, mailbox } = accountOf(c, args);
	const s = stub(c.env, mailbox);
	const oldState = String((await s.jmapCursor()).cursor);
	if (typeof args.ifInState === "string" && args.ifInState !== oldState) throw new MethodError("stateMismatch");
	const created: Record<string, unknown> = {}, notCreated: Record<string, unknown> = {};
	const updated: Record<string, unknown> = {}, notUpdated: Record<string, unknown> = {};
	const destroyed: string[] = [], notDestroyed: Record<string, unknown> = {};
	const create = (args.create ?? {}) as Record<string, Args>;
	const update = (args.update ?? {}) as Record<string, Args>;
	const destroy = (Array.isArray(args.destroy) ? args.destroy : []) as string[];
	if (Object.keys(create).length + Object.keys(update).length + destroy.length > CORE_LIMITS.maxObjectsInSet) throw new MethodError("requestTooLarge");

	for (const [cid, draft] of Object.entries(create)) {
		if (!c.scopes.has("send") && !c.scopes.has("organise")) { notCreated[cid] = { type: "forbidden", description: "This API key can't save emails." }; continue; }
		try {
			const made = await createEmail(c, st, mailbox, draft ?? {});
			st.created.set(cid, made.id);
			created[cid] = made;
		} catch (e) {
			notCreated[cid] = e instanceof MethodError ? { type: e.type, description: e.message } : { type: "serverFail", description: (e as Error).message };
		}
	}

	const updateIds = Object.keys(update).map((id) => resolveId(st, id));
	const current = new Map((await s.jmapGet(updateIds, false)).emails.map((e) => [e.id, e]));
	for (const [rawId, patch] of Object.entries(update)) {
		const id = resolveId(st, rawId);
		const row = current.get(id);
		if (!row) { notUpdated[rawId] = { type: "notFound" }; continue; }
		if (!c.scopes.has("organise")) { notUpdated[rawId] = { type: "forbidden", description: "This API key can't mark or move mail." }; continue; }
		const bad = Object.keys(patch ?? {}).filter((k) => k !== "keywords" && !k.startsWith("keywords/") && k !== "mailboxIds" && !k.startsWith("mailboxIds/"));
		if (bad.length) { notUpdated[rawId] = { type: "invalidProperties", properties: bad }; continue; }
		const flags = flagsFromPatch(patch);
		const folder = folderFromPatch(patch, row.folder_id);
		if (folder === "many") { notUpdated[rawId] = { type: "invalidProperties", properties: ["mailboxIds"], description: "In Mail App an email is in one folder at a time." }; continue; }
		const base = `/mailboxes/${encodeURIComponent(mailbox)}/emails/${encodeURIComponent(id)}`;
		const flagChange: Record<string, boolean> = {};
		if (flags.read !== undefined && flags.read !== row.read) flagChange.read = flags.read;
		if (flags.starred !== undefined && flags.starred !== row.starred) flagChange.starred = flags.starred;
		if (Object.keys(flagChange).length) {
			const res = await c.internal(c.person, "PUT", base, JSON.stringify(flagChange), "application/json");
			if (!res.ok) { notUpdated[rawId] = { type: "serverFail" }; continue; }
		}
		if (folder) {
			const res = await c.internal(c.person, "POST", `${base}/move`, JSON.stringify({ folderId: folder }), "application/json");
			if (!res.ok) {
				const e = await res.json().catch(() => ({})) as { error?: string };
				notUpdated[rawId] = { type: "invalidProperties", properties: ["mailboxIds"], description: e.error ?? "Couldn't move it there." };
				continue;
			}
		}
		updated[rawId] = null;
	}

	for (const rawId of destroy) {
		const id = resolveId(st, rawId);
		const r = await destroyEmail(c, mailbox, id);
		if (r === true) destroyed.push(rawId);
		else notDestroyed[rawId] = r;
	}

	const newState = String((await s.jmapCursor()).cursor);
	return [["Email/set", {
		accountId, oldState, newState,
		created: orNull(created), updated: orNull(updated), destroyed: destroyed.length ? destroyed : null,
		notCreated: orNull(notCreated), notUpdated: orNull(notUpdated), notDestroyed: orNull(notDestroyed),
	}, ""]];
}

/** Deletes for good: from the Bin or Spam (delete permission), or a draft (send or organise permission). */
async function destroyEmail(c: Ctx, mailbox: string, id: string): Promise<true | Record<string, unknown>> {
	const folder = await stub(c.env, mailbox).emailFolder(id);
	if (folder === null) return { type: "notFound" };
	if (folder === "draft") {
		if (!c.scopes.has("send") && !c.scopes.has("organise")) return { type: "forbidden", description: "This API key can't change drafts." };
	} else if (folder === "trash" || folder === "spam") {
		if (!c.scopes.has("delete")) return { type: "forbidden", description: "This API key can't delete mail. Move it to the Bin instead." };
	} else {
		return { type: "forbidden", description: "Only email in the Bin, Spam or Drafts can be deleted for good. Move it to the Bin first." };
	}
	const res = await c.internal(c.person, "DELETE", `/mailboxes/${encodeURIComponent(mailbox)}/emails/${encodeURIComponent(id)}`);
	return res.ok ? true : { type: res.status === 404 ? "notFound" : "serverFail" };
}

function addressList(v: unknown): EmailAddress[] {
	if (!Array.isArray(v)) return [];
	return v.filter((a) => a && typeof a.email === "string" && a.email.includes("@"))
		.map((a) => ({ name: typeof a.name === "string" && a.name.trim() ? a.name.trim() : null, email: String(a.email).trim() }));
}

function formatAddresses(list: EmailAddress[]): string {
	return list.map((a) => (a.name ? `"${a.name.replace(/["\\\r\n]/g, "")}" <${a.email}>` : a.email)).join(", ");
}

/** A file an app wants attached: something it uploaded, or an attachment already in this mailbox. */
async function blobBytes(c: Ctx, mailbox: string, blobId: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string; name: string } | null> {
	const ref = parseBlobId(blobId);
	if (!ref) return null;
	if (ref.kind === "upload") {
		const obj = await c.env.BUCKET.get(`${UPLOADS}${mailbox}/${ref.id}`);
		if (!obj) return null;
		return { bytes: new Uint8Array(await obj.arrayBuffer()), type: obj.httpMetadata?.contentType || "application/octet-stream", name: obj.customMetadata?.name || "file" };
	}
	if (ref.kind === "attachment") {
		const email = (await stub(c.env, mailbox).jmapGet([ref.emailId], false)).emails[0];
		const att = email?.attachments.find((a) => a.id === ref.attachmentId);
		if (!att) return null;
		const obj = await c.env.BUCKET.get(`attachments/${ref.emailId}/${att.id}/${att.filename}`);
		if (!obj) return null;
		return { bytes: new Uint8Array(await obj.arrayBuffer()), type: att.mimetype, name: att.filename };
	}
	return null;
}

/** Email/set create: the email is put together as a standard email file and added to its folder. */
async function createEmail(c: Ctx, st: RequestState, mailbox: string, d: Args) {
	const boxes = Object.entries((d.mailboxIds ?? {}) as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => resolveId(st, k));
	if (boxes.length !== 1) throw new MethodError("invalidProperties", "Give exactly one mailbox in mailboxIds.");
	const folder = boxes[0];
	const keywords = (d.keywords ?? {}) as Record<string, unknown>;
	const from = addressList(d.from);
	const to = addressList(d.to), cc = addressList(d.cc), bcc = addressList(d.bcc), replyTo = addressList(d.replyTo);
	const values = (d.bodyValues ?? {}) as Record<string, { value?: unknown }>;
	const partText = (list: unknown): { value: string; html: boolean } | null => {
		if (!Array.isArray(list) || !list[0]) return null;
		const p = list[0] as { partId?: string; type?: string };
		const v = p.partId ? values[p.partId]?.value : undefined;
		return typeof v === "string" ? { value: v, html: p.type === "text/html" } : null;
	};
	const html = partText(d.htmlBody);
	const text = partText(d.textBody);
	let body = html?.html ? html.value : text?.value ?? html?.value ?? "";
	if (!body && d.bodyStructure) throw new MethodError("invalidProperties", "Send the body as textBody or htmlBody with bodyValues.");
	if (body && !html?.html && isHtmlBody(body)) body = body.replace(/</g, "&lt;");

	const files: StoredFile[] = [];
	let total = 0;
	for (const a of (Array.isArray(d.attachments) ? d.attachments : []) as Args[]) {
		if (typeof a?.blobId !== "string") throw new MethodError("invalidProperties", "Each attachment needs a blobId.");
		const blob = await blobBytes(c, mailbox, a.blobId);
		if (!blob) throw new MethodError("blobNotFound", `File ${a.blobId} wasn't found. Upload it again.`);
		total += blob.bytes.byteLength;
		files.push({
			filename: typeof a.name === "string" && a.name ? a.name : blob.name,
			mimetype: typeof a.type === "string" && a.type ? a.type : blob.type,
			content_id: typeof a.cid === "string" ? a.cid : null,
			disposition: a.disposition === "inline" ? "inline" : "attachment",
			bytes: blob.bytes,
		});
	}
	if (total > CORE_LIMITS.maxSizeUpload) throw new MethodError("tooLarge", "The attachments come to more than 25 MB.");

	const headers: { key: string; value: string }[] = [];
	if (from.length) headers.push({ key: "from", value: formatAddresses(from) });
	if (to.length) headers.push({ key: "to", value: formatAddresses(to) });
	if (cc.length) headers.push({ key: "cc", value: formatAddresses(cc) });
	if (bcc.length) headers.push({ key: "bcc", value: formatAddresses(bcc) });
	if (replyTo.length) headers.push({ key: "reply-to", value: formatAddresses(replyTo) });
	const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.replace(/^<|>$/g, "")) : []);
	const inReplyTo = ids(d.inReplyTo)[0] ?? null;
	const refs = ids(d.references);
	const id = crypto.randomUUID();
	const raw = buildMessage({
		id,
		subject: typeof d.subject === "string" ? d.subject : "",
		sender: from[0]?.email ?? mailbox, sender_name: from[0]?.name ?? null,
		date: typeof d.sentAt === "string" ? d.sentAt : typeof d.receivedAt === "string" ? d.receivedAt : new Date().toISOString(),
		body, in_reply_to: inReplyTo, email_references: refs.length ? JSON.stringify(refs) : null,
		raw_headers: JSON.stringify(headers),
	}, files);
	const q = new URLSearchParams({ folder, read: keywords.$seen === true || folder === "draft" ? "1" : "0", starred: keywords.$flagged === true ? "1" : "0" });
	const res = await c.internal(c.person, "POST", `/mailboxes/${encodeURIComponent(mailbox)}/append?${q}`, raw, "message/rfc822");
	const out = await res.json().catch(() => ({})) as { id?: string; error?: string };
	if (!res.ok || !out.id) throw new MethodError(res.status === 404 ? "invalidProperties" : "serverFail", out.error ?? "Couldn't save the email.");
	const row = (await stub(c.env, mailbox).jmapGet([out.id], false)).emails[0];
	return { id: out.id, blobId: emailBlobId(out.id), threadId: toJmapId(row?.thread_id || out.id), size: row?.size ?? raw.length };
}

async function emailImport(c: Ctx, st: RequestState, args: Args): Promise<MethodResult> {
	need(c, "organise");
	const { accountId, mailbox } = accountOf(c, args);
	const s = stub(c.env, mailbox);
	const oldState = String((await s.jmapCursor()).cursor);
	const created: Record<string, unknown> = {}, notCreated: Record<string, unknown> = {};
	for (const [cid, e] of Object.entries((args.emails ?? {}) as Record<string, Args>)) {
		const boxes = Object.entries((e?.mailboxIds ?? {}) as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => resolveId(st, k));
		if (boxes.length !== 1) { notCreated[cid] = { type: "invalidProperties", properties: ["mailboxIds"] }; continue; }
		const ref = typeof e.blobId === "string" ? parseBlobId(e.blobId) : null;
		const obj = ref?.kind === "upload" ? await c.env.BUCKET.get(`${UPLOADS}${mailbox}/${ref.id}`) : null;
		if (!obj) { notCreated[cid] = { type: "blobNotFound" }; continue; }
		const k = (e.keywords ?? {}) as Record<string, unknown>;
		const q = new URLSearchParams({ folder: boxes[0], read: k.$seen === true ? "1" : "0", starred: k.$flagged === true ? "1" : "0" });
		const res = await c.internal(c.person, "POST", `/mailboxes/${encodeURIComponent(mailbox)}/append?${q}`, await obj.arrayBuffer(), "message/rfc822");
		const out = await res.json().catch(() => ({})) as { id?: string; error?: string };
		if (!res.ok || !out.id) { notCreated[cid] = { type: "invalidEmail", description: out.error }; continue; }
		const row = (await s.jmapGet([out.id], false)).emails[0];
		st.created.set(cid, out.id);
		created[cid] = { id: out.id, blobId: emailBlobId(out.id), threadId: toJmapId(row?.thread_id || out.id), size: row?.size ?? 0 };
	}
	return [["Email/import", { accountId, oldState, newState: String((await s.jmapCursor()).cursor), created: orNull(created), notCreated: orNull(notCreated) }, ""]];
}

// -- Identities ------------------------------------------------------------------------------------

type IdentityExtras = { name?: string; textSignature?: string; htmlSignature?: string; replyTo?: EmailAddress[] | null };
type IdentityFile = Record<string, Record<string, IdentityExtras>>;

async function loadIdentityFile(bucket: R2Bucket): Promise<IdentityFile> {
	try { const o = await bucket.get(IDENTITIES_KEY); return o ? ((await o.json()) as IdentityFile) : {}; } catch { return {}; }
}

async function identities(c: Ctx, mailbox: string) {
	const [addresses, book, extras, settings] = await Promise.all([
		sendableFor(c.env.BUCKET, mailbox),
		loadAddressBook(c.env.BUCKET),
		loadIdentityFile(c.env.BUCKET),
		c.env.BUCKET.get(`mailboxes/${mailbox}.json`).then((o) => (o ? o.json() : null)).catch(() => null) as Promise<{ name?: string; settings?: { fromName?: string; signature?: { enabled?: boolean; text?: string } } } | null>,
	]);
	const aliases = new Map(aliasesOf(book, mailbox).map((a) => [a.address, a]));
	const ownName = settings?.settings?.fromName || settings?.name || "";
	const ownSig = settings?.settings?.signature?.enabled ? settings.settings.signature.text ?? "" : "";
	return [...new Set(addresses.map((a) => a.toLowerCase()))].map((email) => {
		const alias = aliases.get(email);
		const x = extras[mailbox]?.[email] ?? {};
		return {
			id: toJmapId(email), email,
			name: x.name ?? alias?.name ?? ownName,
			replyTo: x.replyTo ?? null, bcc: null,
			textSignature: x.textSignature ?? alias?.signature ?? ownSig,
			htmlSignature: x.htmlSignature ?? "",
			mayDelete: false,
		};
	});
}

async function identityGet(c: Ctx, args: Args): Promise<MethodResult> {
	const { accountId, mailbox } = accountOf(c, args);
	const all = await identities(c, mailbox);
	const ids = idsArg(args);
	const list = ids ? all.filter((i) => ids.includes(i.id)) : all;
	return [["Identity/get", { accountId, state: shortHash(JSON.stringify(all)), list, notFound: ids ? ids.filter((id) => !all.some((i) => i.id === id)) : [] }, ""]];
}

async function identitySet(c: Ctx, st: RequestState, args: Args): Promise<MethodResult> {
	need(c, "send");
	const { accountId, mailbox } = accountOf(c, args);
	const before = await identities(c, mailbox);
	const oldState = shortHash(JSON.stringify(before));
	const created: Record<string, unknown> = {}, notCreated: Record<string, unknown> = {};
	const updated: Record<string, unknown> = {}, notUpdated: Record<string, unknown> = {};
	const notDestroyed: Record<string, unknown> = {};
	const file = await loadIdentityFile(c.env.BUCKET);
	const mine = (file[mailbox] ??= {});
	const clean = (p: Args): IdentityExtras => {
		const x: IdentityExtras = {};
		if (typeof p.name === "string") x.name = p.name.slice(0, 100);
		if (typeof p.textSignature === "string") x.textSignature = p.textSignature.slice(0, 4000);
		if (typeof p.htmlSignature === "string") x.htmlSignature = p.htmlSignature.slice(0, 8000);
		if ("replyTo" in p) x.replyTo = p.replyTo == null ? null : addressList(p.replyTo);
		return x;
	};
	for (const [cid, p] of Object.entries((args.create ?? {}) as Record<string, Args>)) {
		const email = typeof p?.email === "string" ? p.email.toLowerCase() : "";
		const found = before.find((i) => i.email === email);
		// Only the mailbox's own addresses can be sent from; adding one is done in Settings.
		if (!found) { notCreated[cid] = { type: "forbiddenFrom", description: "Add this address to the mailbox in Mail App's Settings first." }; continue; }
		mine[email] = { ...mine[email], ...clean(p) };
		st.created.set(cid, found.id);
		created[cid] = { id: found.id, mayDelete: false };
	}
	for (const [id, p] of Object.entries((args.update ?? {}) as Record<string, Args>)) {
		const found = before.find((i) => i.id === resolveId(st, id));
		if (!found) { notUpdated[id] = { type: "notFound" }; continue; }
		if (p && "email" in p && p.email !== found.email) { notUpdated[id] = { type: "invalidProperties", properties: ["email"] }; continue; }
		mine[found.email] = { ...mine[found.email], ...clean(p ?? {}) };
		updated[id] = null;
	}
	for (const id of (Array.isArray(args.destroy) ? args.destroy : []) as string[]) notDestroyed[id] = { type: "forbidden", description: "Addresses are removed in Mail App's Settings." };
	if (Object.keys(created).length || Object.keys(updated).length) await c.env.BUCKET.put(IDENTITIES_KEY, JSON.stringify(file), { httpMetadata: { contentType: "application/json" } });
	const after = await identities(c, mailbox);
	return [["Identity/set", {
		accountId, oldState, newState: shortHash(JSON.stringify(after)),
		created: orNull(created), updated: orNull(updated), destroyed: null,
		notCreated: orNull(notCreated), notUpdated: orNull(notUpdated), notDestroyed: orNull(notDestroyed),
	}, ""]];
}

// -- Sending ---------------------------------------------------------------------------------------

function base64(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

/** When FUTURERELEASE asks to hold it (HOLDUNTIL a date, or HOLDFOR seconds), in ms; null to send now. */
function holdUntil(envelope: unknown): number | null {
	const params = (envelope as { mailFrom?: { parameters?: Record<string, unknown> } } | null)?.mailFrom?.parameters;
	if (!params) return null;
	if (typeof params.HOLDUNTIL === "string") { const t = Date.parse(params.HOLDUNTIL); return Number.isNaN(t) ? null : t; }
	const f = Number(params.HOLDFOR);
	return Number.isFinite(f) && f > 0 ? Date.now() + f * 1000 : null;
}

async function submissionSet(c: Ctx, st: RequestState, args: Args): Promise<MethodResult> {
	need(c, "send");
	const { accountId, mailbox } = accountOf(c, args);
	const s = stub(c.env, mailbox);
	const created: Record<string, unknown> = {}, notCreated: Record<string, unknown> = {};
	const sentEmails = new Map<string, string>(); // creation id → email id
	const ids = await identities(c, mailbox);

	for (const [cid, sub] of Object.entries((args.create ?? {}) as Record<string, Args>)) {
		const emailId = typeof sub?.emailId === "string" ? resolveId(st, sub.emailId) : "";
		const identity = ids.find((i) => i.id === resolveId(st, String(sub?.identityId ?? "")));
		if (!identity) { notCreated[cid] = { type: "invalidProperties", properties: ["identityId"] }; continue; }
		const row = (await s.jmapGet([emailId], true)).emails[0];
		if (!row) { notCreated[cid] = { type: "invalidProperties", properties: ["emailId"], description: "That email wasn't found." }; continue; }
		const env = sub.envelope as { rcptTo?: { email?: string }[] } | undefined;
		const fromEmail = (row.sender || identity.email).toLowerCase();
		if (!ids.some((i) => i.email === fromEmail)) { notCreated[cid] = { type: "forbiddenFrom", description: "This mailbox can't send from that address." }; continue; }
		const list = (v: string | null) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
		const to = list(row.recipient), cc = list(row.cc), bcc = list(row.bcc);
		if (env?.rcptTo?.length) {
			// The envelope wins: anyone in it but not in the headers is sent a blind copy.
			const inHeaders = new Set([...to, ...cc, ...bcc].map((x) => x.toLowerCase()));
			for (const r of env.rcptTo) if (r.email && !inHeaders.has(r.email.toLowerCase())) bcc.push(r.email);
		}
		if (!to.length && !cc.length && !bcc.length) { notCreated[cid] = { type: "noRecipients" }; continue; }
		const files: { content: string; filename: string; type: string; disposition: "attachment" | "inline"; contentId?: string }[] = [];
		for (const a of row.attachments) {
			const obj = await c.env.BUCKET.get(`attachments/${row.id}/${a.id}/${a.filename}`);
			if (!obj) continue;
			files.push({
				content: base64(new Uint8Array(await obj.arrayBuffer())), filename: a.filename, type: a.mimetype,
				disposition: a.disposition === "inline" ? "inline" : "attachment", ...(a.content_id ? { contentId: a.content_id.replace(/^<|>$/g, "") } : {}),
			});
		}
		const html = isHtmlBody(row.body);
		const refs = references(row) ?? undefined;
		const sendAt = holdUntil(sub.envelope);
		const name = row.sender_name || identity.name;
		const payload = {
			to: to.length ? to : (cc.length ? cc : bcc), ...(to.length && cc.length ? { cc } : {}), ...(bcc.length && (to.length || cc.length) ? { bcc } : {}),
			from: name ? { email: fromEmail, name } : fromEmail,
			subject: row.subject ?? "",
			...(html ? { html: row.body ?? "", text: textOf(row.body) } : { text: row.body || " " }),
			...(files.length ? { attachments: files } : {}),
			...(row.in_reply_to ? { in_reply_to: row.in_reply_to.replace(/^<|>$/g, "") } : {}),
			...(refs ? { references: refs } : {}),
			...(row.thread_id ? { thread_id: row.thread_id } : {}),
			...(sendAt && sendAt > Date.now() + 30_000 ? { send_at: sendAt } : {}),
		};
		const res = await c.internal(c.person, "POST", `/mailboxes/${encodeURIComponent(mailbox)}/emails`, JSON.stringify(payload), "application/json");
		const out = await res.json().catch(() => ({})) as { id?: string; status?: string; error?: string };
		if (!res.ok || !out.id) {
			notCreated[cid] = { type: res.status === 429 ? "rateLimit" : res.status === 400 ? "invalidEmail" : "forbiddenToSend", description: out.error ?? "Sending failed." };
			continue;
		}
		const subId = `S${out.id}`;
		st.created.set(cid, subId);
		sentEmails.set(cid, emailId);
		created[cid] = { id: subId, sendAt: new Date(payload.send_at ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z"), undoStatus: out.status === "scheduled" ? "pending" : "final" };
	}

	const out: MethodResult = [["EmailSubmission/set", {
		accountId, oldState: "0", newState: "0", created: orNull(created), notCreated: orNull(notCreated), updated: null, destroyed: null, notUpdated: null, notDestroyed: null,
	}, ""]];

	// Mail App files its own copy in Sent (or Scheduled) as it sends, so whatever the app asked to happen to the
	// draft afterwards (move it to Sent, or destroy it), the draft is simply removed.
	const after = new Set<string>();
	const wanted = (v: unknown) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.keys(v) : []) as string[];
	for (const ref of [...wanted(args.onSuccessUpdateEmail), ...wanted(args.onSuccessDestroyEmail)]) {
		const cid = ref.startsWith("#") ? ref.slice(1) : null;
		const emailId = cid ? sentEmails.get(cid) : [...sentEmails.entries()].find(([k]) => created[k] && (created[k] as { id: string }).id === ref)?.[1];
		if (emailId) after.add(emailId);
	}
	if (after.size) {
		const oldState = String((await s.jmapCursor()).cursor);
		const destroyed: string[] = [];
		const notDestroyed: Record<string, unknown> = {};
		for (const id of after) {
			if ((await s.emailFolder(id)) !== "draft") continue;
			const r = await destroyEmail(c, mailbox, id);
			if (r === true) destroyed.push(id); else notDestroyed[id] = r;
		}
		out.push(["Email/set", { accountId, oldState, newState: String((await s.jmapCursor()).cursor), created: null, updated: null, destroyed: destroyed.length ? destroyed : null, notCreated: null, notUpdated: null, notDestroyed: orNull(notDestroyed) }, ""]);
	}
	return out;
}

// -- Files -----------------------------------------------------------------------------------------

async function download(c: Ctx, path: string, url: URL): Promise<Response> {
	if (!c.scopes.has("read")) return problem(403, "about:blank", "This API key can't read mail.");
	const [, , accountId, blobId, ...rest] = path.split("/");
	const mailbox = c.accounts.get(decodeURIComponent(accountId ?? ""));
	if (!mailbox) return problem(404, "about:blank", "Account not found.");
	const ref = parseBlobId(decodeURIComponent(blobId ?? ""));
	if (!ref) return problem(404, "about:blank", "File not found.");
	const name = decodeURIComponent(rest.join("/") || "file").replace(/[\r\n"\\]/g, "_");
	const type = url.searchParams.get("type") || "application/octet-stream";
	const headers = (t: string) => ({
		"content-type": t, "cache-control": "private, max-age=3600",
		"content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
		"x-content-type-options": "nosniff",
	});
	if (ref.kind === "email") {
		const res = await c.internal(c.person, "GET", `/mailboxes/${encodeURIComponent(mailbox)}/emails/${encodeURIComponent(ref.emailId)}/raw`);
		if (!res.ok) return problem(404, "about:blank", "File not found.");
		return new Response(res.body, { headers: headers(url.searchParams.get("type") || "message/rfc822") });
	}
	if (ref.kind === "body") {
		const row = (await stub(c.env, mailbox).jmapGet([ref.emailId], true)).emails[0];
		if (!row) return problem(404, "about:blank", "File not found.");
		const body = ref.part === "html" ? row.body ?? "" : isHtmlBody(row.body) ? textOf(row.body) : row.body ?? "";
		return new Response(body, { headers: headers(`${ref.part === "html" ? "text/html" : "text/plain"}; charset=utf-8`) });
	}
	const blob = await blobBytes(c, mailbox, decodeURIComponent(blobId));
	if (!blob) return problem(404, "about:blank", "File not found.");
	return new Response(blob.bytes, { headers: headers(type === "application/octet-stream" ? blob.type : type) });
}

async function upload(c: Ctx, path: string, req: Request): Promise<Response> {
	if (!c.scopes.has("send") && !c.scopes.has("organise")) return problem(403, "about:blank", "This API key can't add files.");
	const accountId = decodeURIComponent(path.split("/")[2] ?? "");
	const mailbox = c.accounts.get(accountId);
	if (!mailbox) return problem(404, "about:blank", "Account not found.");
	const length = Number(req.headers.get("content-length") ?? 0);
	if (length > CORE_LIMITS.maxSizeUpload) return problem(413, "urn:ietf:params:jmap:error:limit", "That file is bigger than 25 MB.");
	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.byteLength > CORE_LIMITS.maxSizeUpload) return problem(413, "urn:ietf:params:jmap:error:limit", "That file is bigger than 25 MB.");
	const type = (req.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
	const id = crypto.randomUUID().replace(/-/g, "");
	await c.env.BUCKET.put(`${UPLOADS}${mailbox}/${id}`, bytes, { httpMetadata: { contentType: type }, customMetadata: { at: String(Date.now()) } });
	c.ctx.waitUntil(clearOldUploads(c.env.BUCKET, mailbox).catch(() => {}));
	return json({ accountId, blobId: `U${id}`, type, size: bytes.byteLength }, 201);
}

/** Uploads are only needed until the email using them is saved: anything older than a day goes. */
async function clearOldUploads(bucket: R2Bucket, mailbox: string): Promise<void> {
	const list = await bucket.list({ prefix: `${UPLOADS}${mailbox}/`, limit: 1000 });
	const old = list.objects.filter((o) => Date.now() - o.uploaded.getTime() > UPLOAD_LIFE_MS).map((o) => o.key);
	if (old.length) await bucket.delete(old);
}

// -- Push ------------------------------------------------------------------------------------------

/**
 * Server-sent events (RFC 8620 7.3). Mail App has no live feed from mailboxes to here, so each open
 * connection looks every 10 seconds (one small Durable Object request) and sends a "state" event when
 * something changed. Connections close after 25 minutes; apps reconnect on their own.
 */
async function eventSource(c: Ctx, url: URL): Promise<Response> {
	if (!c.scopes.has("read")) return problem(403, "about:blank", "This API key can't read mail.");
	const ping = Math.min(Math.max(Number(url.searchParams.get("ping")) || 0, 0), 300);
	const closeAfterState = url.searchParams.get("closeafter") === "state";
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const enc = new TextEncoder();
	const send = (event: string, data: unknown) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
	const look = async () => {
		const out: Record<string, { Email: string; Thread: string; Mailbox: string }> = {};
		await Promise.all([...c.accounts].map(async ([id, mailbox]) => {
			const r = await stub(c.env, mailbox).jmapCursor();
			out[id] = { Email: String(r.cursor), Thread: String(r.cursor), Mailbox: `${r.folderState}.${r.cursor}` };
		}));
		return out;
	};
	const loop = async () => {
		const started = Date.now();
		let last = await look();
		let lastPing = Date.now();
		await send("state", { "@type": "StateChange", changed: last });
		while (Date.now() - started < EVENT_MAX_MS) {
			await new Promise((r) => setTimeout(r, EVENT_POLL_MS));
			const now = await look();
			const changed: Record<string, unknown> = {};
			for (const [id, s] of Object.entries(now)) {
				const was = last[id];
				const diff: Record<string, string> = {};
				for (const t of ["Email", "Thread", "Mailbox"] as const) if (!was || was[t] !== s[t]) diff[t] = s[t];
				if (Object.keys(diff).length) changed[id] = diff;
			}
			last = now;
			if (Object.keys(changed).length) {
				await send("state", { "@type": "StateChange", changed });
				if (closeAfterState) break;
			} else if (ping && Date.now() - lastPing >= ping * 1000) {
				await send("ping", { interval: ping });
				lastPing = Date.now();
			}
		}
	};
	c.ctx.waitUntil(loop().catch(() => {}).finally(() => writer.close().catch(() => {})));
	return new Response(readable, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
