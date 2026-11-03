// `npx @mrpwob/mail-app`: installs and updates Mail App on the person's own Cloudflare account from their
// terminal, with a Cloudflare API token they make themselves. The token only ever goes to
// api.cloudflare.com. The release files (the built app) come inside this package, so nothing else is
// downloaded: `npx @mrpwob/mail-app@latest update` always brings the newest release.
//
// Built into one file, with the release next to it, by `npm run package` (see installer/build-cli.ts).

import { createInterface } from "node:readline/promises";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { planSteps, SCRIPT_NAME, WEB_SUBDOMAIN, type ActionId, type InstallChoice, type PlanStep, parseChoice } from "./deploy";
import { appInstalled, loadRelease, readDomainsList, runAction, saveToDomainsList, webAddressStatus, InstallError, type ActionResult, type RunContext } from "./install-run";
import { PLAN_URL } from "../shared/sending";
import { HELP, type Options, UsageError, forTerminal, isNewer, parseArgs, subdomainOf, tokenHelp } from "./core";

const { stdin, stdout } = process;

declare const CLI_VERSION: string;

const API = "https://api.cloudflare.com/client/v4";
/** The release files sit next to this file, in release/, and are read through a fetch-like reader. */
const RELEASES_BASE = "https://release.local/";
const RELEASE_DIR = new URL("./", import.meta.url);

// -- Talking to the person --------------------------------------------

const tty = stdout.isTTY;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");

const say = (s = "") => stdout.write(`${s}\n`);

class Stop extends Error {}

let rl: ReturnType<typeof createInterface> | null = null;
function prompts() {
	rl ??= createInterface({ input: stdin, output: stdout, terminal: tty });
	return rl;
}

async function ask(question: string, fallback = ""): Promise<string> {
	if (!stdin.isTTY) {
		if (fallback) return fallback;
		throw new Stop(`${question.trim()} needs an answer, but there's no keyboard to type one. Use the options (npx @mrpwob/mail-app help).`);
	}
	const answer = (await prompts().question(`${question}${fallback ? dim(` (${fallback})`) : ""} `)).trim();
	return answer || fallback;
}

async function confirm(question: string, opts: Options, fallback = false): Promise<boolean> {
	if (opts.yes) return true;
	if (!stdin.isTTY) return fallback;
	const answer = (await ask(`${question} ${dim(fallback ? "[Y/n]" : "[y/N]")}`)).toLowerCase();
	return answer ? answer.startsWith("y") : fallback;
}

/** Asks for the token without showing it on screen. */
async function askSecret(question: string): Promise<string> {
	if (!stdin.isTTY) throw new Stop("No Cloudflare API token. Set CLOUDFLARE_API_TOKEN and run the command again.");
	const r = prompts();
	const out = r as unknown as { _writeToOutput?: (s: string) => void };
	const original = out._writeToOutput;
	stdout.write(question + " ");
	out._writeToOutput = (s: string) => {
		if (s.includes("\n") || s.includes("\r")) stdout.write("\n");
	};
	try {
		return (await r.question("")).trim();
	} finally {
		out._writeToOutput = original;
	}
}

async function choose<T>(question: string, items: T[], label: (t: T) => string, extra?: string): Promise<number> {
	items.forEach((t, i) => say(`  ${bold(String(i + 1))}  ${label(t)}`));
	if (extra) say(`  ${bold("0")}  ${extra}`);
	for (;;) {
		const n = Number(await ask(question, items.length === 1 && !extra ? "1" : ""));
		if (Number.isInteger(n) && n >= (extra ? 0 : 1) && n <= items.length) return n - 1;
		say(yellow(`Please type a number from ${extra ? 0 : 1} to ${items.length}.`));
	}
}

// -- Cloudflare -------------------------------------------------------

interface CfResult<T> { ok: boolean; status: number; result: T | null; errors: { code: number; message: string }[] }

