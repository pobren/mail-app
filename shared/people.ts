// Mail App addition (not part of upstream Agentic Inbox).
// Team access: who can sign in to this install, which mailboxes each person can open, and who
// manages everyone else (admins). Everything lives in one small file in R2 (people.json).
//
// Sign-in itself is Cloudflare Access with an emailed one-time code: people sign in with their own
// personal email address, the one they were invited at. Access lets only the addresses on this list
// in, and the Worker checks the list again on every request, so a suspended person is shut out at
// once even before Access catches up.
//
// An admin can't quietly read someone's mail. To open a mailbox that isn't theirs, an admin gives
// themselves access, and that is written to a log the mailbox's own people can see in Settings.
//
// Pure functions only, so the browser, the Worker and the tests can all use them.

// Same rules as shared/addresses.ts (copied so this file loads on its own in the tests).
const ADDRESS_RE = /^[a-z0-9.!#$%&'*/=?^_`{|}~+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const normaliseAddress = (a: string) => a.trim().toLowerCase();
const isAddress = (a: string) => ADDRESS_RE.test(normaliseAddress(a));

export type Role = "admin" | "member";
export type PersonStatus = "invited" | "active" | "suspended";

export interface Person {
	/** The address they sign in with (their personal email), lower case. */
	email: string;
	name: string;
	role: Role;
	/** Mailboxes they use (each mailbox's own address). */
	mailboxes: string[];
	/** Admins only: other people's mailboxes they have given themselves access to (logged). */
	adminAccess: string[];
	status: PersonStatus;
	invitedAt: string;
	lastSeenAt?: string;
	/** Their own sign-off, used instead of the mailbox's signature when they write from a shared mailbox. */
	signature?: string;
}

export type LogAction = "admin-opened" | "admin-closed" | "given" | "taken-away";

/** One line in a mailbox's access log, which that mailbox's people can read. */
export interface LogEntry {
	at: string;
	mailbox: string;
	action: LogAction;
	/** Who did it (sign-in address). */
	by: string;
	/** Who it was done for, when that's someone else. */
	who?: string;
}

export interface PeopleBook {
	people: Person[];
	log: LogEntry[];
	/** Who installed Mail App (the first to sign in). They always stay an admin. */
	owner?: string;
	/** Mailboxes an admin marked as shared (a team address like sales@), even while only one person has them. */
	shared?: string[];
}

export const PEOPLE_KEY = "people.json";
/** Cloudflare Access is free for up to 50 people, so Mail App stops there. */
export const MAX_PEOPLE = 50;
export const MAX_NAME = 80;
export const MAX_SIGNATURE = 2000;
/** Oldest log lines are dropped past this. */
export const MAX_LOG = 500;
/** How often a person's "last signed in" is written, at most. */
export const SEEN_EVERY_MS = 60 * 60 * 1000;

const cleanName = (v: unknown) =>
	typeof v === "string" ? v.replace(/[\x00-\x1f]/g, "").trim().slice(0, MAX_NAME) : "";

const cleanList = (v: unknown) =>
	[...new Set((Array.isArray(v) ? v : []).filter((m): m is string => typeof m === "string" && isAddress(m)).map(normaliseAddress))];

/** A personal signature as plain text: line breaks kept, other control characters dropped. */
export const cleanSignature = (v: unknown): string =>
	typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f]/g, "").trim().slice(0, MAX_SIGNATURE) : "";

