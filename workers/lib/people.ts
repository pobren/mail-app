// Mail App addition (not part of upstream Agentic Inbox).
// Reads and saves the install's people list (shared/people.ts) in R2, works out who is signed in,
// and keeps people out of mailboxes that aren't theirs.
import { createMiddleware } from "hono/factory";
import { PEOPLE_KEY, PLAN, cleanPeople, findPerson, firstAdmin, isShared, ownerAddresses, shouldMarkSeen, withPerson, type PeopleBook, type Person, type Plan } from "../../shared/people";
import { listMailboxes } from "./email-helpers";
import type { Env } from "../types";

/** Local development only: who you are signed in as (a header or cookie, so tests can switch people). */
export const DEV_AS = "dev-as";
export const DEV_DEFAULT_EMAIL = "owner@example.com";

export type PeopleVars = {
	/** The sign-in address Cloudflare Access checked. */
	viewer: string;
	/** Their entry on the people list. */
	person: Person;
};

interface Loaded {
	book: PeopleBook;
	/** null when there's no people list yet. */
	etag: string | null;
}

export async function loadPeople(bucket: R2Bucket): Promise<Loaded> {
	const obj = await bucket.get(PEOPLE_KEY);
	if (!obj) return { book: cleanPeople(null), etag: null };
	try {
		return { book: cleanPeople(await obj.json()), etag: obj.etag };
	} catch {
		return { book: cleanPeople(null), etag: obj.etag };
	}
}

export class PeopleConflict extends Error {}

/**
 * Changes the people list safely when two changes happen at once: reads it, applies `change`, and
 * only saves if nobody else saved in between (otherwise tries again). `change` returns the new list,
 * or a string to stop with that message.
 */
export async function updatePeople<T extends PeopleBook>(
	bucket: R2Bucket,
	change: (book: PeopleBook) => T | string | Promise<T | string>,
): Promise<T | string> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const { book, etag } = await loadPeople(bucket);
		const next = await change(book);
		if (typeof next === "string") return next;
		const body = JSON.stringify(cleanPeople(next));
		const opts: R2PutOptions = { httpMetadata: { contentType: "application/json" } };
		// Only save if nobody else did since we read it. (The very first save has nothing to compare with.)
		if (etag) opts.onlyIf = { etagMatches: etag };
		const saved = await bucket.put(PEOPLE_KEY, body, opts);
		if (saved) return next;
	}
	throw new PeopleConflict("The people list is busy. Please try again.");
}

/** What this install allows (everything: Mail App is free). */
export async function loadPlan(_env: Env): Promise<Plan> {
	return PLAN;
}

/** Who is signing in, in local development (where there's no Cloudflare Access). */
export function devViewer(req: Request): string {
	const header = req.headers.get(DEV_AS);
	if (header) return header.trim().toLowerCase();
	const cookie = (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${DEV_AS}=`));
	if (cookie) return decodeURIComponent(cookie.slice(DEV_AS.length + 1)).trim().toLowerCase();
	return DEV_DEFAULT_EMAIL;
}

export type Admission =
	| { ok: true; person: Person }
	| { ok: false; reason: "not-invited" | "suspended" };

/**
 * Lets a signed-in address in, or says why not. The very first sign-in on an install with no people
 * list becomes its admin (only the owner could get past Cloudflare Access until now). If the
 * installer told us who the owner is, only that address can do so.
 */
export async function admit(env: Env, viewer: string, ctx?: ExecutionContext): Promise<Admission> {
	let { book, etag } = await loadPeople(env.BUCKET);
	if (!etag) {
		const owners = ownerAddresses(env.OWNER_EMAIL, env.BACKUP_EMAIL);
		if (owners.length && !owners.includes(viewer)) return { ok: false, reason: "not-invited" };
		const now = new Date().toISOString();
		const mailboxes = (await listMailboxes(env.BUCKET)).map((m) => m.email);
		const created = await updatePeople(env.BUCKET, (b) => (b.people.length ? b : firstAdmin(viewer, mailboxes, now)));
		if (typeof created !== "string") book = created;
	}
	let person = findPerson(book, viewer);
	// The owner of the Cloudflare account can always get back in, as an admin.
	if (isOwner(env, viewer, book) && (!person || person.role !== "admin" || person.status === "suspended")) {
		const now = new Date().toISOString();
		const fixed = await updatePeople(env.BUCKET, (b) => {
			const p = findPerson(b, viewer);
			return p
				? withPerson(b, { ...p, role: "admin", status: "active" })
				: { ...b, people: [...b.people, { ...firstAdmin(viewer, [], now).people[0] }] };
		});
		if (typeof fixed !== "string") person = findPerson(fixed, viewer);
	}
	if (!person) return { ok: false, reason: "not-invited" };
	if (person.status === "suspended") return { ok: false, reason: "suspended" };
	if (shouldMarkSeen(person, Date.now())) {
		const mark = updatePeople(env.BUCKET, (b) => {
			const p = findPerson(b, viewer);
			if (!p || p.status === "suspended") return "gone";
			return withPerson(b, { ...p, status: "active", lastSeenAt: new Date().toISOString() });
		}).catch(() => {});
		if (ctx) ctx.waitUntil(mark);
		else await mark;
	}
	return { ok: true, person: person.status === "invited" ? { ...person, status: "active" } : person };
}

/**
 * The person who installed Mail App on their Cloudflare account: the installer says who (OWNER_EMAIL, and
 * BACKUP_EMAIL if they gave a second address); before it has, it's whoever signed in first.
 */
export function isOwner(env: Env, email: string, book?: PeopleBook): boolean {
	const owners = ownerAddresses(env.OWNER_EMAIL, env.BACKUP_EMAIL);
	if (!owners.length && book?.owner) owners.push(book.owner);
	return owners.includes(email.trim().toLowerCase());
}

/** API routes only an admin may use. */
export const requireAdmin = createMiddleware<{ Bindings: Env; Variables: PeopleVars }>(async (c, next) => {
	if (c.var.person?.role !== "admin") return c.json({ error: "Only an admin can do that." }, 403);
	await next();
});

/**
 * Who wrote an email sent from a shared mailbox, kept with the copy in Sent so the team can see who
 * replied. Nothing is kept for a mailbox only one person uses.
 */
export async function sentBy(env: Env, person: Person | undefined, mailbox: string): Promise<{ sent_by?: string; sent_by_name?: string }> {
	if (!person) return {};
	const { book } = await loadPeople(env.BUCKET);
	if (!isShared(book, mailbox)) return {};
	return { sent_by: person.email, sent_by_name: person.name };
}
