// Mail App 2.6: JMAP (RFC 8620 core, RFC 8621 mail), so JMAP apps can use Mail App: our own Mac and
// iPhone apps, and others that let you type in a server. The parts here need no Cloudflare and are
// tested on their own (test/jmap.test.ts). The server side is workers/jmap/.
//
// Where it lives: https://<install>/api/ext/jmap/session (the Session resource). It's under /api/ext/,
// which the installer already lets past Cloudflare sign-in, and it uses the same API keys (Admin > API &
// webhooks), sent as `Authorization: Bearer mailapp_…` or as the password with Basic sign-in (the user
// name is ignored). One JMAP account per mailbox the key can reach; the account id is the mailbox address.

import { removeHiddenBlocks, removeTags } from "./html-text.ts";

export const JMAP_PREFIX = "/api/ext/jmap";

export const CAP_CORE = "urn:ietf:params:jmap:core";
export const CAP_MAIL = "urn:ietf:params:jmap:mail";
export const CAP_SUBMISSION = "urn:ietf:params:jmap:submission";

/** What we tell apps about ourselves (RFC 8620 section 2). */
export const CORE_LIMITS = {
	maxSizeUpload: 25 * 1024 * 1024,
	maxConcurrentUpload: 4,
	maxSizeRequest: 10 * 1024 * 1024,
	maxConcurrentRequests: 4,
	maxCallsInRequest: 32,
	maxObjectsInGet: 500,
	maxObjectsInSet: 500,
	collationAlgorithms: ["i;ascii-casemap", "i;unicode-casemap"],
};

/** Folder ids that have a JMAP role (RFC 8621 section 2, IANA mailbox roles). */
const ROLES: Record<string, string> = {
	inbox: "inbox",
	sent: "sent",
	draft: "drafts",
	archive: "archive",
	trash: "trash",
	spam: "junk",
	scheduled: "scheduled",
	snoozed: "snoozed",
};

export function roleOf(folderId: string): string | null {
	return ROLES[folderId] ?? null;
}

/** The order folders are listed in apps: the usual ones first, then the person's own, by name. */
export function sortOrderOf(folderId: string): number {
	const order = ["inbox", "snoozed", "scheduled", "draft", "sent", "archive", "spam", "trash"];
	const i = order.indexOf(folderId);
	return i === -1 ? 100 : (i + 1) * 10;
}

// -- Keywords --------------------------------------------------------------------------------------

/** Mail App keeps read and starred; JMAP calls them $seen and $flagged. Drafts are $draft by folder. */
export function keywordsOf(e: { read: boolean; starred: boolean; folder: string }): Record<string, true> {
	const k: Record<string, true> = {};
	if (e.read) k.$seen = true;
	if (e.starred) k.$flagged = true;
	if (e.folder === "draft") k.$draft = true;
	return k;
}

/** The read and starred changes in an Email/set update, whole ("keywords") or by path ("keywords/$seen"). */
export function flagsFromPatch(patch: Record<string, unknown>): { read?: boolean; starred?: boolean } {
	const out: { read?: boolean; starred?: boolean } = {};
	if (patch.keywords && typeof patch.keywords === "object") {
		const k = patch.keywords as Record<string, unknown>;
		out.read = k.$seen === true;
		out.starred = k.$flagged === true;
	}
	for (const [path, value] of Object.entries(patch)) {
		if (path === "keywords/$seen") out.read = value === true;
		if (path === "keywords/$flagged") out.starred = value === true;
	}
	return out;
}

/** The folder an Email/set update moves an email to, if it does. Mail App keeps each email in one folder. */
export function folderFromPatch(patch: Record<string, unknown>, current: string): string | null | "many" {
	if (patch.mailboxIds && typeof patch.mailboxIds === "object") {
		const ids = Object.entries(patch.mailboxIds as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => k);
		if (ids.length !== 1) return "many";
		return ids[0] === current ? null : ids[0];
	}
	// By path: "mailboxIds/<new>": true (with or without "mailboxIds/<old>": null). The email moves to <new>.
	let added: string | null = null;
	for (const [path, value] of Object.entries(patch)) {
		const m = /^mailboxIds\/(.+)$/.exec(path);
		if (!m || value !== true) continue;
		const id = m[1].replace(/~1/g, "/").replace(/~0/g, "~");
		if (added && added !== id) return "many";
		added = id;
	}
	return added && added !== current ? added : null;
}

// -- Addresses and text ----------------------------------------------------------------------------

export interface EmailAddress { name: string | null; email: string }

/** "a@x.com, b@y.com" (how Mail App stores recipients) as JMAP addresses. */
export function addressesOf(list: string | null | undefined): EmailAddress[] | null {
	if (!list) return null;
	const out = list.split(",").map((s) => s.trim()).filter(Boolean).map((email) => ({ name: null, email }));
	return out.length ? out : null;
}

/** Mail App keeps one body per email: HTML when the email had it, plain text otherwise (as shared/mbox.ts reads it). */
export function isHtmlBody(body: string | null | undefined): boolean {
	return !!body && /<[a-z][^>]*>/i.test(body);
}

