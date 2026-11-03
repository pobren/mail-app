// Run: node --experimental-strip-types --test site/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	maskEmail,
	signInHint,
	withSignInHint,
	accessApp,
	accessPolicy,
	accessTokenBody,
	accessTokenPermissions,
	signInEmails,
	assetUploadManifest,
	buildMetadata,
	catchAllRule,
	isActionId,
	r2DashboardUrl,
	r2NotEnabled,
	staleAccessApps,
	staleLinksApps,
	apiApp,
	apiPolicy,
	linksApp,
	linksPolicy,
	staleWorkerDomains,
	missingPermissions,
	PERMISSION_NAMES,
	parseChoice,
	planMigrations,
	planSteps,
	takeBuckets,
	teamDomainUrl,
	teamSlug,
	webHostname, forwardingRules, isAppCatchAll, mailElsewhere, mailProviderLabel, mailToMove, zoneOfHost } from "../deploy.ts";
import { buildManifest, contentTypeFor, isReleaseManifest, isWorkerModule, type BuiltWranglerConfig } from "../release.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

// The relevant parts of what `npm run build` writes to build/server/wrangler.json today.
const built: BuiltWranglerConfig = {
	main: "index.js",
	compatibility_date: "2025-11-28",
	compatibility_flags: ["nodejs_compat"],
	durable_objects: {
		bindings: [
			{ name: "MAILBOX", class_name: "MailboxDO" },
			{ name: "EMAIL_AGENT", class_name: "EmailAgent" },
			{ name: "EMAIL_MCP", class_name: "EmailMCP" },
		],
	},
	migrations: [
		{ tag: "v1", new_sqlite_classes: ["MailboxDO"] },
		{ tag: "v2", new_sqlite_classes: ["EmailAgent"] },
		{ tag: "v3", new_sqlite_classes: ["EmailMCP"] },
	],
	r2_buckets: [{ binding: "BUCKET" }],
	send_email: [{ name: "EMAIL" }],
	ai: { binding: "AI" },
};

const manifest = buildManifest({
	version: "2026.10.10-abc1234",
	builtAt: "2026-10-10T00:00:00.000Z",
	config: built,
	modules: ["index.js", "assets/worker-entry-x.js"],
	assets: [
		{ path: "/assets/root-x.css", hash: "a".repeat(32), size: 10 },
		{ path: "/favicon.ico", hash: "b".repeat(32), size: 20 },
	],
});

test("manifest: built from the wrangler.json output", () => {
	assert.ok(isReleaseManifest(manifest));
	assert.equal(manifest.worker.mainModule, "index.js");
	assert.deepEqual(manifest.worker.modules.map((m) => m.name), ["assets/worker-entry-x.js", "index.js"]);
	assert.ok(manifest.worker.modules.every((m) => m.contentType === "application/javascript+module"));
	assert.deepEqual(manifest.worker.durableObjects.map((d) => d.className), ["MailboxDO", "EmailAgent", "EmailMCP"]);
	assert.equal(manifest.worker.bucketBinding, "BUCKET");
	assert.deepEqual(manifest.worker.sendEmail, ["EMAIL"]);
	assert.equal(manifest.worker.ai, "AI");
	assert.deepEqual(manifest.assets.map((a) => a.contentType), ["text/css", "image/x-icon"]);
});

test("manifest: refuses broken input", () => {
	const base = { version: "1", builtAt: "", config: built, modules: ["index.js"], assets: [] };
	assert.throws(() => buildManifest({ ...base, version: "../evil" }));
	assert.throws(() => buildManifest({ ...base, modules: ["other.js"] }));
	assert.throws(() => buildManifest({ ...base, config: { ...built, r2_buckets: [] } }));
	assert.throws(() => buildManifest({ ...base, assets: [{ path: "x.js", hash: "a".repeat(32), size: 1 }] }));
	assert.throws(() => buildManifest({ ...base, assets: [{ path: "/x.js", hash: "nothex", size: 1 }] }));
	assert.equal(isReleaseManifest({ schema: 2 }), false);
});

test("release helpers", () => {
	assert.equal(contentTypeFor("/a/b.JS"), "application/javascript");
	assert.equal(contentTypeFor("/noext"), "application/null");
	assert.ok(isWorkerModule("assets/x.js"));
	assert.ok(!isWorkerModule("assets/x.css"));
	assert.ok(!isWorkerModule(".vite/manifest.json"));
});

