// Run: node --experimental-strip-types --test site/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageError, forTerminal, isNewer, parseArgs, subdomainOf, tokenHelp } from "../core.ts";

test("parseArgs reads commands and options", () => {
	assert.equal(parseArgs([]).command, "help");
	assert.equal(parseArgs(["install"]).command, "setup");
	assert.deepEqual(parseArgs(["setup", "--domain", "example.com", "--subdomain=post", "--email", "me@example.com", "-y"]), {
		command: "setup", domain: "example.com", subdomain: "post", email: "me@example.com", yes: true, force: false,
	});
	assert.equal(parseArgs(["setup", "--trial"]).domain, "");
	assert.equal(parseArgs(["update", "--force"]).force, true);
	assert.equal(parseArgs(["update", "--help"]).command, "help");
});

test("parseArgs refuses unknown commands, bad options and tokens on the command line", () => {
	assert.throws(() => parseArgs(["deploy"]), UsageError);
	assert.throws(() => parseArgs(["setup", "--colour"]), UsageError);
	assert.throws(() => parseArgs(["setup", "--domain"]), UsageError);
	assert.throws(() => parseArgs(["setup", "--domain", "--yes"]), UsageError);
	assert.throws(() => parseArgs(["setup", "--token", "abc"]), /shell history/);
	assert.throws(() => parseArgs(["setup", "--token=abc"]), /shell history/);
});

test("forTerminal turns web installer advice into terminal advice", () => {
	assert.equal(
		forTerminal("We couldn't create storage. Cloudflare says Mail App doesn't have permission. Please sign out, sign in again and allow everything on Cloudflare's page."),
		"We couldn't create storage. Cloudflare says Mail App doesn't have permission. Your API token is missing a permission. Check it has everything listed by npx @mrpwob/mail-app help, then run the command again.",
	);
	assert.match(forTerminal("Open R2 and switch it on. Then come back here and press Try again."), /Then run the command again\.$/);
	assert.equal(forTerminal("Please check your connection and try again."), "Please check your connection and run the command again.");
	assert.equal(forTerminal("mail.x.com is already in use on your domain. Remove its DNS record in Cloudflare, or tell us, then try again."), "mail.x.com is already in use on your domain. Remove its DNS record in Cloudflare, then run the command again.");
	assert.doesNotMatch(forTerminal("We couldn't find x.com on this Cloudflare account. Please pick it again."), /pick it again/);
});

test("subdomainOf splits a web address from its domain", () => {
	assert.equal(subdomainOf("mail.example.com", "example.com"), "mail");
	assert.equal(subdomainOf("Mail.Example.co.uk", "example.co.uk"), "mail");
	assert.equal(subdomainOf("example.com", "example.com"), null);
	assert.equal(subdomainOf("a.b.example.com", "example.com"), null);
	assert.equal(subdomainOf("mail.notexample.com", "example.com"), null);
});

test("isNewer compares release numbers", () => {
	assert.equal(isNewer("1.56", "1.55"), true);
	assert.equal(isNewer("1.100", "1.99"), true);
	assert.equal(isNewer("1.56", "1.56"), false);
	assert.equal(isNewer("1.55", "1.56"), false);
	assert.equal(isNewer("2.0", "1.99"), true);
	assert.equal(isNewer("1.56", null), true);
	assert.equal(isNewer("1.56", "2026.10.10-b8cf1f4"), true);
});

test("tokenHelp lists every permission", () => {
	const help = tokenHelp();
	for (const name of ["Workers: Admin", "Workers R2 Storage: Edit", "DNS: Edit", "Email Routing Rules: Edit", "User Details: Read"]) assert.ok(help.includes(name), name);
});
