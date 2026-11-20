// Mail App addition (not part of upstream Agentic Inbox).
// Other accounts: a mailbox can check up to three outside email accounts (Gmail, iCloud, Yahoo, a work
// or ISP address) over IMAP or POP3, and send as them through that provider's own SMTP server. The
// Worker side is workers/lib/other-accounts.ts and workers/durableObject/other-accounts.ts.
//
// Pure functions only, so the browser, the Worker and the tests can all use them.

export type Protocol = "imap" | "pop3";
/** "tls": secure from the start (993, 995, 465). "starttls": plain, then made secure (143, 110, 587). */
export type Security = "tls" | "starttls";

export interface ServerSettings {
	host: string;
	port: number;
	security: Security;
}

/** One outside account, as stored (without its password, which is kept apart, encrypted). */
export interface OtherAccount {
	id: string;
	/** The mailbox it brings mail into. */
	mailbox: string;
	/** The outside address, lower case. */
	address: string;
	/** The name mail is sent with. Missing means the mailbox's own name. */
	name?: string;
	/** Which preset it was set up from ("gmail", "icloud" and so on), or "other". */
	provider: string;
	protocol: Protocol;
	incoming: ServerSettings;
	/** Usually the address itself. */
	username: string;
	/** Missing when the account only brings mail in. */
	outgoing?: ServerSettings;
	/** A label put on everything that comes in from it, such as "Gmail". Empty for none. */
	label: string;
	/** When it was added (ISO). */
	added: string;
}

/** The whole install's other accounts, in R2 at OTHER_ACCOUNTS_KEY. */
export interface OtherAccountsFile {
	/** An admin can turn the feature off for everyone. */
	off?: boolean;
	accounts: (OtherAccount & { secret: string })[];
}

/** How a check went, kept in the account's own Durable Object. */
export interface AccountStatus {
	/** When it was last checked (ISO), whether or not that worked. */
	checkedAt?: string;
	/** When a check last worked (ISO). */
	okAt?: string;
	/** What went wrong last time, in plain English. Missing when the last check worked. */
	error?: string;
	/** Checks in a row that failed. */
	failures: number;
	/** Emails brought in, ever. */
	fetched: number;
	/** Emails left behind because they were over 25 MB. */
	tooBig: number;
	/** When the next check is due (ms). */
	nextAt?: number;
	/** Still bringing in the last 30 days. */
	catchingUp?: boolean;
}

export const OTHER_ACCOUNTS_KEY = "setup/other-accounts.json";
export const MAX_OTHER_ACCOUNTS = 3;
export const CHECK_EVERY_MS = 5 * 60_000;
/** An account that keeps failing is only tried once an hour, so a dead password doesn't knock all day. */
export const SLOW_CHECK_MS = 60 * 60_000;
export const SLOW_AFTER_FAILURES = 3;
/** The same limit as mail that arrives the normal way. */
export const MAX_FETCH_BYTES = 25 * 1024 * 1024;
/** Emails brought in per account per check; any more follow a minute later. */
export const FETCH_BATCH = 25;
export const CATCH_UP_DAYS = 30;
export const MAX_LABEL = 40;

export interface Preset {
	id: string;
	name: string;
	/** Domains whose addresses this preset fits, so typing the address picks it. */
	domains: string[];
	imap?: ServerSettings;
	pop3?: ServerSettings;
	smtp: ServerSettings;
	/** Where to make an app password, if the provider needs one. */
	appPasswordUrl?: string;
	/** One line of help shown under the password box. */
	note: string;
}