async function cf<T>(token: string, path: string): Promise<CfResult<T>> {
	try {
		const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
		const body = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { code: number; message: string }[] } | null;
		return { ok: res.ok && Boolean(body?.success), status: res.status, result: body?.result ?? null, errors: body?.errors ?? [] };
	} catch (e) {
		throw new Stop(`We couldn't reach Cloudflare. Please check your connection and run the command again. (${String(e)})`);
	}
}

const details = (r: CfResult<unknown>) => `HTTP ${r.status}${r.errors.length ? ` (${r.errors.map((e) => `${e.code}: ${e.message}`).join("; ")})` : ""}`;

async function getToken(): Promise<string> {
	let token = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
	if (!token) {
		say(`The installer needs a Cloudflare API token to set things up on your account.\n${tokenHelp()}\n`);
		token = await askSecret("Paste your API token:");
	}
	if (!token) throw new Stop("No token, so nothing was changed.");
	const verify = await cf<{ status?: string }>(token, "/user/tokens/verify");
	if (!verify.ok || verify.result?.status !== "active") {
		throw new Stop(`Cloudflare didn't accept that API token. It needs to be an active user API token (not a Global API Key). ${details(verify)}`);
	}
	return token;
}

async function pickAccount(token: string, opts: Options, filter?: (id: string) => Promise<boolean>): Promise<{ id: string; name: string }> {
	const r = await cf<{ id: string; name: string }[]>(token, "/accounts?per_page=50");
	if (!r.ok) throw new Stop(`We couldn't list your Cloudflare accounts. Your token needs "Account Settings: Read". ${details(r)}`);
	let accounts = r.result ?? [];
	if (opts.account) {
		accounts = accounts.filter((a) => a.id === opts.account);
		if (!accounts.length) throw new Stop(`Your token can't reach account ${opts.account}.`);
	}
	if (filter) {
		const keep = await Promise.all(accounts.map((a) => filter(a.id)));
		accounts = accounts.filter((_, i) => keep[i]);
	}
	if (!accounts.length) throw new Stop(filter ? "Mail App isn't installed on any account this token can reach. To install it, run npx @mrpwob/mail-app setup." : "Your token doesn't reach any Cloudflare account. Check its Account Resources.");
	if (accounts.length === 1) return accounts[0];
	say(bold("Which Cloudflare account?"));
	return accounts[await choose("Account:", accounts, (a) => `${a.name} ${dim(a.id)}`)];
}

// -- Running the install steps ----------------------------------------

function ctxFor(token: string, choice: InstallChoice): RunContext {
	// The install steps read the release through a fetch-like reader; here it reads the files in this package.
	const assets = {
		fetch: async (req: Request) => {
			const path = new URL(req.url).pathname.replace(/^\/+/, "");
			if (path.split("/").includes("..")) return new Response("Not found", { status: 404 });
			try {
				return new Response(await readFile(new URL(path, RELEASE_DIR)));
			} catch {
				return new Response("Not found", { status: 404 });
			}
		},
	} as unknown as RunContext["assets"];
	return { token, choice, assets, base: RELEASES_BASE };
}

function fail(result: ActionResult): never {
	say(red(`✗ ${forTerminal(result.message ?? "Something went wrong.")}`));
	if (result.link) say(`  ${result.link.text}: ${result.link.href}`);
	if (result.detail) say(dim(`  Cloudflare said: ${result.detail}`));
	if (/HTTP 40[13]\b/.test(result.detail ?? "")) say(`\n${tokenHelp()}`);
	say(dim("\nAnything already done is kept, so running the command again carries on from here."));
	throw new Stop("");
}

