// Mail App addition (not part of upstream Agentic Inbox).
// Import users: an admin adds a whole team at once from a spreadsheet saved as CSV. Each row is one
// user: their name, the personal email they sign in with, their role, and (optionally) their mailbox.
// The mailbox can be one that already exists, or a new address at one of this install's domains.
//
// The browser checks every row before anything is added (so the preview can say what's wrong with
// each one), and the Worker checks them all again with the same rules before adding anyone.
//
// Pure functions only, so the browser, the Worker and the tests can all use them.

import { parseCsv } from "./contacts.ts";
import { findPerson, peopleCount, type PeopleBook, type Plan, type Role } from "./people.ts";

const ADDRESS_RE = /^[a-z0-9.!#$%&'*/=?^_`{|}~+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const PREFIX_RE = /^[a-z0-9.!#$%&'*/=?^_`{|}~+-]+$/;
const lower = (v: string) => v.trim().toLowerCase();

/** The most rows one import takes (the most users an install can have). */
export const MAX_IMPORT_ROWS = 50;

/** The file people download to fill in. */
export const USER_TEMPLATE_CSV = [
	"name,email,role,mailbox",
	"Anna Smith,anna.smith@gmail.com,member,anna@example.com",
	"Ben Jones,ben.jones@outlook.com,admin,ben@example.com",
	"Chris Lee,chris.lee@icloud.com,member,",
	"",
].join("\r\n");

/** One row as it came out of the file. */
export interface UserRow {
	/** Line number in the file, counting the header as line 1. */
	line: number;
	name: string;
	email: string;
	role: string;
	mailbox: string;
}

/** What importing a row will do, or why it can't. */
export interface PlannedUser {
	line: number;
	name: string;
	email: string;
	role: Role;
	/** The mailbox's full address, or "" for none. */
	mailbox: string;
	/** "new" makes the mailbox; "existing" gives them one that's already there (or made earlier in this file). */
	mailboxKind: "new" | "existing" | "none";
	problem: string | null;
}

const HEADERS: Record<keyof Omit<UserRow, "line">, string[]> = {
	name: ["name", "full name", "their name", "display name", "user"],
	email: ["email", "email address", "e-mail", "sign-in email", "personal email", "their personal email", "login"],
	role: ["role", "type", "access"],
	mailbox: ["mailbox", "mailbox address", "new mailbox", "their mailbox", "work email", "address"],
};

/** Reads the CSV into rows. Throws when the header row has no email column. */
export function parseUsersCsv(text: string): UserRow[] {
	const rows = parseCsv(text.replace(/^﻿/, ""));
	if (!rows.length) return [];
	const header = rows[0].map((h) => lower(h).replace(/\s+/g, " "));
	const col = (key: keyof typeof HEADERS) => header.findIndex((h) => HEADERS[key].includes(h));
	const nameCol = col("name");
	const emailCol = col("email");
	const roleCol = col("role");
	const mailboxCol = col("mailbox");
	if (emailCol < 0) throw new Error("no email column");
	const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
	return rows.slice(1).map((row, i) => ({
		line: i + 2,
		name: cell(row, nameCol),
		email: cell(row, emailCol),
		role: cell(row, roleCol),
		mailbox: cell(row, mailboxCol),
	}));
}

export interface ImportContext {
	book: PeopleBook;
	plan: Plan;
	/** Mailboxes that exist now. */
	mailboxes: string[];
	/** Domains a new mailbox can be at. */
	domains: string[];
}

/** Checks every row, in order, as if the ones before it had already been added. */
export function planUserImport(rows: (Omit<UserRow, "line"> & { line?: number })[], ctx: ImportContext): PlannedUser[] {
	const domains = ctx.domains.map(lower);
	const existing = new Set(ctx.mailboxes.map(lower));
	/** Mailboxes this file will make, and who each one is for. */
	const madeBy = new Map<string, string>();
	const seen = new Set<string>();
	let count = peopleCount(ctx.book);
	return rows.map((row, i) => {
		const line = row.line ?? i + 2;
		const name = row.name.trim().replace(/\s+/g, " ").slice(0, 80);
		const email = lower(row.email);
		const roleText = lower(row.role);
		const role: Role = roleText === "admin" || roleText === "administrator" ? "admin" : "member";
		const out: PlannedUser = { line, name, email, role, mailbox: "", mailboxKind: "none", problem: null };
		const fail = (problem: string) => ({ ...out, problem });

		if (!email) return fail("Their email is missing.");
		if (!ADDRESS_RE.test(email)) return fail(`${row.email.trim()} isn't a full email address.`);
		if (seen.has(email)) return fail(`${email} is in the file twice.`);
		seen.add(email);
		if (findPerson(ctx.book, email)) return fail(`${email} is already a user.`);
		if (!name) return fail("Their name is missing.");
		if (roleText && !["admin", "administrator", "member", "user"].includes(roleText)) return fail(`Role must be admin or member, not "${row.role.trim()}".`);

		let mailbox = lower(row.mailbox);
		if (mailbox && !mailbox.includes("@")) {
			if (!PREFIX_RE.test(mailbox)) return fail(`${row.mailbox.trim()} isn't a valid mailbox address.`);
			if (domains.length !== 1) return fail(`Please write the whole mailbox address, like ${mailbox}@${domains[0] ?? "example.com"}.`);
			mailbox = `${mailbox}@${domains[0]}`;
		}
		if (mailbox) {
			if (!ADDRESS_RE.test(mailbox)) return fail(`${row.mailbox.trim()} isn't a valid mailbox address.`);
			const madeFor = madeBy.get(mailbox);
			if (existing.has(mailbox) || madeFor) {
				out.mailbox = mailbox;
				out.mailboxKind = "existing";
			} else {
				const domain = mailbox.split("@")[1];
				if (!domains.includes(domain)) return fail(`${domain} isn't one of your domains.`);
				out.mailbox = mailbox;
				out.mailboxKind = "new";
			}
		}

		if (count >= ctx.plan.limit) return fail(`That would go past ${ctx.plan.limit} users, the most this install allows.`);
		count++;
		if (out.mailboxKind === "new") madeBy.set(out.mailbox, email);
		return out;
	});
}