// The big providers' published settings. Anything else uses "Other", where all of it can be typed in.
export const PRESETS: Preset[] = [
	{
		id: "gmail", name: "Gmail", domains: ["gmail.com", "googlemail.com"],
		imap: { host: "imap.gmail.com", port: 993, security: "tls" },
		pop3: { host: "pop.gmail.com", port: 995, security: "tls" },
		smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
		appPasswordUrl: "https://myaccount.google.com/apppasswords",
		note: "Gmail needs an app password (turn on 2-Step Verification first). Google Workspace addresses work the same way.",
	},
	{
		id: "icloud", name: "iCloud", domains: ["icloud.com", "me.com", "mac.com"],
		imap: { host: "imap.mail.me.com", port: 993, security: "tls" },
		smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
		appPasswordUrl: "https://account.apple.com/account/manage",
		note: "iCloud needs an app-specific password, made under Sign-In and Security on your Apple Account page.",
	},
	{
		id: "yahoo", name: "Yahoo", domains: ["yahoo.com", "yahoo.co.uk", "ymail.com", "rocketmail.com"],
		imap: { host: "imap.mail.yahoo.com", port: 993, security: "tls" },
		pop3: { host: "pop.mail.yahoo.com", port: 995, security: "tls" },
		smtp: { host: "smtp.mail.yahoo.com", port: 465, security: "tls" },
		appPasswordUrl: "https://login.yahoo.com/myaccount/security/app-password",
		note: "Yahoo needs an app password, made under Account security.",
	},
	{
		id: "aol", name: "AOL", domains: ["aol.com", "aim.com"],
		imap: { host: "imap.aol.com", port: 993, security: "tls" },
		pop3: { host: "pop.aol.com", port: 995, security: "tls" },
		smtp: { host: "smtp.aol.com", port: 465, security: "tls" },
		appPasswordUrl: "https://login.aol.com/myaccount/security/app-password",
		note: "AOL needs an app password, made under Account security.",
	},
	{
		id: "fastmail", name: "Fastmail", domains: ["fastmail.com", "fastmail.fm", "fastmail.co.uk"],
		imap: { host: "imap.fastmail.com", port: 993, security: "tls" },
		pop3: { host: "pop.fastmail.com", port: 995, security: "tls" },
		smtp: { host: "smtp.fastmail.com", port: 465, security: "tls" },
		appPasswordUrl: "https://app.fastmail.com/settings/security/apps",
		note: "Fastmail needs an app password, made under Settings, Privacy & Security, Connected apps.",
	},
	{
		id: "zoho", name: "Zoho Mail", domains: ["zoho.com", "zohomail.com", "zoho.eu"],
		imap: { host: "imap.zoho.com", port: 993, security: "tls" },
		pop3: { host: "pop.zoho.com", port: 995, security: "tls" },
		smtp: { host: "smtp.zoho.com", port: 465, security: "tls" },
		appPasswordUrl: "https://accounts.zoho.com/home#security/app_password",
		note: "Switch IMAP on in Zoho's mail settings first. With two-factor sign-in, use an app password. If your Zoho account is in Europe, choose Other and use imap.zoho.eu and smtp.zoho.eu.",
	},
	{
		id: "gmx", name: "GMX", domains: ["gmx.com", "gmx.co.uk", "gmx.net", "gmx.de"],
		imap: { host: "imap.gmx.com", port: 993, security: "tls" },
		pop3: { host: "pop.gmx.com", port: 995, security: "tls" },
		smtp: { host: "mail.gmx.com", port: 465, security: "tls" },
		note: "Switch on IMAP and POP3 access in GMX's mail settings first.",
	},
	{
		id: "mailbox-org", name: "mailbox.org", domains: ["mailbox.org"],
		imap: { host: "imap.mailbox.org", port: 993, security: "tls" },
		pop3: { host: "pop3.mailbox.org", port: 995, security: "tls" },
		smtp: { host: "smtp.mailbox.org", port: 465, security: "tls" },
		note: "Use your mailbox.org address and password, or an app password if you've made one.",
	},
	{
		id: "ionos", name: "IONOS", domains: ["ionos.co.uk", "ionos.com"],
		imap: { host: "imap.ionos.co.uk", port: 993, security: "tls" },
		pop3: { host: "pop.ionos.co.uk", port: 995, security: "tls" },
		smtp: { host: "smtp.ionos.co.uk", port: 465, security: "tls" },
		note: "Works for any domain whose email is at IONOS. Outside the UK, use ionos.com in the server names.",
	},
];