/** Reads whatever is stored, dropping anything malformed. */
export function cleanPeople(raw: unknown): PeopleBook {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const seen = new Set<string>();
	const people: Person[] = [];
	for (const p of Array.isArray(r.people) ? r.people : []) {
		if (!p || typeof p !== "object") continue;
		const email = typeof p.email === "string" ? normaliseAddress(p.email) : "";
		if (!isAddress(email) || seen.has(email)) continue;
		seen.add(email);
		const role: Role = p.role === "admin" ? "admin" : "member";
		const status: PersonStatus = p.status === "active" || p.status === "suspended" ? p.status : "invited";
		people.push({
			email,
			name: cleanName(p.name) || email.split("@")[0],
			role,
			mailboxes: cleanList(p.mailboxes),
			adminAccess: role === "admin" ? cleanList(p.adminAccess) : [],
			status,
			invitedAt: typeof p.invitedAt === "string" ? p.invitedAt : new Date(0).toISOString(),
			...(typeof p.lastSeenAt === "string" ? { lastSeenAt: p.lastSeenAt } : {}),
			...(cleanSignature(p.signature) ? { signature: cleanSignature(p.signature) } : {}),
		});
	}
	const log: LogEntry[] = [];
	for (const l of Array.isArray(r.log) ? r.log : []) {
		if (!l || typeof l !== "object" || typeof l.at !== "string" || typeof l.mailbox !== "string" || typeof l.by !== "string") continue;
		if (!["admin-opened", "admin-closed", "given", "taken-away"].includes(l.action)) continue;
		log.push({ at: l.at, mailbox: normaliseAddress(l.mailbox), action: l.action, by: normaliseAddress(l.by), ...(typeof l.who === "string" ? { who: normaliseAddress(l.who) } : {}) });
	}
	const owner = typeof r.owner === "string" && isAddress(r.owner) ? normaliseAddress(r.owner) : undefined;
	const shared = cleanList(r.shared);
	return { people, log: log.slice(-MAX_LOG), ...(owner ? { owner } : {}), ...(shared.length ? { shared } : {}) };
}

export function findPerson(book: PeopleBook, email: string | null | undefined): Person | undefined {
	if (!email) return undefined;
	const e = normaliseAddress(email);
	return book.people.find((p) => p.email === e);
}

export const isAdmin = (p: Person | undefined): boolean => !!p && p.role === "admin" && p.status !== "suspended";

/** Mailboxes this person can open right now. */
export function openable(p: Person | undefined): string[] {
	if (!p || p.status === "suspended") return [];
	return [...new Set([...p.mailboxes, ...p.adminAccess])];
}

export function canOpen(p: Person | undefined, mailbox: string): boolean {
	return openable(p).includes(normaliseAddress(mailbox));
}

/** People (not suspended) who use a mailbox, not counting an admin who gave themselves access. */
export function usersOf(book: PeopleBook, mailbox: string): Person[] {
	const m = normaliseAddress(mailbox);
	return book.people.filter((p) => p.status !== "suspended" && p.mailboxes.includes(m));
}

/** Everyone who counts towards the plan's limit: invited, active and suspended people all hold a place. */
export const peopleCount = (book: PeopleBook): number => book.people.length;

/** A mailbox marked as shared, or used by two or more people. */
export function isShared(book: PeopleBook, mailbox: string): boolean {
	return (book.shared ?? []).includes(normaliseAddress(mailbox)) || usersOf(book, mailbox).length > 1;
}

/**
 * An admin choosing who uses a mailbox, and whether it's shared, from the Mailboxes page. Everyone
 * given or losing it gets a line in its access log. Returns words for the admin when it can't be done.
 */
export function setMailboxPeople(
	book: PeopleBook, plan: Plan, mailbox: string, emails: string[], shared: boolean, by: string, now: string,
): PeopleBook | string {
	const m = normaliseAddress(mailbox);
	const wanted = new Set(emails.map(normaliseAddress));
	const missing = [...wanted].find((e) => !findPerson(book, e));
	if (missing) return `${missing} isn't on the Users list. Invite them first.`;
	let b = book;
	for (const p of book.people) {
		const has = p.mailboxes.includes(m);
		if (wanted.has(p.email) === has) continue;
		b = addLog(b, { at: now, mailbox: m, action: has ? "taken-away" : "given", by: normaliseAddress(by), who: p.email });
		b = withPerson(b, { ...p, mailboxes: has ? p.mailboxes.filter((x) => x !== m) : [...p.mailboxes, m] });
	}
	const others = (b.shared ?? []).filter((x) => x !== m);
	const list = shared ? [...others, m] : others;
	const { shared: _drop, ...rest } = b;
	return list.length ? { ...rest, shared: list } : rest;
}

/**
 * How someone's email from a shared mailbox is signed: "Sam at Acme Sales". Customers see who they're
 * talking to, and replies still go to the shared address. Falls back to the mailbox's own name.
 */
