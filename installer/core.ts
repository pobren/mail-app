// The pure parts of the `npx @mrpwob/mail-app` command-line installer: reading the command line, wording for a
// terminal, and the permissions its Cloudflare API token needs. No network calls here, so it can be
// tested with `node --experimental-strip-types --test site/test/`.

export type Command = "setup" | "update" | "add-domain" | "help" | "version";

export interface Options {
	command: Command;
	/** Cloudflare account ID, to skip the question when the token reaches more than one account. */
	account?: string;
	/** The domain to install on, or "" for "just try it" on the account's workers.dev address. */
	domain?: string;
	/** The part before the domain in the web address ("mail" for mail.example.com). */
	subdomain?: string;
	/** The address the owner signs in with. */
	email?: string;
	/** Answer yes to every question: moving a domain's email from another service, re-running an update. */
	yes: boolean;
	/** Run an update even when this install already has the latest version. */
	force: boolean;
}

export class UsageError extends Error {}

const VALUE_FLAGS = new Set(["account", "domain", "subdomain", "email"]);

/** Reads `mail-app <command> [--flag value | --flag=value]`. Throws UsageError with a message for the person. */
export function parseArgs(argv: string[]): Options {
	const opts: Options = { command: "help", yes: false, force: false };
	const rest = [...argv];
	const first = rest[0];
	if (first && !first.startsWith("-")) {
		rest.shift();
		if (first === "setup" || first === "install") opts.command = "setup";
		else if (first === "update" || first === "upgrade") opts.command = "update";
		else if (first === "add-domain" || first === "domain") {
			opts.command = "add-domain";
			// The domain can come straight after the command: npx @mrpwob/mail-app add-domain example.org
			if (rest[0] && !rest[0].startsWith("-")) opts.domain = rest.shift()!.trim();
		}
		else if (first === "help") opts.command = "help";
		else if (first === "version") opts.command = "version";
		else throw new UsageError(`"${first}" isn't a mail-app command. Try: npx @mrpwob/mail-app setup, update or add-domain.`);
	}
	while (rest.length) {
		const arg = rest.shift()!;
		if (arg === "-h" || arg === "--help") { opts.command = "help"; continue; }
		if (arg === "-v" || arg === "--version") { opts.command = "version"; continue; }
		if (arg === "-y" || arg === "--yes") { opts.yes = true; continue; }
		if (arg === "--force") { opts.force = true; continue; }
		if (arg === "--trial") { opts.domain = ""; continue; }
		if (arg === "--token" || arg.startsWith("--token=")) {
			throw new UsageError("Please don't put your token on the command line, where it's saved in your shell history. Set CLOUDFLARE_API_TOKEN, or paste it when asked.");
		}
		const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
		if (!m || !VALUE_FLAGS.has(m[1])) throw new UsageError(`Unknown option ${arg}. Run npx @mrpwob/mail-app help to see the options.`);
		const value = m[2] ?? rest.shift();
		if (value === undefined || value.startsWith("--")) throw new UsageError(`--${m[1]} needs a value.`);
		(opts as unknown as Record<string, string>)[m[1]] = value.trim();
	}
	return opts;
}

/**
 * Permissions the Cloudflare API token needs, as the dashboard names them on "Create Custom Token".
 * Account Settings Read lists the account. API Tokens Edit is optional: without it, Mail App asks for
 * the installer to be run again after someone is invited (see teamSignIn in install-run.ts).
 */