/** An email's words as plain text, with line breaks kept. Plain text emails come back as they are. */
export function textOf(body: string | null | undefined): string {
	if (!body) return "";
	if (!isHtmlBody(body)) return body;
	let text = removeHiddenBlocks(body, " ");
	text = text.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d|blockquote)\s*>/gi, "\n");
	text = removeTags(text, "");
	text = text.replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, "&");
	return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Up to 256 characters of an email's words, for the list (RFC 8621 "preview"). */
export function previewOf(body: string | null | undefined): string {
	return textOf(body).replace(/\s+/g, " ").trim().slice(0, 256);
}

/** Message-ID style list ("<a@b>" or JSON array of bare ids) as JMAP's list of ids without brackets. */
export function messageIdsOf(raw: string | null | undefined): string[] | null {
	if (!raw) return null;
	let ids: string[] = [];
	if (raw.trim().startsWith("[")) {
		try { ids = (JSON.parse(raw) as unknown[]).filter((x): x is string => typeof x === "string"); } catch { ids = []; }
	} else {
		ids = raw.split(/\s+/);
	}
	ids = ids.map((s) => s.replace(/^<|>$/g, "").trim()).filter(Boolean);
	return ids.length ? ids : null;
}

// -- Blobs -----------------------------------------------------------------------------------------

// -- Ids -------------------------------------------------------------------------------------------

/** JMAP ids may only use A-Z a-z 0-9 _ - (RFC 8620 1.2). Ids that already do are used as they are; others
 *  (conversation ids made from Message-IDs, mailbox addresses) become "~" and their base64url form. */
export function toJmapId(id: string): string {
	if (/^[A-Za-z0-9_-]{1,255}$/.test(id) && !id.startsWith("~")) return id;
	const bytes = new TextEncoder().encode(id);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return `~${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export function fromJmapId(id: string): string | null {
	if (typeof id !== "string" || !id) return null;
	if (!id.startsWith("~")) return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
	try {
		const bin = atob(id.slice(1).replace(/-/g, "+").replace(/_/g, "/"));
		return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
	} catch {
		return null;
	}
}

/** A whole email's blob ("M" + email id), an attachment's ("A" + email id + "." + attachment id), or an upload ("U" + id). */
export type BlobRef = { kind: "email"; emailId: string } | { kind: "attachment"; emailId: string; attachmentId: string } | { kind: "upload"; id: string } | { kind: "body"; emailId: string; part: "html" | "text" };

export function emailBlobId(emailId: string): string { return `M${emailId}`; }
export function attachmentBlobId(emailId: string, attachmentId: string): string { return `A${emailId}.${attachmentId}`; }
export function uploadBlobId(id: string): string { return `U${id}`; }
/** The email's own words as one part: "H" (as written, HTML or plain) or "T" (plain text). */
export function bodyBlobId(emailId: string, part: "html" | "text"): string { return `${part === "html" ? "H" : "T"}${emailId}`; }

export function parseBlobId(blobId: string): BlobRef | null {
	if (!/^[A-Za-z0-9._-]{2,200}$/.test(blobId)) return null;
	const rest = blobId.slice(1);
	if (blobId[0] === "M") return { kind: "email", emailId: rest };
	if (blobId[0] === "U") return { kind: "upload", id: rest };
	if (blobId[0] === "H") return { kind: "body", emailId: rest, part: "html" };
	if (blobId[0] === "T") return { kind: "body", emailId: rest, part: "text" };
	if (blobId[0] === "A") {
		const dot = rest.indexOf(".");
		if (dot < 1 || dot === rest.length - 1) return null;
		return { kind: "attachment", emailId: rest.slice(0, dot), attachmentId: rest.slice(dot + 1) };
	}
	return null;
}

// -- Queries ---------------------------------------------------------------------------------------

/** The Email/query filters we answer (RFC 8621 4.4.1). Anything else is "unsupportedFilter". */
export interface EmailFilter {
	inMailbox?: string;
	inMailboxOtherThan?: string[];
	before?: string;
	after?: string;
	minSize?: number;
	maxSize?: number;
	hasKeyword?: string;
	notKeyword?: string;
	hasAttachment?: boolean;
	text?: string;
	from?: string;
	to?: string;
	cc?: string;
	bcc?: string;
	subject?: string;
	body?: string;
}

const FILTER_KEYS = new Set(["inMailbox", "inMailboxOtherThan", "before", "after", "minSize", "maxSize", "hasKeyword", "notKeyword", "hasAttachment", "text", "from", "to", "cc", "bcc", "subject", "body", "allInThreadHaveKeyword", "someInThreadHaveKeyword", "noneInThreadHaveKeyword", "header"]);
const KNOWN_KEYWORDS = new Set(["$seen", "$flagged", "$draft"]);

/** A FilterCondition (or a simple AND of them) flattened to one, or the reason it can't be answered. */
export function flattenFilter(filter: unknown): { ok: true; filter: EmailFilter } | { ok: false; reason: string } {
	if (filter == null) return { ok: true, filter: {} };
	if (typeof filter !== "object" || Array.isArray(filter)) return { ok: false, reason: "The filter must be an object." };
	const f = filter as Record<string, unknown>;
	if ("operator" in f) {
		if (f.operator !== "AND" || !Array.isArray(f.conditions)) return { ok: false, reason: "Only AND filters are supported." };
		const out: EmailFilter = {};
		for (const c of f.conditions) {
			const one = flattenFilter(c);
			if (!one.ok) return one;
			for (const [k, v] of Object.entries(one.filter)) {
				if (k in out) return { ok: false, reason: `The filter uses ${k} more than once.` };
				(out as Record<string, unknown>)[k] = v;
			}
		}
		return { ok: true, filter: out };
	}
	for (const k of Object.keys(f)) {
		if (!FILTER_KEYS.has(k)) return { ok: false, reason: `Unknown filter: ${k}` };
		if (k === "allInThreadHaveKeyword" || k === "someInThreadHaveKeyword" || k === "noneInThreadHaveKeyword" || k === "header") return { ok: false, reason: `The ${k} filter isn't supported.` };
	}
	for (const k of ["hasKeyword", "notKeyword"] as const) {
		if (typeof f[k] === "string" && !KNOWN_KEYWORDS.has(f[k] as string)) {
			// Mail App keeps no other keywords: nothing has them.
			if (k === "hasKeyword") return { ok: true, filter: { ...(f as EmailFilter), inMailbox: "\u0000none" } };
			const rest = { ...(f as EmailFilter) };
			delete rest.notKeyword;
			return { ok: true, filter: rest };
		}
	}
	return { ok: true, filter: f as EmailFilter };
}