test("choice: validates account and domain", () => {
	assert.deepEqual(parseChoice({ accountId: ACCOUNT, domain: "Example.co.uk." }), { accountId: ACCOUNT, domain: "example.co.uk", subdomain: "mail", moveMail: false });
	assert.deepEqual(parseChoice({ accountId: ACCOUNT, domain: "example.co.uk", subdomain: " WebMail " }), { accountId: ACCOUNT, domain: "example.co.uk", subdomain: "webmail", moveMail: false });
	assert.equal(parseChoice({ accountId: ACCOUNT, domain: "example.co.uk", subdomain: "a.b" }), null);
	assert.equal(parseChoice({ accountId: ACCOUNT, domain: "example.co.uk", subdomain: "-mail" }), null);
	assert.equal(parseChoice({ accountId: ACCOUNT, domain: "example.co.uk", subdomain: 5 }), null);
	assert.equal(parseChoice({ accountId: ACCOUNT, domain: "example.co.uk", moveMail: true })?.moveMail, true);
	assert.equal(parseChoice({ accountId: ACCOUNT, domain: "example.co.uk", moveMail: "yes" })?.moveMail, false);
	assert.equal(parseChoice({ accountId: ACCOUNT, domain: "example.co.uk", signInEmail: " Sam@Example.co.uk " })?.signInEmail, "sam@example.co.uk");
	assert.equal(parseChoice({ accountId: ACCOUNT, domain: null, signInEmail: "sam@example.co.uk" })?.signInEmail, "sam@example.co.uk");
	assert.equal(parseChoice({ accountId: ACCOUNT, domain: "example.co.uk", signInEmail: "not an email" }), null);
	assert.equal(parseChoice({ accountId: ACCOUNT, domain: "example.co.uk", signInEmail: "" })?.signInEmail, undefined);
	// A trial has no domain, so any subdomain is ignored.
	assert.deepEqual(parseChoice({ accountId: ACCOUNT, domain: null, subdomain: "webmail" }), { accountId: ACCOUNT, domain: null });
	assert.deepEqual(parseChoice({ accountId: ACCOUNT, domain: null }), { accountId: ACCOUNT, domain: null });
	assert.deepEqual(parseChoice({ accountId: ACCOUNT, domain: "" }), { accountId: ACCOUNT, domain: null });
	assert.equal(parseChoice({ accountId: "nope", domain: null }), null);
	assert.equal(parseChoice({ accountId: ACCOUNT, domain: "../zones" }), null);
	assert.equal(parseChoice({ accountId: ACCOUNT, domain: "a b.com" }), null);
	assert.equal(parseChoice(null), null);
	assert.ok(isActionId("access"));
	assert.ok(!isActionId("delete"));
});

test("plan: domain install has four steps, trial skips email", () => {
	const withDomain = planSteps({ accountId: ACCOUNT, domain: "yourdomain.co.uk" });
	assert.deepEqual(withDomain.map((s) => s.label), [
		"Creating storage",
		"Installing Mail App",
		"Switching on email for yourdomain.co.uk",
		"Setting up sign-in protection",
		"Switching on sending for yourdomain.co.uk",
	]);
	assert.deepEqual(withDomain.flatMap((s) => s.actions), ["storage", "assets", "worker", "address", "email", "records", "access", "sending"]);
	const trial = planSteps({ accountId: ACCOUNT, domain: null });
	assert.deepEqual(trial.map((s) => s.id), ["storage", "install", "protect"]);
});

test("hostname: <subdomain>.<domain> (mail by default), or workers.dev for a trial", () => {
	assert.equal(webHostname({ accountId: ACCOUNT, domain: "example.com" }), "mail.example.com");
	assert.equal(webHostname({ accountId: ACCOUNT, domain: "example.com", subdomain: "webmail" }), "webmail.example.com");
	assert.equal(webHostname({ accountId: ACCOUNT, domain: null }, "paul"), "mail-app.paul.workers.dev");
	assert.throws(() => webHostname({ accountId: ACCOUNT, domain: null }, null));
});