export const TOKEN_PERMISSIONS: { group: "Account" | "Zone" | "User"; name: string; level: "Read" | "Edit" | "Admin"; optional?: boolean }[] = [
	{ group: "Account", name: "Account Settings", level: "Read" },
	// Cloudflare replaced "Workers Scripts" with Workers roles in Sep 2026; creating a Worker needs Admin.
	{ group: "Account", name: "Workers", level: "Admin" },
	{ group: "Account", name: "Workers R2 Storage", level: "Edit" },
	{ group: "Account", name: "Workers AI", level: "Read" },
	{ group: "Account", name: "Access: Apps and Policies", level: "Edit" },
	{ group: "Account", name: "Access: Organizations, Identity Providers, and Groups", level: "Edit" },
	{ group: "Account", name: "Email Routing Addresses", level: "Edit" },
	{ group: "Account", name: "Email Sending", level: "Edit" },
	{ group: "Account", name: "API Tokens", level: "Edit", optional: true },
	{ group: "Zone", name: "Zone", level: "Read" },
	{ group: "Zone", name: "Zone Settings", level: "Edit" },
	{ group: "Zone", name: "DNS", level: "Edit" },
	{ group: "Zone", name: "Workers Routes", level: "Edit" },
	{ group: "Zone", name: "Email Routing Rules", level: "Edit" },
	{ group: "Zone", name: "Access: Apps and Policies", level: "Edit" },
	{ group: "User", name: "User Details", level: "Read" },
];

export const TOKENS_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

/** How to make the token, for the help text and for when Cloudflare refuses a call. */
export function tokenHelp(): string {
	const line = (p: (typeof TOKEN_PERMISSIONS)[number]) => `    ${p.group.padEnd(9)}${p.name}: ${p.level}${p.optional ? " (optional, lets Mail App add people to sign-in itself)" : ""}`;
	return [
		`  Make one at ${TOKENS_PAGE}: Create Token, then "Create Custom Token", with:`,
		...TOKEN_PERMISSIONS.map(line),
		"  Account Resources: your account. Zone Resources: all zones on it (or just the domain you'll use).",
	].join("\n");
}

/**
 * The install steps' messages were first written for a web page ("press Try again", "sign in again").
 * In a terminal the same advice means running the command again with a token that has the permissions.
 */
export function forTerminal(message: string): string {
	return message
		.replace(/Please sign out, sign in again and allow everything on Cloudflare's page\./g, "Your API token is missing a permission. Check it has everything listed by npx @mrpwob/mail-app help, then run the command again.")
		.replace(/Please sign in with Cloudflare again[^.]*\./g, "Please run the command again.")
		.replace(/(?:Then )?come back here and press Try again\./g, "Then run the command again.")
		.replace(/Please pick it again\./g, "Please check the domain and run the command again.")
		.replace(/, or tell us, then/g, ", then")
		.replace(/\btry again\b/g, "run the command again");
}

/** The part of a web address before its domain: "mail" for mail.example.com on example.com. */
export function subdomainOf(hostname: string, domain: string): string | null {
	const host = hostname.toLowerCase();
	const zone = domain.toLowerCase();
	if (!host.endsWith(`.${zone}`)) return null;
	const label = host.slice(0, -zone.length - 1);
	return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? label : null;
}

/** "1.55" < "1.56" < "1.100". Dated builds from before numbered releases count as oldest. */
export function isNewer(latest: string, current: string | null | undefined): boolean {
	if (!current) return true;
	const parse = (v: string) => (/^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : null);
	const a = parse(latest);
	const b = parse(current);
	if (!a) return false;
	if (!b) return true;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return false;
}

export const HELP = `Mail App installer

  npx @mrpwob/mail-app setup    Install Mail App on your own Cloudflare account
  npx @mrpwob/mail-app update   Update an install to the latest version
  npx @mrpwob/mail-app add-domain [domain]
                                Get email for another domain on your Cloudflare account

Options
  --account <id>    Cloudflare account to use, if your token reaches more than one
  --domain <name>   Domain to install on (setup) or to add (add-domain)
  --trial           No domain: try it on your workers.dev address (setup)
  --subdomain <x>   Web address before the domain, "mail" by default (setup)
  --email <addr>    The address you'll sign in with (setup)
  -y, --yes         Answer yes to every question
  --force           Re-run an update even if you have the latest version

Your Cloudflare API token
  Set CLOUDFLARE_API_TOKEN, or paste it when asked. It's only ever sent to
  Cloudflare. Mail App's own files come inside this package.
`;