/** Providers that can't be added, and what to tell people instead. */
export const NOT_POSSIBLE: { domains: string[]; text: string }[] = [
	{ domains: ["outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "live.co.uk", "msn.com"], text: "Outlook.com and Hotmail need a Sign in with Microsoft button, which isn't in Mail App yet." },
	{ domains: ["proton.me", "protonmail.com", "pm.me"], text: "Proton Mail doesn't let other apps check your mail, except through its own Bridge app on a computer." },
	{ domains: ["tuta.com", "tutanota.com", "tutamail.com", "tuta.io"], text: "Tuta doesn't let other apps check your mail." },
];

const ADDRESS_RE = /^[a-z0-9.!#$%&'*/=?^_`{|}~+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const normalise = (s: string) => s.trim().toLowerCase();

export function presetById(id: string): Preset | undefined {
	return PRESETS.find((p) => p.id === id);
}

/** The preset that fits an address, if any. */
export function presetFor(address: string): Preset | undefined {
	const domain = normalise(address).split("@")[1] ?? "";
	return PRESETS.find((p) => p.domains.includes(domain));
}

/** Why an address can't be added at all, or null. */
export function notPossible(address: string): string | null {
	const domain = normalise(address).split("@")[1] ?? "";
	return NOT_POSSIBLE.find((n) => n.domains.includes(domain))?.text ?? null;
}

/** Security for a port people type in, when they haven't said. */
export function securityForPort(port: number): Security {
	return [993, 995, 465].includes(port) ? "tls" : "starttls";
}

/** Server names that point back inside a network are refused, so nobody can use this to look around one. */
export function privateHost(host: string): boolean {
	const h = normalise(host);
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
	const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (!ip) return false;
	const [a, b] = [Number(ip[1]), Number(ip[2])];
	return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

export function serverProblem(s: ServerSettings | undefined, what: string, dev = false): string | null {
	if (!s) return `The ${what} server is missing.`;
	const host = normalise(s.host ?? "");
	if (!HOST_RE.test(host) && !(dev && host === "localhost") && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return `The ${what} server name doesn't look right. It's usually something like imap.example.com.`;
	if (!dev && privateHost(host)) return `The ${what} server has to be on the internet, not a local network.`;
	if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return `The ${what} port should be a number, such as 993.`;
	// Cloudflare doesn't allow port 25 from Workers, and it isn't meant for apps anyway.
	if (s.port === 25) return "Port 25 can't be used. Most providers take 465 or 587 for sending from apps.";
	if (s.security !== "tls" && s.security !== "starttls") return `Choose how the ${what} connection is secured.`;
	return null;
}

export interface NewAccountInput {
	address: string;
	name?: string;
	provider: string;
	protocol: Protocol;
	username?: string;
	password: string;
	incoming?: ServerSettings;
	/** null: bring mail in only. */
	outgoing?: ServerSettings | null;
	label?: string;
	/** Bring in the last 30 days too (IMAP only). */
	catchUp?: boolean;
}

export function cleanLabel(v: unknown): string {
	return typeof v === "string" ? v.replace(/[\x00-\x1f]/g, "").trim().slice(0, MAX_LABEL) : "";
}

/**
 * Checks an Add an account form and fills in the provider's servers. Returns the account (without id,
 * mailbox and added) or a sentence saying what to fix.
 */
export function readNewAccount(input: NewAccountInput, opts: { dev?: boolean } = {}): { account: Omit<OtherAccount, "id" | "mailbox" | "added">; password: string } | { error: string } {
	const address = normalise(input.address ?? "");
	if (!ADDRESS_RE.test(address)) return { error: "Enter the full email address of the account, such as you@gmail.com." };
	const blocked = notPossible(address);
	if (blocked) return { error: blocked };
	const password = typeof input.password === "string" ? input.password : "";
	if (!password || password.length > 1000) return { error: "Enter the account's password (or app password)." };
	const protocol: Protocol = input.protocol === "pop3" ? "pop3" : "imap";
	const preset = input.provider && input.provider !== "other" ? presetById(input.provider) : undefined;
	const incoming = preset ? (protocol === "pop3" ? preset.pop3 : preset.imap) : input.incoming;
	if (preset && !incoming) return { error: `${preset.name} only works with ${protocol === "pop3" ? "IMAP" : "POP3"}.` };
	const inProblem = serverProblem(incoming, protocol === "pop3" ? "POP3" : "IMAP", opts.dev);
	if (inProblem) return { error: inProblem };
	let outgoing: ServerSettings | undefined;
	if (input.outgoing !== null) {
		outgoing = preset ? preset.smtp : input.outgoing;
		const outProblem = serverProblem(outgoing, "SMTP", opts.dev);
		if (outProblem) return { error: outProblem };
	}
	const username = (input.username ?? "").trim() || address;
	if (username.length > 320 || /[\r\n]/.test(username)) return { error: "That user name doesn't look right." };
	const name = typeof input.name === "string" ? input.name.replace(/[\r\n"<>]/g, "").trim().slice(0, 80) : "";
	const label = input.label === undefined ? (preset?.name ?? address) : cleanLabel(input.label);
	return {
		account: {
			address, ...(name ? { name } : {}), provider: preset?.id ?? "other", protocol,
			incoming: { host: normalise(incoming!.host), port: incoming!.port, security: incoming!.security },
			username,
			...(outgoing ? { outgoing: { host: normalise(outgoing.host), port: outgoing.port, security: outgoing.security } } : {}),
			label: cleanLabel(label),
		},
		password,
	};
}

/** Reads the stored file, dropping anything malformed, so a bad file never stops mail. */
export function cleanFile(raw: unknown): OtherAccountsFile {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const list = Array.isArray(r.accounts) ? r.accounts : [];
	const accounts: OtherAccountsFile["accounts"] = [];
	const seen = new Set<string>();
	for (const a of list as Record<string, unknown>[]) {
		if (!a || typeof a !== "object") continue;
		if (typeof a.id !== "string" || typeof a.mailbox !== "string" || typeof a.address !== "string" || typeof a.secret !== "string") continue;
		const incoming = a.incoming as ServerSettings | undefined;
		if (!incoming || typeof incoming.host !== "string" || typeof incoming.port !== "number") continue;
		const key = `${a.mailbox}|${a.address}`;
		if (seen.has(key)) continue;
		seen.add(key);
		accounts.push(a as unknown as OtherAccountsFile["accounts"][number]);
	}
	return { ...(r.off === true ? { off: true } : {}), accounts };
}

/** What the browser is shown: never the password. */
export type OtherAccountView = OtherAccount & { status: AccountStatus };

export function withoutSecret(a: OtherAccountsFile["accounts"][number]): OtherAccount {
	const { secret: _secret, ...rest } = a;
	return rest;
}

/** The addresses a mailbox can send as through other accounts (those with an SMTP server). */
export function sendAsAddresses(file: OtherAccountsFile, mailbox: string): string[] {
	if (file.off) return [];
	const m = normalise(mailbox);
	return file.accounts.filter((a) => a.mailbox === m && a.outgoing).map((a) => a.address);
}

/** When the next check should be, after one that worked or failed. */
export function nextCheckAt(now: number, failures: number): number {
	return now + (failures >= SLOW_AFTER_FAILURES ? SLOW_CHECK_MS : CHECK_EVERY_MS);
}

/** IMAP SEARCH's date form: "21-Oct-2026". */
export function searchDate(d: Date): string {
	const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
	return `${d.getUTCDate()}-${mon}-${d.getUTCFullYear()}`;
}
