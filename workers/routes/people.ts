// Mail App addition (not part of upstream Agentic Inbox).
// Team access API: who's signed in, the People page (invite, change, pause, remove), an admin's
// logged access to someone else's mailbox, each mailbox's access log.
import { Hono } from "hono";
import { z } from "zod";
import {
	MAX_NAME,
	MAX_SIGNATURE,
	addLog,
	canOpen,
	cleanSignature,
	findPerson,
	isLastAdmin,
	isShared,
	invitePeopleProblem,
	logFor,
	mailboxesProblem,
	openable,
	peopleCount,
	signInList,
	usersOf,
	withPerson,
	type PeopleBook,
	type Person,
	type Role,
} from "../../shared/people";
import { listMailboxes } from "../lib/email-helpers";
import { PeopleConflict, isOwner, loadPeople, loadPlan, requireAdmin, updatePeople } from "../lib/people";
import { ACCESS_TOKEN_KEY, accessSyncAvailable, signInChecksPeopleList, checkAccessToken, signOutEverywhere, syncSignInList, type SyncResult } from "../lib/access-sync";
import { sendInvite } from "../lib/invite";
import { createMailbox } from "../lib/new-mailbox";
import { loadAddressBook, loadDomainsFile, saveAddressBook } from "../lib/addresses";
import { MAX_IMPORT_ROWS, planUserImport } from "../../shared/user-import";
import { withoutMailboxes } from "../../shared/addresses";
import type { MailboxContext } from "../lib/mailbox";
import type { Env } from "../types";

export const people = new Hono<MailboxContext>();

const now = () => new Date().toISOString();

/** What the People page shows about a person. */
function view(p: Person) {
	return { email: p.email, name: p.name, role: p.role, status: p.status, mailboxes: p.mailboxes, adminAccess: p.adminAccess, invitedAt: p.invitedAt, lastSeenAt: p.lastSeenAt ?? null };
}

async function signInState(env: Env, book: PeopleBook, sync?: SyncResult) {
	return {
		automatic: signInChecksPeopleList(env) || (await accessSyncAvailable(env)),
		accountId: env.CF_ACCOUNT_ID ?? null,
		...(sync && !sync.ok && !sync.manual ? { error: sync.error ?? "unknown problem" } : {}),
		count: signInList(book).length,
	};
}

/** Brings Cloudflare's sign-in list into line with the people list. */
async function resync(env: Env, book: PeopleBook): Promise<SyncResult> {
	return syncSignInList(env, signInList(book));
}