test("migrations: all for a new Worker, the rest for an older one, none when current", () => {
	const m = built.migrations!;
	assert.deepEqual(planMigrations(m, undefined), {
		new_tag: "v3",
		steps: [{ new_sqlite_classes: ["MailboxDO"] }, { new_sqlite_classes: ["EmailAgent"] }, { new_sqlite_classes: ["EmailMCP"] }],
	});
	assert.deepEqual(planMigrations(m, "v1"), {
		old_tag: "v1",
		new_tag: "v3",
		steps: [{ new_sqlite_classes: ["EmailAgent"] }, { new_sqlite_classes: ["EmailMCP"] }],
	});
	assert.equal(planMigrations(m, "v3"), undefined);
	assert.equal(planMigrations([], undefined), undefined);
	assert.equal(planMigrations(m, "zz")?.steps.length, 3);
});

test("metadata: bindings, vars, assets and migrations", () => {
	const meta = buildMetadata(manifest, { accountId: ACCOUNT, domain: "example.com" }, { assetsJwt: "JWT", currentMigrationTag: null });
	assert.equal(meta.main_module, "index.js");
	assert.equal(meta.compatibility_date, "2025-11-28");
	assert.deepEqual(meta.compatibility_flags, ["nodejs_compat"]);
	assert.deepEqual(meta.assets, { jwt: "JWT" });
	assert.deepEqual(meta.keep_bindings, ["secret_text"]);
	assert.equal(meta.migrations?.new_tag, "v3");
	assert.deepEqual(meta.bindings, [
		{ type: "r2_bucket", name: "BUCKET", bucket_name: "mail-app" },
		{ type: "durable_object_namespace", name: "MAILBOX", class_name: "MailboxDO" },
		{ type: "durable_object_namespace", name: "EMAIL_AGENT", class_name: "EmailAgent" },
		{ type: "durable_object_namespace", name: "EMAIL_MCP", class_name: "EmailMCP" },
		{ type: "send_email", name: "EMAIL" },
		{ type: "ai", name: "AI" },
		{ type: "plain_text", name: "DOMAINS", text: "example.com" },
		{ type: "json", name: "EMAIL_ADDRESSES", json: [] },
		{ type: "plain_text", name: "APP_VERSION", text: manifest.version },
	]);
	const again = buildMetadata(manifest, { accountId: ACCOUNT, domain: null }, { assetsJwt: "J", currentMigrationTag: "v3" });
	assert.equal(again.migrations, undefined);
	assert.deepEqual(again.bindings.find((b) => b.name === "DOMAINS"), { type: "plain_text", name: "DOMAINS", text: "" });
	// Never send secrets in metadata: they are set separately and kept.
	assert.ok(!JSON.stringify(meta).includes("POLICY_AUD"));
});

test("assets: upload-session body and batching", () => {
	assert.deepEqual(assetUploadManifest(manifest), {
		manifest: { "/assets/root-x.css": { hash: "a".repeat(32), size: 10 }, "/favicon.ico": { hash: "b".repeat(32), size: 20 } },
	});
	const buckets = [["a", "b"], [], ["c"], ["d", "e", "f"]];
	assert.deepEqual(takeBuckets(buckets, 3), { now: [["a", "b"], ["c"]], later: [["d", "e", "f"]] });
	assert.deepEqual(takeBuckets([["a", "b", "c", "d"]], 2), { now: [["a", "b", "c", "d"]], later: [] });
	assert.deepEqual(takeBuckets([], 5), { now: [], later: [] });
});

test("email routing and Access bodies", () => {
	assert.deepEqual(catchAllRule().actions, [{ type: "worker", value: ["mail-app"] }]);
	assert.deepEqual(catchAllRule().matchers, [{ type: "all" }]);
	assert.deepEqual(accessPolicy("me@example.com").include, [{ email: { email: "me@example.com" } }]);
	assert.equal(accessPolicy("me@example.com").decision, "allow");
	const app = accessApp("mail.example.com", "pol-1");
	assert.equal(app.type, "self_hosted");
	assert.equal(app.domain, "mail.example.com");
	assert.deepEqual(app.policies, [{ id: "pol-1", precedence: 1 }]);
	// Signed in for 30 days, so the app on the Dock or home screen doesn't ask every day.
	assert.equal(app.session_duration, "720h");
	assert.equal(accessPolicy("me@example.com").session_duration, "720h");
	assert.equal(teamSlug("Paul's Account!", "a1b2c3"), "paul-s-account-a1b2c3");
	assert.equal(teamSlug("", "a1b2c3"), "mail-a1b2c3");
	assert.equal(teamDomainUrl("team.cloudflareaccess.com/"), "https://team.cloudflareaccess.com");
});