async function runSteps(token: string, choice: InstallChoice, opts: Options, steps: PlanStep[] = planSteps(choice)): Promise<{ hostname?: string; sending?: ActionResult["sending"] }> {
	let hostname: string | undefined;
	let sending: ActionResult["sending"];
	// The shared install code reports best-effort extras (a sign-in page hint and the like) with
	// console.warn. Collect them and show them under the step instead of breaking its progress line.
	const notes: string[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => notes.push(args.map(String).join(" "));
	try {
		for (const step of steps) {
			stdout.write(`${dim("…")} ${step.label}${tty ? "" : "\n"}`);
			for (const action of step.actions) {
				let result = await runAction(action as ActionId, ctxFor(token, choice));
				while (result.ok && result.more) result = await runAction(action as ActionId, ctxFor(token, choice));
				if (!result.ok && result.mailElsewhere) {
					if (tty) stdout.write("\n");
					say(yellow(`! ${result.message}`));
					say(`  If you go ahead, the installer removes its email records (${result.mailElsewhere.hosts.join(", ")}) so mail for ${choice.domain}`);
					say(`  comes to Mail App instead. Email stops arriving at ${result.mailElsewhere.provider}.`);
					if (!(await confirm(`Move ${choice.domain}'s email to Mail App?`, opts))) {
						throw new Stop(`Nothing was changed on ${choice.domain}'s email. Run the command again when you're ready, or pick another domain.`);
					}
					choice.moveMail = true;
					result = await runAction(action as ActionId, ctxFor(token, choice));
				}
				if (!result.ok) {
					if (tty) stdout.write("\n");
					fail(result);
				}
				hostname = result.hostname ?? hostname;
				if (result.sending) sending = result.sending;
			}
			if (tty) stdout.write(`\r\x1b[2K`);
			say(`${green("✓")} ${step.label}`);
			for (const note of notes.splice(0)) say(dim(`    Note: ${note}`));
		}
	} finally {
		console.warn = warn;
	}
	return { hostname, sending };
}

function finished(choice: InstallChoice, hostname: string | undefined, sending: ActionResult["sending"], signIn: string | null) {
	const update = signIn === null;
	say();
	say(bold(update ? "Mail App is up to date." : "Mail App is installed."));
	if (hostname) say(`  Open it at ${bold(`https://${hostname}`)}`);
	say(signIn ? `  Sign in with ${bold(signIn)}: Cloudflare emails you a code.` : "  Sign in as before.");
	if (sending?.status === "plan") {
		say();
		say(yellow("! Sending to other people needs Cloudflare's Workers Paid plan ($5 a month). Receiving works now."));
		say(`  Turn it on at ${PLAN_URL.replace(":account", choice.accountId)}, then run ${bold("npx @mrpwob/mail-app update --force")}.`);
	} else if (sending?.status === "failed") {
		say();
		say(yellow(`! We couldn't switch on sending for ${choice.domain} yet. Mail App shows what to do in Settings.`));
		if (sending.detail) say(dim(`  Cloudflare said: ${sending.detail}`));
	}
	say();
	say(dim("When there's a new version, Mail App tells you. Run npx @mrpwob/mail-app update to install it."));
}

// -- Commands ---------------------------------------------------------

async function setup(opts: Options) {
	say(bold("Install Mail App on your Cloudflare account\n"));
	const token = await getToken();
	const account = await pickAccount(token, opts);

	if (await appInstalled(token, account.id)) {
		say(yellow(`Mail App is already installed on ${account.name}.`));
		if (!(await confirm("Run setup again? This keeps your mail and can change its domain or web address. (For a plain update, use npx @mrpwob/mail-app update.)", opts))) return;
	}

	// The domain: one of the account's zones, or none for a trial on workers.dev.
	let domain = opts.domain;
	if (domain === undefined) {
		const zones = await cf<{ name: string; status: string }[]>(token, `/zones?account.id=${account.id}&per_page=50`);
		if (!zones.ok) throw new Stop(`We couldn't list your domains. Your token needs "Zone: Read". ${details(zones)}`);
		const active = (zones.result ?? []).filter((z) => z.status === "active");
		say(bold("\nWhich domain should Mail App use?"));
		if (!active.length) say(dim("  No active domains on this account yet, so you can try it on your workers.dev address first."));
		const i = await choose("Domain:", active, (z) => z.name, "No domain yet: try it on my workers.dev address");
		domain = i < 0 ? "" : active[i].name;
	}

	let subdomain = opts.subdomain ?? "";
	if (domain && !subdomain) subdomain = await ask(`\nWeb address: what goes before ${domain}?`, WEB_SUBDOMAIN);

	const user = await cf<{ email?: string }>(token, "/user");
	if (!user.ok) throw new Stop(`We couldn't read your Cloudflare email address. Your token needs "User Details: Read". ${details(user)}`);
	const cfEmail = user.result?.email?.toLowerCase() ?? "";
	const signInEmail = opts.email ?? (await ask("\nThe email address you'll sign in with:", cfEmail));

	const choice = parseChoice({ accountId: account.id, domain, subdomain, signInEmail });
	if (!choice) throw new Stop("That domain, web address or email address doesn't look right. Please check it and run the command again.");

	if (choice.domain) {
		const web = await webAddressStatus(ctxFor(token, choice));
		if (web.status === "taken") throw new Stop(`${web.hostname} is already used by something else on ${choice.domain}. Pick another with --subdomain.`);
	}

	const release = await loadRelease(ctxFor(token, choice).assets, RELEASES_BASE);
	say(`\nInstalling Mail App ${release.version} on ${bold(account.name)}${choice.domain ? ` for ${bold(choice.domain)}` : ""}.\n`);
	const { hostname, sending } = await runSteps(token, choice, opts);
	finished(choice, hostname, sending, choice.signInEmail ?? cfEmail);
}

/** The domain and web address of an existing install, from the custom domains attached to its Worker. */
async function existingChoice(token: string, accountId: string): Promise<InstallChoice> {
	const r = await cf<{ hostname: string; zone_name: string; service: string }[]>(token, `/accounts/${accountId}/workers/domains?service=${SCRIPT_NAME}`);
	if (!r.ok) throw new Stop(`We couldn't read Mail App's web address. Your token needs "Workers: Admin". ${details(r)}`);
	const mine = (r.result ?? []).filter((d) => d.service === SCRIPT_NAME);
	// No web address on a domain: a trial on workers.dev.
	if (!mine.length) return { accountId, domain: null };
	let pick = mine[0];
	if (mine.length > 1) {
		say(bold("Mail App answers at more than one address. Which is the main one?"));
		pick = mine[await choose("Address:", mine, (d) => d.hostname)];
	}
	const subdomain = subdomainOf(pick.hostname, pick.zone_name);
	if (!subdomain) throw new Stop(`Mail App's address ${pick.hostname} isn't one this installer can update. Please update it with Wrangler instead (see the README).`);
	return { accountId, domain: pick.zone_name.toLowerCase(), subdomain };
}

async function update(opts: Options) {
	say(bold("Update Mail App\n"));
	const token = await getToken();
	const account = await pickAccount(token, opts, (id) => appInstalled(token, id));
	const choice = await existingChoice(token, account.id);

	const settings = await cf<{ bindings?: { name: string; type: string; text?: string }[] }>(token, `/accounts/${account.id}/workers/scripts/${SCRIPT_NAME}/settings`);
	const current = settings.result?.bindings?.find((b) => b.name === "APP_VERSION")?.text ?? null;
	const release = await loadRelease(ctxFor(token, choice).assets, RELEASES_BASE);
	if (!isNewer(release.version, current) && !opts.force) {
		say(`${green("✓")} Mail App ${release.version} is the latest version, and ${account.name} already has it.`);
		say(dim("  To run every step again anyway (for example after inviting people), add --force."));
		return;
	}
	say(`Updating ${bold(account.name)}${choice.domain ? ` (${choice.subdomain}.${choice.domain})` : ""} from ${current ?? "an older build"} to ${bold(release.version)}.\n`);
	const { hostname, sending } = await runSteps(token, choice, opts);
	finished(choice, hostname, sending, null);
}

/** Email for one more domain: Email Routing to Mail App, its email records, sending, then Mail App's own list. */
async function addDomain(opts: Options) {
	say(bold("Add a domain to Mail App\n"));
	const token = await getToken();
	const account = await pickAccount(token, opts, (id) => appInstalled(token, id));
	const main = await existingChoice(token, account.id);
	if (!main.domain) throw new Stop("Mail App is on its workers.dev address for now. Run npx @mrpwob/mail-app setup to give it a domain first.");
	const have = new Set([main.domain, ...(await readDomainsList(ctxFor(token, main))).domains.map((d) => d.name)]);

	let domain = opts.domain?.toLowerCase().replace(/\.$/, "");
	if (!domain) {
		const zones = await cf<{ name: string; status: string }[]>(token, `/zones?account.id=${account.id}&per_page=50`);
		if (!zones.ok) throw new Stop(`We couldn't list your domains. Your token needs "Zone: Read". ${details(zones)}`);
		const free = (zones.result ?? []).filter((z) => z.status === "active" && !have.has(z.name.toLowerCase()));
		if (!free.length) throw new Stop("Every domain on this Cloudflare account already gets its email in Mail App. Add the new domain to Cloudflare first, then run this again.");
		say(bold("Which domain should Mail App get email for?"));
		domain = free[await choose("Domain:", free, (z) => z.name)].name.toLowerCase();
	}
	if (have.has(domain)) say(dim(`${domain} is already in Mail App. Checking its email settings again.`));

	const choice: InstallChoice = { ...main, domain, moveMail: false };
	say(`\nAdding ${bold(domain)} to Mail App on ${bold(account.name)}.\n`);
	const { sending } = await runSteps(token, choice, opts, [
		{ id: "email", label: `Switching on email for ${domain}`, actions: ["email", "records"] },
		{ id: "sending", label: `Switching on sending for ${domain}`, actions: ["sending"] },
	]);
	try {
		await saveToDomainsList(ctxFor(token, choice), domain);
	} catch (e) {
		if (e instanceof InstallError) fail({ ok: false, message: e.message, detail: e.detail });
		throw e;
	}
	say(`${green("✓")} Added ${domain} to Mail App`);
	say();
	say(bold(`${domain} is ready.`));
	say(`  Make mailboxes for it on the Mailboxes page in Mail App, at https://${main.subdomain ?? WEB_SUBDOMAIN}.${main.domain}`);
	if (sending?.status === "plan") {
		say(yellow("! Sending to other people needs Cloudflare's Workers Paid plan ($5 a month). Receiving works now."));
	} else if (sending?.status === "failed") {
		say(yellow(`! We couldn't switch on sending for ${domain} yet. Mail App shows what to do in Settings.`));
		if (sending.detail) say(dim(`  Cloudflare said: ${sending.detail}`));
	}
}

async function main() {
	let opts: Options;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (e) {
		if (e instanceof UsageError) {
			say(red(e.message));
			process.exitCode = 2;
			return;
		}
		throw e;
	}
	try {
		if (opts.command === "version") say(CLI_VERSION);
		else if (opts.command === "help") say(`${HELP}\n${tokenHelp()}`);
		else if (opts.command === "setup") await setup(opts);
		else if (opts.command === "add-domain") await addDomain(opts);
		else await update(opts);
	} catch (e) {
		if (e instanceof Stop) {
			if (e.message) say(red(`\n${forTerminal(e.message)}`));
			process.exitCode = 1;
		} else {
			say(red(`\nSomething unexpected went wrong. Nothing is lost: please run the command again.\n${String((e as Error)?.stack ?? e)}`));
			process.exitCode = 1;
		}
	} finally {
		rl?.close();
	}
}

main();