export function sharedFromName(personName: string, mailboxName: string): string {
	const who = cleanName(personName);
	const box = cleanName(mailboxName);
	if (!who) return box;
	if (!box || box.toLowerCase() === who.toLowerCase()) return who;
	return `${who} at ${box}`.slice(0, 200);
}

/** The owner's addresses the installer gave: their sign-in address and, if they chose one, a backup. */
export function ownerAddresses(...given: (string | undefined)[]): string[] {
	return [...new Set(given.map((e) => e?.trim().toLowerCase() ?? "").filter(Boolean))];
}

/** The sign-in addresses Cloudflare Access should let in: everyone who isn't suspended. */
export function signInList(book: PeopleBook): string[] {
	return book.people.filter((p) => p.status !== "suspended").map((p) => p.email).sort();
}

/**
 * The first sign-in on an install that has no people list yet: whoever got through Cloudflare
 * Access is the owner (until now only the owner's address was allowed in), so they become the admin
 * and keep every existing mailbox.
 */
export function firstAdmin(email: string, mailboxes: string[], now: string): PeopleBook {
	const e = normaliseAddress(email);
	return {
		people: [{ email: e, name: e.split("@")[0], role: "admin", mailboxes: cleanList(mailboxes), adminAccess: [], status: "active", invitedAt: now, lastSeenAt: now }],
		log: [],
		owner: e,
	};
}

/** What an install allows: up to MAX_PEOPLE people, with shared mailboxes. */
export interface Plan {
	/** How many people this install can have. */
	limit: number;
}

export const PLAN: Plan = { limit: MAX_PEOPLE };

export interface NewPerson {
	email: string;
	name: string;
	role: Role;
	mailboxes: string[];
}

/** Why someone can't be invited, in words for the admin, or null if they can. */
export function invitePeopleProblem(book: PeopleBook, plan: Plan, input: NewPerson, existingMailboxes: string[]): string | null {
	const email = normaliseAddress(input.email);
	if (!isAddress(email)) return "Please enter a full email address, like name@gmail.com.";
	if (findPerson(book, email)) return `${email} already has access.`;
	if (!cleanName(input.name)) return "Please enter their name.";
	if (peopleCount(book) >= plan.limit) {
		return `You've reached ${plan.limit} people, the most this install allows.`;
	}
	return mailboxesProblem(book, plan, email, input.mailboxes, existingMailboxes);
}

/** Why a person can't be given these mailboxes, or null if they can. */
export function mailboxesProblem(book: PeopleBook, plan: Plan, email: string, mailboxes: string[], existingMailboxes: string[]): string | null {
	const known = new Set(existingMailboxes.map(normaliseAddress));
	const wanted = cleanList(mailboxes);
	if (wanted.length !== (Array.isArray(mailboxes) ? mailboxes.length : 0)) return "One of those mailboxes isn't a valid address.";
	const missing = wanted.find((m) => !known.has(m));
	if (missing) return `There's no mailbox called ${missing}.`;
	return null;
}

/** Adds a log line, keeping the log to its maximum length. */
export function addLog(book: PeopleBook, entry: LogEntry): PeopleBook {
	return { ...book, log: [...book.log, entry].slice(-MAX_LOG) };
}

/** A mailbox's log, newest first, for its own people to see. */
export function logFor(book: PeopleBook, mailbox: string): LogEntry[] {
	const m = normaliseAddress(mailbox);
	return book.log.filter((l) => l.mailbox === m).reverse();
}

/** Replaces one person, keeping everyone else. */
export function withPerson(book: PeopleBook, person: Person): PeopleBook {
	return { ...book, people: book.people.map((p) => (p.email === person.email ? person : p)) };
}

/** True when changing or removing this person would leave nobody able to manage the install. */
export function isLastAdmin(book: PeopleBook, email: string): boolean {
	const admins = book.people.filter((p) => p.role === "admin" && p.status !== "suspended");
	return admins.length === 1 && admins[0].email === normaliseAddress(email);
}

/** Should the "last signed in" time be written again? */
export function shouldMarkSeen(p: Person, now: number): boolean {
	if (p.status === "invited") return true;
	const last = p.lastSeenAt ? Date.parse(p.lastSeenAt) : 0;
	return !(now - last < SEEN_EVERY_MS);
}
