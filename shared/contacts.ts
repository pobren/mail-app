// Mail App addition (not part of upstream Agentic Inbox).
// Contacts: people you've emailed, plus the ones you've saved or edited. Saved details live in the
// mailbox's database; everyone you've sent to shows up automatically unless you remove them.

export interface Contact {
	email: string;
	name: string;
	notes: string;
	/** True when you've saved or edited this contact yourself. */
	saved: boolean;
	/** How many emails you've sent them. */
	sent: number;
	/** When you last emailed them (ISO), if ever. */
	lastSent: string | null;
}

export interface SavedContactRow {
	email: string;
	name: string | null;
	notes: string | null;
	hidden: number;
}

const EMAIL_RE = /[^\s<>,;"]+@[^\s<>,;"]+\.[^\s<>,;"]+/;

/** Lower-cased addresses from a header like `Jo <jo@example.com>, sam@example.com`. */
export function splitAddresses(value: string | null | undefined): string[] {
	if (!value) return [];
	const out: string[] = [];
	for (const part of value.split(/[,;]/)) {
		const m = part.match(EMAIL_RE);
		if (m) out.push(m[0].toLowerCase());
	}
	return out;
}

/** The display name in `"Jo Bloggs" <jo@example.com>`, or "" when there isn't one. */
export function displayName(value: string): string {
	const m = value.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
	const name = m?.[1]?.trim() ?? "";
	return name.includes("@") ? "" : name;
}

/**
 * A sender's name tidied for showing in lists: no quotes, and no commas, because the inbox
 * joins the names in a conversation with commas. "" when there's no usable name.
 */
export function cleanSenderName(name: string | null | undefined): string {
	const clean = (name ?? "").replace(/["\\]/g, "").replace(/,/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
	return clean.includes("@") ? "" : clean;
}

export function isValidContactEmail(email: string): boolean {
	return email.length <= 254 && new RegExp(`^${EMAIL_RE.source}$`).test(email.trim());
}

/**
 * Builds the contact list: everyone you've sent mail to (counted), names learnt from mail they sent
 * you, and your saved contacts, which win. Removed contacts and your own address are left out.
 */
export function buildContacts(
	saved: SavedContactRow[],
	sentRows: { recipient: string | null; cc: string | null; bcc: string | null; date: string | null }[],
	knownNames: Map<string, string>,
	self: string,
): Contact[] {
	const me = self.toLowerCase();
	const byEmail = new Map<string, Contact>();
	const hidden = new Set(saved.filter((s) => s.hidden).map((s) => s.email.toLowerCase()));
	for (const row of sentRows) {
		for (const email of new Set([...splitAddresses(row.recipient), ...splitAddresses(row.cc), ...splitAddresses(row.bcc)])) {
			if (email === me || hidden.has(email)) continue;
			const c = byEmail.get(email) ?? { email, name: knownNames.get(email) ?? "", notes: "", saved: false, sent: 0, lastSent: null };
			c.sent++;
			if (row.date && (!c.lastSent || row.date > c.lastSent)) c.lastSent = row.date;
			byEmail.set(email, c);
		}
	}
	for (const s of saved) {
		const email = s.email.toLowerCase();
		if (s.hidden || email === me) continue;
		const c = byEmail.get(email) ?? { email, name: "", notes: "", saved: true, sent: 0, lastSent: null };
		byEmail.set(email, { ...c, name: s.name?.trim() || c.name || knownNames.get(email) || "", notes: s.notes ?? "", saved: true });
	}
	return [...byEmail.values()].sort((a, b) => sortKey(a).localeCompare(sortKey(b), "en-GB"));
}

const sortKey = (c: Contact) => (c.name || c.email).toLowerCase();

/**
 * Contacts for the address box, best first: a name or address that starts with what you typed beats
 * one that only contains it, and people you email more often come first.
 */
export function matchContacts(contacts: Contact[], query: string, exclude: string[] = [], limit = 6): Contact[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const skip = new Set(exclude.map((e) => e.toLowerCase()));
	const scored: { c: Contact; score: number }[] = [];
	for (const c of contacts) {
		if (skip.has(c.email)) continue;
		const words = [c.email, ...c.name.toLowerCase().split(/\s+/)];
		const score = words.some((w) => w.startsWith(q)) ? 2 : c.email.includes(q) || c.name.toLowerCase().includes(q) ? 1 : 0;
		if (score) scored.push({ c, score });
	}
	return scored
		.sort((a, b) => b.score - a.score || b.c.sent - a.c.sent || sortKey(a.c).localeCompare(sortKey(b.c)))
		.slice(0, limit)
		.map((s) => s.c);
}

/** Replaces the address being typed (after the last comma) with the chosen one. */
export function completeRecipient(value: string, email: string): string {
	const i = value.lastIndexOf(",");
	const before = i === -1 ? "" : `${value.slice(0, i + 1).trimEnd()} `;
	return `${before}${email}, `;
}

/** What's being typed in an address box: the text after the last comma. */
export function typedRecipient(value: string): string {
	return value.slice(value.lastIndexOf(",") + 1).trim();
}

/** Initials for a contact without a photo: "Jo Bloggs" → "JB", "sam@example.com" → "S". */
export function initials(c: Pick<Contact, "name" | "email">): string {
	const words = c.name.trim().split(/\s+/).filter(Boolean);
	if (words.length) return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
	return (c.email[0] ?? "?").toUpperCase();
}

// -- Import -------------------------------------------------------------------
// Reads a vCard (.vcf) or CSV file, as exported by Google Contacts, iCloud and Outlook, into a list of
// people, then works out which of them are new.

export interface ImportedContact {
	email: string;
	name: string;
	notes: string;
}

export interface ImportPlan {
	/** People to add: not in your contacts yet. */
	add: ImportedContact[];
	/** People skipped because their address is already in your contacts. */
	already: ImportedContact[];
}

/** The most people one import takes; bigger files are cut off here. */
export const MAX_IMPORT = 5000;

/** Reads a file's text as vCard or CSV, whichever it looks like. */
export function parseContactsFile(text: string, fileName = ""): ImportedContact[] {
	const body = text.replace(/^﻿/, "");
	const isVCard = /\.vcf$|\.vcard$/i.test(fileName) || /^\s*BEGIN:VCARD/im.test(body);
	return dedupe(isVCard ? parseVCard(body) : parseContactCsv(body));
}

/** Splits the people into new ones and ones already in your contacts (matched by email address). */
export function planImport(found: ImportedContact[], existing: Pick<Contact, "email">[]): ImportPlan {
	const have = new Set(existing.map((c) => c.email.toLowerCase()));
	const plan: ImportPlan = { add: [], already: [] };
	for (const c of found) (have.has(c.email) ? plan.already : plan.add).push(c);
	return plan;
}

/** One entry per address, keeping the first one seen but filling in a missing name or notes from later ones. */
function dedupe(list: ImportedContact[]): ImportedContact[] {
	const byEmail = new Map<string, ImportedContact>();
	for (const c of list) {
		const email = c.email.trim().toLowerCase();
		if (!isValidContactEmail(email)) continue;
		const name = clip(c.name, 200);
		const notes = clip(c.notes, 2000);
		const seen = byEmail.get(email);
		if (seen) {
			seen.name ||= name;
			seen.notes ||= notes;
		} else byEmail.set(email, { email, name, notes });
		if (byEmail.size >= MAX_IMPORT) break;
	}
	return [...byEmail.values()];
}

const clip = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

// -- vCard ------------------------------------------------------------------

interface VProp { name: string; params: string; value: string }

/** People from a vCard file: one entry per email address on each card. */
export function parseVCard(text: string): ImportedContact[] {
	const out: ImportedContact[] = [];
	let card: VProp[] | null = null;
	for (const prop of vcardLines(text)) {
		if (prop.name === "BEGIN" && /^vcard$/i.test(prop.value.trim())) card = [];
		else if (prop.name === "END" && /^vcard$/i.test(prop.value.trim())) {
			if (card) out.push(...cardToContacts(card));
			card = null;
		} else card?.push(prop);
	}
	return out;
}

function cardToContacts(card: VProp[]): ImportedContact[] {
	const get = (name: string) => card.filter((p) => p.name === name);
	const fn = get("FN")[0]?.value ?? "";
	const [family = "", given = "", middle = ""] = (get("N")[0] ? splitUnescaped(get("N")[0].value, ";") : []);
	const name = vText(fn) || [given, middle, family].map(vText).filter(Boolean).join(" ");
	const org = vText(splitUnescaped(get("ORG")[0]?.value ?? "", ";")[0] ?? "");
	const note = vText(get("NOTE")[0]?.value ?? "");
	const notes = [org, note].filter(Boolean).join(" · ");
	// Put the preferred address first, so it keeps the name if the same person appears twice.
	const emails = get("EMAIL")
		.sort((a, b) => Number(/pref/i.test(b.params)) - Number(/pref/i.test(a.params)))
		.flatMap((p) => splitAddresses(vText(p.value).replace(/^mailto:/i, "")));
	return emails.map((email) => ({ email, name, notes }));
}

/** Unfolded property lines, with quoted-printable values decoded. */
function* vcardLines(text: string): Generator<VProp> {
	const lines = text.split(/\r\n|\r|\n/);
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		// Folded lines carry on after a space or tab at the start of the next line.
		while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) line += lines[++i].slice(1);
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const head = line.slice(0, colon);
		const semi = head.indexOf(";");
		// Drop Apple's "item1." style group prefix.
		const name = (semi < 0 ? head : head.slice(0, semi)).replace(/^.*\./, "").toUpperCase();
		const params = semi < 0 ? "" : head.slice(semi + 1);
		let value = line.slice(colon + 1);
		if (/ENCODING=QUOTED-PRINTABLE|;QUOTED-PRINTABLE/i.test(params)) {
			// Quoted-printable lines end in "=" when they carry on.
			while (value.endsWith("=") && i + 1 < lines.length) value = value.slice(0, -1) + lines[++i];
			value = decodeQuotedPrintable(value);
		}
		yield { name, params, value };
	}
}

function decodeQuotedPrintable(value: string): string {
	const bytes: number[] = [];
	for (let i = 0; i < value.length; i++) {
		if (value[i] === "=" && /^[0-9A-F]{2}$/i.test(value.slice(i + 1, i + 3))) {
			bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
			i += 2;
		} else bytes.push(value.charCodeAt(i) & 0xff);
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Splits on a separator that isn't escaped with a backslash. */
function splitUnescaped(value: string, sep: string): string[] {
	const out: string[] = [];
	let cur = "";
	for (let i = 0; i < value.length; i++) {
		if (value[i] === "\\" && i + 1 < value.length) { cur += value[i] + value[++i]; continue; }
		if (value[i] === sep) { out.push(cur); cur = ""; } else cur += value[i];
	}
	out.push(cur);
	return out;
}

/** Undoes vCard escaping: \n, \, \; and \\. */
const vText = (value: string) => value.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? " " : c)).trim();

// -- CSV --------------------------------------------------------------------

/**
 * People from a CSV file with a header row. Understands Google Contacts ("E-mail 1 - Value"),
 * Outlook ("E-mail Address", "First Name", "Company") and plain "Name, Email" files.
 */
export function parseContactCsv(text: string): ImportedContact[] {
	const rows = parseCsv(text);
	if (rows.length === 0) return [];
	const header = rows[0].map((h) => h.trim().toLowerCase());
	const find = (re: RegExp) => header.findIndex((h) => re.test(h));
	const emailCols = header
		.map((h, i) => (/e-?mail/.test(h) && !/type|label|display|name/.test(h) ? i : -1))
		.filter((i) => i >= 0);
	const nameCol = find(/^(name|full name|display name|contact name)$/);
	const firstCol = find(/^(first name|given name)$/);
	const middleCol = find(/^(middle name|additional name)$/);
	const lastCol = find(/^(last name|family name|surname)$/);
	const displayCol = find(/^e-?mail display name$/);
	const notesCol = find(/^notes?$/);
	const orgCol = find(/^(company|organi[sz]ation|organi[sz]ation name|organi[sz]ation 1 - name)$/);
	const hasHeader = emailCols.length > 0 || nameCol >= 0 || firstCol >= 0;
	const out: ImportedContact[] = [];
	for (const row of hasHeader ? rows.slice(1) : rows) {
		const cell = (i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
		// Without an email column, take any address in the row.
		// Google puts several addresses in one cell, split by " ::: ".
		const emails = (emailCols.length ? emailCols.map(cell) : row).flatMap((v) => splitAddresses(v.replaceAll(":::", ",")));
		if (!emails.length) continue;
		// Outlook's display name looks like "Pat Jones (pat@example.com)".
		const display = cell(displayCol).replace(/\s*\([^()]*@[^()]*\)$/, "");
		const name = cell(nameCol)
			|| [cell(firstCol), cell(middleCol), cell(lastCol)].filter(Boolean).join(" ")
			|| (display.includes("@") ? "" : display);
		const notes = [cell(orgCol), cell(notesCol)].filter(Boolean).join(" · ");
		for (const email of emails) out.push({ email, name, notes });
	}
	return out;
}

/** Rows of a CSV (or semicolon or tab separated) file, with quoted fields handled. */
export function parseCsv(text: string): string[][] {
	const firstLine = text.slice(0, text.search(/\r?\n|$/));
	const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const);
	const sep = counts.sort((a, b) => b[1] - a[1])[0][0];
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
			else if (ch === '"') quoted = false;
			else field += ch;
		} else if (ch === '"' && field === "") quoted = true;
		else if (ch === sep) { row.push(field); field = ""; }
		else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			if (row.some((f) => f.trim())) rows.push(row);
			row = [];
			field = "";
		} else field += ch;
	}
	row.push(field);
	if (row.some((f) => f.trim())) rows.push(row);
	return rows;
}