export type EmailSort = { property: "receivedAt" | "sentAt" | "size" | "from" | "to" | "subject"; isAscending: boolean };

export function sortOf(sort: unknown): EmailSort | "unsupported" {
	if (sort == null) return { property: "receivedAt", isAscending: false };
	if (!Array.isArray(sort) || sort.length === 0) return { property: "receivedAt", isAscending: false };
	const first = sort[0] as { property?: string; isAscending?: boolean };
	const props = ["receivedAt", "sentAt", "size", "from", "to", "subject"];
	if (!first || typeof first.property !== "string" || !props.includes(first.property)) return "unsupported";
	// RFC 8620: isAscending defaults to true.
	return { property: first.property as EmailSort["property"], isAscending: first.isAscending !== false };
}

// -- Requests --------------------------------------------------------------------------------------

export type Invocation = [string, Record<string, unknown>, string];

/** Fills in "#name" arguments from earlier results (RFC 8620 3.7, ResultReference). */
export function resolveBackRefs(args: Record<string, unknown>, done: Invocation[]): { ok: true; args: Record<string, unknown> } | { ok: false; error: Record<string, unknown> } {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (!key.startsWith("#")) { out[key] = value; continue; }
		const name = key.slice(1);
		if (name in args) return { ok: false, error: { type: "invalidArguments", description: `Both ${name} and #${name} were given.` } };
		const ref = value as { resultOf?: string; name?: string; path?: string };
		const source = done.find((d) => d[2] === ref?.resultOf && d[0] === ref?.name);
		if (!source || typeof ref.path !== "string") return { ok: false, error: { type: "invalidResultReference" } };
		const found = jsonPointer(source[1], ref.path);
		if (found === undefined) return { ok: false, error: { type: "invalidResultReference" } };
		out[name] = found;
	}
	return { ok: true, args: out };
}

/** RFC 8620 JSON pointer, with "*" meaning "the same path in every item of this array" (flattened). */
export function jsonPointer(value: unknown, path: string): unknown {
	if (path === "" || path === "/") return value;
	const parts = path.replace(/^\//, "").split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
	let cur: unknown = value;
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p === "*") {
			if (!Array.isArray(cur)) return undefined;
			const rest = "/" + parts.slice(i + 1).join("/");
			const items = cur.map((item) => jsonPointer(item, rest));
			if (items.some((x) => x === undefined)) return undefined;
			return items.flatMap((x) => (Array.isArray(x) ? x : [x]));
		}
		if (Array.isArray(cur)) {
			const n = Number(p);
			if (!Number.isInteger(n) || n < 0 || n >= cur.length) return undefined;
			cur = cur[n];
		} else if (cur && typeof cur === "object") {
			if (!(p in (cur as Record<string, unknown>))) return undefined;
			cur = (cur as Record<string, unknown>)[p];
		} else return undefined;
	}
	return cur;
}

/** Turns "Basic base64(user:key)" or "Bearer key" into the key. */
export function keyFromAuthorization(header: string | null): string | null {
	if (!header) return null;
	const bearer = /^bearer\s+(.+)$/i.exec(header);
	if (bearer) return bearer[1].trim() || null;
	const basic = /^basic\s+(.+)$/i.exec(header);
	if (!basic) return null;
	let decoded = "";
	try { decoded = atob(basic[1].trim()); } catch { return null; }
	const colon = decoded.indexOf(":");
	const pass = colon === -1 ? "" : decoded.slice(colon + 1);
	return pass.trim() || null;
}