test("download links: only /f/ skips sign-in", () => {
	const app = linksApp("mail.example.com", "pol-2");
	assert.equal(app.domain, "mail.example.com/f/*");
	assert.deepEqual(app.destinations, [{ type: "public", uri: "mail.example.com/f/*" }]);
	assert.deepEqual(app.policies, [{ id: "pol-2", precedence: 1 }]);
	assert.equal(linksPolicy().decision, "bypass");
	const apps = [
		{ id: "a", name: "Mail App: download links", domain: "mail.example.org.uk/f/*" },
		{ id: "b", name: "Mail App: download links", domain: "webmail.example.org.uk/f/*" },
		{ id: "c", name: "Mail App", domain: "mail.example.org.uk" },
		{ id: "d", name: "Mail App: download links", domain: "mail.other.com/f/*" },
	];
	assert.deepEqual(staleLinksApps(apps, "webmail.example.org.uk", "example.org.uk").map((a) => a.id), ["a"]);
});

test("API: only /api/ext/ skips sign-in", () => {
	const app = apiApp("mail.example.com", "pol-3");
	assert.equal(app.domain, "mail.example.com/api/ext/*");
	assert.equal(app.name, "Mail App: API");
	assert.deepEqual(app.policies, [{ id: "pol-3", precedence: 1 }]);
	assert.equal(apiPolicy().decision, "bypass");
	const apps = [
		{ id: "a", name: "Mail App: API", domain: "mail.example.org.uk/api/ext/*" },
		{ id: "b", name: "Mail App: API", domain: "webmail.example.org.uk/api/ext/*" },
		{ id: "c", name: "Mail App: download links", domain: "mail.example.org.uk/f/*" },
	];
	assert.deepEqual(staleLinksApps(apps, "webmail.example.org.uk", "example.org.uk", "Mail App: API").map((a) => a.id), ["a"]);
});

test("missingPermissions names only the scopes Cloudflare didn't grant", () => {
	const required = "dns.write zone.read  user-details.read";
	assert.deepEqual(missingPermissions(required, "zone.read dns.write user-details.read"), []);
	assert.deepEqual(missingPermissions(required, "zone.read"), ["DNS Write", "User Details Read"]);
	assert.deepEqual(missingPermissions("made-up.read", ""), ["made-up.read"]);
	// No scope in the token response: we can't tell, so don't block the install.
	assert.deepEqual(missingPermissions(required, undefined), []);
});

test("tidy-up: only Mail App's old web addresses on the chosen domain", () => {
	const domains = [
		{ id: "1", hostname: "mail.example.org.uk", service: "mail-app" },
		{ id: "2", hostname: "webmail.example.org.uk", service: "mail-app" },
		{ id: "3", hostname: "shop.example.org.uk", service: "my-shop" },
		{ id: "4", hostname: "mail.other.com", service: "mail-app" },
		{ id: "5", hostname: "a.b.example.org.uk", service: "mail-app" },
	];
	assert.deepEqual(staleWorkerDomains(domains, "webmail.example.org.uk", "example.org.uk").map((d) => d.id), ["1"]);
	assert.deepEqual(staleWorkerDomains(domains, "MAIL.example.org.uk", "example.org.uk").map((d) => d.id), ["2"]);

	const apps = [
		{ id: "a", name: "Mail App", domain: "mail.example.org.uk" },
		{ id: "b", name: "Mail App", domain: "webmail.example.org.uk" },
		{ id: "c", name: "Something else", domain: "mail.example.org.uk" },
		{ id: "d", name: "Mail App", domain: "mail.other.com" },
		{ id: "e", name: "Mail App" },
	];
	assert.deepEqual(staleAccessApps(apps, "webmail.example.org.uk", "example.org.uk").map((a) => a.id), ["a"]);
});