/** The admin's own mailbox to send invites from, with their name. */
async function senderFor(env: Env, admin: Person): Promise<{ email: string; name: string } | null> {
	const mailbox = admin.mailboxes[0];
	if (!mailbox) return null;
	let name = admin.name;
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailbox}.json`);
		const fromName = obj ? ((await obj.json()) as { fromName?: string }).fromName : undefined;
		if (fromName) name = fromName;
	} catch { /* use their People name */ }
	return { email: mailbox, name };
}

async function invite(c: { env: Env; req: { url: string } }, admin: Person, person: Person) {
	return sendInvite(c.env, { to: person.email, name: person.name, mailbox: person.mailboxes[0] ?? null, admin: admin.name, url: new URL(c.req.url).origin }, await senderFor(c.env, admin));
}

const OWNER_STAYS = "This person owns the Cloudflare account Mail App runs on, so they always stay an admin.";

// -- Who's signed in ------------------------------------------------------

people.get("/api/v1/me", async (c) => {
	const p = c.var.person;
	const plan = await loadPlan(c.env);
	return c.json({
		email: p.email, name: p.name, role: p.role, mailboxes: openable(p), signature: p.signature ?? "",
		...(p.role === "admin" ? { plan } : {}),
	});
});

// Everyone can change their own name and personal signature (used when they write from a shared mailbox).
const MeBody = z.object({ name: z.string().max(MAX_NAME).optional(), signature: z.string().max(MAX_SIGNATURE).optional() });

people.put("/api/v1/me", async (c) => {
	const change = MeBody.parse(await c.req.json());
	const email = c.var.person.email;
	const saved = await updatePeople(c.env.BUCKET, (book) => {
		const p = findPerson(book, email);
		if (!p) return "Not found";
		const next = { ...p };
		if (change.name !== undefined && change.name.trim()) next.name = change.name.trim();
		if (change.signature !== undefined) {
			const signature = cleanSignature(change.signature);
			if (signature) next.signature = signature;
			else delete next.signature;
		}
		return withPerson(book, next);
	});
	if (typeof saved === "string") return c.json({ error: saved }, 404);
	const p = findPerson(saved, email)!;
	return c.json({ email: p.email, name: p.name, signature: p.signature ?? "" });
});

// -- The People page (admins) ---------------------------------------------

people.use("/api/v1/people", requireAdmin);
people.use("/api/v1/people/*", requireAdmin);

people.get("/api/v1/people", async (c) => {
	const [{ book }, plan, mailboxes] = await Promise.all([loadPeople(c.env.BUCKET), loadPlan(c.env), listMailboxes(c.env.BUCKET)]);
	return c.json({
		people: book.people.map(view),
		owner: c.env.OWNER_EMAIL?.trim().toLowerCase() || book.owner || null,
		plan: { ...plan, count: peopleCount(book) },
		mailboxes: mailboxes.map((m) => m.email),
		signIn: await signInState(c.env, book),
	});
});

const InviteBody = z.object({
	email: z.string(),
	name: z.string(),
	role: z.enum(["admin", "member"]).default("member"),
	/** Existing mailboxes to give them. */
	mailboxes: z.array(z.string()).default([]),
	/** Or a new mailbox made for them. */
	newMailbox: z.object({ email: z.string().email(), name: z.string().optional() }).optional(),
});

people.post("/api/v1/people", async (c) => {
	const input = InviteBody.parse(await c.req.json());
	const email = input.email.trim().toLowerCase();
	const name = input.name.trim();
	const [plan, existing] = await Promise.all([loadPlan(c.env), listMailboxes(c.env.BUCKET)]);
	const fresh: Person = { email, name, role: input.role as Role, mailboxes: input.mailboxes.map((m) => m.toLowerCase()), adminAccess: [], status: "invited", invitedAt: now() };
	const saved = await updatePeople(c.env.BUCKET, (book) =>
		invitePeopleProblem(book, plan, { email, name, role: fresh.role, mailboxes: fresh.mailboxes }, existing.map((m) => m.email))
		?? { ...book, people: [...book.people, fresh] },
	);
	if (typeof saved === "string") return c.json({ error: saved }, 400);
	let book = saved;
	if (input.newMailbox) {
		const made = await createMailbox(c.env, new URL(c.req.url).origin, { email: input.newMailbox.email, name: input.newMailbox.name || name, owner: email });
		if (!made.ok) {
			// Undo the invite so the admin can fix the mailbox and try again.
			await updatePeople(c.env.BUCKET, (b) => ({ ...b, people: b.people.filter((p) => p.email !== email) }));
			return c.json({ error: made.error }, made.status);
		}
		book = (await loadPeople(c.env.BUCKET)).book;
	}
	const sync = await resync(c.env, book);
	const person = findPerson(book, email)!;
	const sent = await invite(c, c.var.person, person);
	return c.json({ person: view(person), invite: sent, signIn: await signInState(c.env, book, sync) }, 201);
});

// Import users: adds everyone from a CSV at once. The page has already checked the rows; they're
// checked again here against the latest list, and each row says whether it was added.
const ImportBody = z.object({
	rows: z.array(z.object({ line: z.number().int().optional(), name: z.string(), email: z.string(), role: z.string().default(""), mailbox: z.string().default("") })).max(MAX_IMPORT_ROWS),
	sendInvites: z.boolean().default(true),
});

people.post("/api/v1/people/import", async (c) => {
	const input = ImportBody.parse(await c.req.json());
	const origin = new URL(c.req.url).origin;
	const domainsFile = await loadDomainsFile(c.env.BUCKET);
	const domains = [...new Set([...(c.env.DOMAINS || "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean), ...domainsFile.domains.map((d) => d.name)])];
	const [plan, existing, { book: before }] = await Promise.all([loadPlan(c.env), listMailboxes(c.env.BUCKET), loadPeople(c.env.BUCKET)]);
	const planned = planUserImport(input.rows, { book: before, plan, mailboxes: existing.map((m) => m.email), domains });

	const results: { line: number; email: string; added: boolean; error?: string; invite?: Awaited<ReturnType<typeof invite>> }[] = [];
	const added: string[] = [];
	for (const row of planned) {
		if (row.problem) { results.push({ line: row.line, email: row.email, added: false, error: row.problem }); continue; }
		const fresh: Person = { email: row.email, name: row.name, role: row.role, mailboxes: row.mailboxKind === "existing" ? [row.mailbox] : [], adminAccess: [], status: "invited", invitedAt: now() };
		const saved = await updatePeople(c.env.BUCKET, (book) => {
			if (findPerson(book, row.email)) return `${row.email} is already a user.`;
			let b = { ...book, people: [...book.people, fresh] };
			if (row.mailboxKind === "existing") b = addLog(b, { at: now(), mailbox: row.mailbox, action: "given", by: c.var.person.email, who: row.email });
			return b;
		});
		if (typeof saved === "string") { results.push({ line: row.line, email: row.email, added: false, error: saved }); continue; }
		if (row.mailboxKind === "new") {
			const made = await createMailbox(c.env, origin, { email: row.mailbox, name: row.name, owner: row.email });
			if (!made.ok) {
				await updatePeople(c.env.BUCKET, (b) => ({ ...b, people: b.people.filter((p) => p.email !== row.email) }));
				results.push({ line: row.line, email: row.email, added: false, error: `${row.mailbox}: ${made.error}` });
				continue;
			}
		}
		results.push({ line: row.line, email: row.email, added: true });
		added.push(row.email);
	}

	const { book } = await loadPeople(c.env.BUCKET);
	const sync = added.length ? await resync(c.env, book) : undefined;
	if (input.sendInvites) {
		for (const r of results) {
			const person = r.added ? findPerson(book, r.email) : undefined;
			if (person) r.invite = await invite(c, c.var.person, person);
		}
	}
	return c.json({ results, signIn: await signInState(c.env, book, sync) });
});

const ChangeBody = z.object({
	name: z.string().optional(),
	role: z.enum(["admin", "member"]).optional(),
	mailboxes: z.array(z.string()).optional(),
	status: z.enum(["active", "suspended"]).optional(),
});

people.patch("/api/v1/people/:email", async (c) => {
	const email = decodeURIComponent(c.req.param("email")).toLowerCase();
	const change = ChangeBody.parse(await c.req.json());
	const me = c.var.person;
	const [plan, existing] = await Promise.all([loadPlan(c.env), listMailboxes(c.env.BUCKET)]);
	const saved = await updatePeople(c.env.BUCKET, (book) => {
		const p = findPerson(book, email);
		if (!p) return "Not found";
		if ((change.role === "member" || change.status === "suspended") && isOwner(c.env, email, book)) return OWNER_STAYS;
		if ((change.role === "member" || change.status === "suspended") && isLastAdmin(book, email)) return "There must always be at least one admin.";
		if (change.status === "suspended" && email === me.email) return "You can't pause your own access.";
		let next = { ...p };
		if (change.name !== undefined && change.name.trim()) next.name = change.name.trim();
		if (change.role) next = { ...next, role: change.role, adminAccess: change.role === "admin" ? next.adminAccess : [] };
		if (change.status) next.status = change.status === "active" && p.status === "invited" ? "invited" : change.status;
		let b = book;
		if (change.mailboxes) {
			const wanted = change.mailboxes.map((m) => m.toLowerCase());
			const problem = mailboxesProblem(book, plan, email, wanted, existing.map((m) => m.email));
			if (problem) return problem;
			for (const m of wanted.filter((m) => !p.mailboxes.includes(m))) b = addLog(b, { at: now(), mailbox: m, action: "given", by: me.email, who: email });
			for (const m of p.mailboxes.filter((m) => !wanted.includes(m))) b = addLog(b, { at: now(), mailbox: m, action: "taken-away", by: me.email, who: email });
			next.mailboxes = [...new Set(wanted)];
		}
		return withPerson(b, next);
	});
	if (typeof saved === "string") return c.json({ error: saved }, saved === "Not found" ? 404 : 400);
	let sync: SyncResult | undefined;
	if (change.status) {
		sync = await resync(c.env, saved);
		if (change.status === "suspended") await signOutEverywhere(c.env, email);
	}
	return c.json({ person: view(findPerson(saved, email)!), signIn: await signInState(c.env, saved, sync) });
});

// Sends the invite again. With { reset: true } it also signs them out everywhere first.
people.post("/api/v1/people/:email/invite", async (c) => {
	const email = decodeURIComponent(c.req.param("email")).toLowerCase();
	const { reset } = z.object({ reset: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
	const { book } = await loadPeople(c.env.BUCKET);
	const p = findPerson(book, email);
	if (!p) return c.json({ error: "Not found" }, 404);
	if (p.status === "suspended") return c.json({ error: "Restore their access first." }, 400);
	if (reset) await signOutEverywhere(c.env, email);
	return c.json({ invite: await invite(c, c.var.person, p) });
});

const RemoveBody = z.object({
	/** What happens to their mailboxes: kept unassigned, given to someone else, or deleted. */
	mailboxes: z.enum(["keep", "hand-over", "delete"]).default("keep"),
	handTo: z.string().optional(),
});

people.delete("/api/v1/people/:email", async (c) => {
	const email = decodeURIComponent(c.req.param("email")).toLowerCase();
	const { mailboxes: what, handTo } = RemoveBody.parse(await c.req.json().catch(() => ({})));
	const me = c.var.person;
	if (email === me.email) return c.json({ error: "You can't remove yourself." }, 400);
	let theirs: string[] = [];
	const saved = await updatePeople(c.env.BUCKET, (book) => {
		const p = findPerson(book, email);
		if (!p) return "Not found";
		if (isOwner(c.env, email, book)) return OWNER_STAYS;
		if (isLastAdmin(book, email)) return "There must always be at least one admin.";
		theirs = p.mailboxes;
		let b: PeopleBook = { ...book, people: book.people.filter((x) => x.email !== email) };
		for (const m of theirs) b = addLog(b, { at: now(), mailbox: m, action: "taken-away", by: me.email, who: email });
		if (what === "hand-over") {
			const to = findPerson(b, handTo ?? "");
			if (!to) return "Choose who should get their mailboxes.";
			const adding = theirs.filter((m) => !to.mailboxes.includes(m));
			b = withPerson(b, { ...to, mailboxes: [...to.mailboxes, ...adding] });
			for (const m of adding) b = addLog(b, { at: now(), mailbox: m, action: "given", by: me.email, who: to.email });
		}
		if (what === "delete") {
			// Shared mailboxes stay for the others who use them.
			theirs = theirs.filter((m) => usersOf(b, m).length === 0);
			b = { ...b, people: b.people.map((x) => ({ ...x, adminAccess: x.adminAccess.filter((m) => !theirs.includes(m)) })) };
		}
		return b;
	});
	if (typeof saved === "string") return c.json({ error: saved }, saved === "Not found" ? 404 : 400);
	if (what === "delete") {
		// Like deleting a mailbox on the Mailboxes page: its extra addresses and catch-all go with it.
		for (const m of theirs) await c.env.BUCKET.delete(`mailboxes/${m}.json`);
		await saveAddressBook(c.env.BUCKET, withoutMailboxes(await loadAddressBook(c.env.BUCKET), theirs));
	}
	const sync = await resync(c.env, saved);
	await signOutEverywhere(c.env, email);
	return c.json({ removed: email, deletedMailboxes: what === "delete" ? theirs : [], signIn: await signInState(c.env, saved, sync) });
});

// Tries the Cloudflare sign-in list update again.
people.post("/api/v1/people-sync", requireAdmin, async (c) => {
	const { book } = await loadPeople(c.env.BUCKET);
	const sync = await resync(c.env, book);
	return c.json({ signIn: await signInState(c.env, book, sync), ok: sync.ok });
});

// A sign-in key the admin makes once in Cloudflare and pastes in, so invites work straight away.
people.put("/api/v1/access-token", requireAdmin, async (c) => {
	const { token } = z.object({ token: z.string().trim().min(20).max(400) }).parse(await c.req.json());
	const problem = await checkAccessToken(c.env, token);
	if (problem) return c.json({ error: problem }, 400);
	await c.env.BUCKET.put(ACCESS_TOKEN_KEY, JSON.stringify({ token, savedAt: now(), by: c.var.person.email }));
	const { book } = await loadPeople(c.env.BUCKET);
	const sync = await resync(c.env, book);
	return c.json({ signIn: await signInState(c.env, book, sync), ok: sync.ok });
});

// -- An admin opening someone else's mailbox (always logged) ----------------

people.put("/api/v1/admin-access/:mailbox", requireAdmin, async (c) => {
	const mailbox = decodeURIComponent(c.req.param("mailbox")).toLowerCase();
	const { open } = z.object({ open: z.boolean() }).parse(await c.req.json());
	const me = c.var.person;
	const existing = (await listMailboxes(c.env.BUCKET)).map((m) => m.email.toLowerCase());
	if (!existing.includes(mailbox)) return c.json({ error: "Not found" }, 404);
	const saved = await updatePeople(c.env.BUCKET, (book) => {
		const p = findPerson(book, me.email)!;
		if (p.mailboxes.includes(mailbox)) return open ? book : "This is one of your own mailboxes.";
		const has = p.adminAccess.includes(mailbox);
		if (open === has) return book;
		const b = addLog(book, { at: now(), mailbox, action: open ? "admin-opened" : "admin-closed", by: me.email });
		return withPerson(b, { ...p, adminAccess: open ? [...p.adminAccess, mailbox] : p.adminAccess.filter((m) => m !== mailbox) });
	});
	if (typeof saved === "string") return c.json({ error: saved }, 400);
	return c.json({ open: canOpen(findPerson(saved, me.email), mailbox) });
});

// -- A mailbox's own access log (anyone who can open it) ----------------------

people.get("/api/v1/mailboxes/:mailboxId/access", async (c) => {
	const mailbox = decodeURIComponent(c.req.param("mailboxId")).toLowerCase();
	const { book } = await loadPeople(c.env.BUCKET);
	const nameOf = (e: string) => findPerson(book, e)?.name ?? e;
	return c.json({
		people: usersOf(book, mailbox).map((p) => ({ email: p.email, name: p.name })),
		shared: isShared(book, mailbox),
		admins: book.people.filter((p) => p.adminAccess.includes(mailbox)).map((p) => ({ email: p.email, name: p.name })),
		log: logFor(book, mailbox).slice(0, 50).map((l) => ({ ...l, byName: nameOf(l.by), whoName: l.who ? nameOf(l.who) : undefined })),
	});
});

people.onError((e, c) => {
	if (e instanceof PeopleConflict) return c.json({ error: e.message }, 409);
	if (e instanceof z.ZodError) return c.json({ error: "Some details were missing or not valid." }, 400);
	throw e;
});