test("update notice: only a genuinely newer Mail App release counts", async () => {
	const { isNewerVersion } = await import("../../shared/version.ts");
	assert.equal(isNewerVersion("1.2", "1.1"), true);
	assert.equal(isNewerVersion("2.0", "1.9"), true);
	assert.equal(isNewerVersion("1.10", "1.9"), true);
	assert.equal(isNewerVersion("1.1", "1.1"), false);
	assert.equal(isNewerVersion("1.1", "1.2"), false);
	assert.equal(isNewerVersion("1.1.1", "1.1"), true);
	// Installs from before numbering were dated builds; any numbered release is newer.
	assert.equal(isNewerVersion("1.1", "2026.10.10-b8cf1f4"), true);
	assert.equal(isNewerVersion("2026.10.11-abc1234", "2026.10.10-b8cf1f4"), true);
	assert.equal(isNewerVersion("2026.10.10-b8cf1f4", "1.1"), false);
	assert.equal(isNewerVersion("nonsense", "1.1"), false);
	assert.equal(isNewerVersion("1.2", undefined), false);
});

test("team access: the sign-in rule follows Mail App's People list, and never locks anyone out", () => {
	const include = [{ email: { email: "me@example.com" } }, { email: { email: "anna@gmail.com" } }];
	const people = { people: [
		{ email: "me@example.com", status: "active" },
		{ email: "Sam@Gmail.com", status: "invited" },
		{ email: "anna@gmail.com", status: "suspended" },
		{ email: "nonsense" },
	] };
	assert.deepEqual(signInEmails(people, include), ["me@example.com", "sam@gmail.com"]);
	assert.deepEqual(signInEmails(null, include), ["me@example.com", "anna@gmail.com"], "no list yet: keep who's there");
	assert.deepEqual(signInEmails({ people: [] }, undefined), []);
	// The owner is always let in, whatever the list says.
	assert.deepEqual(accessPolicy("me@example.com", ["sam@gmail.com", "ME@example.com"]).include, [{ email: { email: "me@example.com" } }, { email: { email: "sam@gmail.com" } }]);
});

test("team access: the sign-in list token only reaches this account's Access settings", () => {
	const groups = [
		{ id: "a", name: "Access: Apps and Policies Write" },
		{ id: "b", name: "Access: Organizations, Identity Providers, and Groups Write" },
		{ id: "c", name: "Workers Scripts Write" },
	];
	assert.deepEqual(accessTokenPermissions(groups)?.map((g) => g.id), ["a", "b"]);
	assert.equal(accessTokenPermissions(groups.slice(1)), null);
	const body = accessTokenBody(ACCOUNT, accessTokenPermissions(groups)!);
	assert.deepEqual(Object.keys(body.policies[0].resources), [`com.cloudflare.api.account.${ACCOUNT}`]);
	assert.equal(body.policies[0].permission_groups.length, 2);
});

test("the automatic sign-in rule always lets the owner in and asks Mail App about everyone else", async () => {
	const { accessPolicyWithCheck, checkApp, checkPath } = await import("../deploy.ts");
	const rule = accessPolicyWithCheck("Owner@Example.com", "mail.example.com");
	assert.deepEqual(rule.include[0], { email: { email: "owner@example.com" } });
	assert.deepEqual(rule.include[1], { external_evaluation: { evaluate_url: "https://mail.example.com/access-check/evaluate", keys_url: "https://mail.example.com/access-check/keys" } });
	assert.equal(rule.decision, "allow");
	assert.equal(checkPath("mail.example.com"), "mail.example.com/access-check/*");
	assert.equal(checkApp("mail.example.com", "p1").policies[0].id, "p1");
});

test("the sign-in rule also lets in the address the person chose to sign in with", async () => {
	const { accessPolicyWithCheck } = await import("../deploy.ts");
	const rule = accessPolicyWithCheck("old@fidget.example", "mail.example.com", ["Sam@Shop.example", "old@fidget.example"]);
	assert.equal(rule.name, "Mail App: only old@fidget.example");
	assert.deepEqual(rule.include.slice(0, 2), [{ email: { email: "old@fidget.example" } }, { email: { email: "sam@shop.example" } }]);
	assert.equal(rule.include.length, 3);
	assert.deepEqual(accessPolicy("old@fidget.example", ["sam@shop.example"]).include, [{ email: { email: "old@fidget.example" } }, { email: { email: "sam@shop.example" } }]);
});

test("adding domains: who handles a domain's email now", () => {
	assert.equal(mailElsewhere([]), null);
	assert.equal(mailElsewhere(["route1.mx.cloudflare.net", "72 route2.mx.cloudflare.net."]), null);
	assert.equal(mailElsewhere(["1 aspmx.l.google.com.", "5 alt1.aspmx.l.google.com."]), "Google");
	assert.equal(mailElsewhere(["0 app-com.mail.protection.outlook.com"]), "Microsoft");
	assert.equal(mailElsewhere(["10 mx.example.net"]), "another service");
});

test("adding domains: forwarding rules and the Mail App catch-all", () => {
	const rules = [
		{ enabled: true, matchers: [{ type: "literal", field: "to", value: "Hello@example.net" }], actions: [{ type: "forward", value: ["paul@example.com"] }] },
		{ enabled: false, matchers: [{ type: "literal", field: "to", value: "old@example.net" }], actions: [{ type: "forward", value: ["x@y.z"] }] },
		{ enabled: true, matchers: [{ type: "literal", field: "to", value: "bin@example.net" }], actions: [{ type: "drop" }] },
	];
	assert.deepEqual(forwardingRules(rules), [{ address: "hello@example.net", to: ["paul@example.com"] }]);
	assert.equal(isAppCatchAll(catchAllRule()), true);
	assert.equal(isAppCatchAll({ actions: [{ type: "drop" }] }), false);
});

test("adding domains: the zone an install's web address is on", () => {
	assert.equal(zoneOfHost("mail.example.com", ["example.net", "example.com"]), "example.com");
	assert.equal(zoneOfHost("mail.eu.example.com", ["example.com", "eu.example.com"]), "eu.example.com");
	assert.equal(zoneOfHost("mail-app.paul.workers.dev", ["example.com"]), null);
});

test("r2NotEnabled spots Cloudflare's 'switch R2 on first' answer", () => {
	assert.equal(r2NotEnabled([{ code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." }]), true);
	assert.equal(r2NotEnabled([{ code: 0, message: "Please enable R2 through the Cloudflare Dashboard." }]), true);
	assert.equal(r2NotEnabled([{ code: 10000, message: "Authentication error" }]), false);
	assert.equal(r2NotEnabled([]), false);
});

test("r2DashboardUrl opens R2 on the person's own account", () => {
	assert.equal(r2DashboardUrl(ACCOUNT), `https://dash.cloudflare.com/${ACCOUNT}/r2/overview`);
});

test("mailProviderLabel names the service people will recognise", () => {
	assert.equal(mailProviderLabel(["mx2.krystal.io", "mx1.krystal.io"]), "krystal.io");
	assert.equal(mailProviderLabel(["10 mx.example.co.uk."]), "example.co.uk");
	assert.equal(mailProviderLabel(["aspmx.l.google.com"]), "Google");
});

test("mailToMove picks only the old service's MX and SPF on the domain itself", () => {
	const recs = [
		{ id: "1", type: "MX", name: "example.uk", content: "mx1.krystal.io" },
		{ id: "2", type: "MX", name: "example.uk", content: "route1.mx.cloudflare.net" },
		{ id: "3", type: "TXT", name: "example.uk", content: '"v=spf1 include:spf.krystal.io ~all"' },
		{ id: "4", type: "TXT", name: "example.uk", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
		{ id: "5", type: "TXT", name: "example.uk", content: "google-site-verification=abc" },
		{ id: "6", type: "MX", name: "shop.example.uk", content: "mx1.krystal.io" },
		{ id: "7", type: "A", name: "example.uk", content: "192.0.2.1" },
	];
	assert.deepEqual(mailToMove(recs, "example.uk").map((r) => r.id), ["1", "3"]);
});

test("maskEmail hides most of the name", () => {
	assert.equal(maskEmail("Sam@Example.co.uk"), "s•••@example.co.uk");
	assert.equal(maskEmail("nope"), "");
});

test("withSignInHint adds the hint, keeps other settings, and never replaces someone's own text", () => {
	const org = { name: "x", auth_domain: "x.cloudflareaccess.com", created_at: "t", login_design: { background_color: "#fff" } };
	assert.deepEqual(withSignInHint(org, "owner@example.com"), {
		name: "x",
		auth_domain: "x.cloudflareaccess.com",
		login_design: { background_color: "#fff", header_text: signInHint("owner@example.com") },
	});
	assert.equal(withSignInHint({ login_design: { header_text: "Welcome to Acme" } }, "a@b.com"), null);
	assert.equal(withSignInHint({ login_design: { header_text: signInHint("a@b.com") } }, "a@b.com"), null);
	assert.ok(withSignInHint({ login_design: { header_text: signInHint("a@b.com") } }, "c@d.com"));
	assert.match(signInHint("a@b.com"), /a•••@b\.com/);
});

test("parseChoice keeps a backup sign-in address only next to a different sign-in address", () => {
	const id = "0123456789abcdef0123456789abcdef";
	assert.deepEqual(parseChoice({ accountId: id, domain: null, signInEmail: "a@b.com", backupEmail: " C@D.com " }), {
		accountId: id, domain: null, signInEmail: "a@b.com", backupEmail: "c@d.com",
	});
	assert.deepEqual(parseChoice({ accountId: id, domain: null, signInEmail: "a@b.com", backupEmail: "a@b.com" }), { accountId: id, domain: null, signInEmail: "a@b.com" });
	assert.deepEqual(parseChoice({ accountId: id, domain: null, backupEmail: "c@d.com" }), { accountId: id, domain: null });
	assert.equal(parseChoice({ accountId: id, domain: null, signInEmail: "a@b.com", backupEmail: "nope" }), null);
});

test("passkey sign-in: an open /passkey/ path and a Passkey option on Cloudflare's sign-in page", async () => {
	const { passkeyApp, passkeyIdp, passkeyIdpName, ourPasskeyIdp, passkeyPolicy, newClientSecret } = await import("../deploy.ts");
	const app = passkeyApp("mail.example.com", "pol1");
	assert.equal(app.domain, "mail.example.com/passkey/*");
	assert.deepEqual(app.policies, [{ id: "pol1", precedence: 1 }]);
	assert.equal(passkeyPolicy().decision, "bypass");
	const idp = passkeyIdp("mail.example.com", "sec");
	assert.equal(idp.type, "oidc");
	assert.equal(idp.config.auth_url, "https://mail.example.com/passkey/authorize");
	assert.equal(idp.config.token_url, "https://mail.example.com/passkey/token");
	assert.equal(idp.config.certs_url, "https://mail.example.com/passkey/keys");
	assert.equal(idp.config.client_secret, "sec");
	const ours = { id: "1", name: "Passkey", type: "oidc", config: { auth_url: "https://mail.example.com/passkey/authorize" } };
	const other = { id: "2", name: "Passkey", type: "oidc", config: { auth_url: "https://mail.other.com/passkey/authorize" } };
	assert.equal(ourPasskeyIdp([other, ours], "mail.example.com"), ours);
	assert.equal(ourPasskeyIdp([other], "mail.example.com"), undefined);
	assert.equal(passkeyIdpName([ours], "mail.example.com"), "Passkey");
	assert.equal(passkeyIdpName([other], "mail.example.com"), "Passkey (mail.example.com)");
	assert.equal(passkeyIdpName([], "mail.example.com"), "Passkey");
	assert.match(newClientSecret(), /^[0-9a-f]{64}$/);
	assert.notEqual(newClientSecret(), newClientSecret());
});

test("home screen icons: the icon files open without signing in, nothing else", async () => {
	const { iconsApp, iconsPolicy, iconPaths, staleLinksApps, ICONS_APP_NAME } = await import("../deploy.ts");
	const app = iconsApp("mail.example.com", "pol1");
	assert.equal(app.domain, "mail.example.com/apple-touch-icon.png");
	assert.deepEqual(app.destinations.map((d) => d.uri), iconPaths("mail.example.com"));
	assert.ok(iconPaths("mail.example.com").every((p) => !p.includes("*")));
	assert.ok(iconPaths("mail.example.com").includes("mail.example.com/apple-touch-icon-precomposed.png"));
	// Every path is a real file in Mail App's public/ folder.
	const { existsSync } = await import("node:fs");
	for (const p of iconPaths("x")) assert.ok(existsSync(new URL(`../../public/${p.slice(2)}`, import.meta.url)), p);
	assert.deepEqual(app.policies, [{ id: "pol1", precedence: 1 }]);
	assert.equal(iconsPolicy().decision, "bypass");
	const old = { name: ICONS_APP_NAME, domain: "old.example.com/apple-touch-icon.png" };
	assert.deepEqual(staleLinksApps([old, { ...old, domain: app.domain }], "mail.example.com", "example.com", ICONS_APP_NAME), [old]);
});
