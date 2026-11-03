// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: the agent route refuses mailboxes that have AI switched off; sign-in problems show a plain-English page; /f/ download links and /f/cal/ calendar subscribe links open without signing in; incoming mail passes its delivery address on; team access (each person signs in as themselves and only reaches their own mailboxes); the API at /api/ext/v1/, for other apps with an API key; passkey sign-in at /passkey/.

import { routeAgentRequest } from "agents";
import { type Context, Hono, type Next } from "hono";
import { ACCESS_CHECK_PATH, handleAccessCheck } from "./lib/access-check";
import { handlePasskey } from "./lib/passkeys";
import { PASSKEY_PATH } from "../shared/passkeys";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import { aiEnabledFor } from "./lib/ai-setting";
import { publicLinks } from "./lib/links";
import { publicFeeds } from "./lib/calendar-feeds";
import { admit, devViewer, type PeopleVars } from "./lib/people";
import { admitApiRequest } from "./lib/api";
import { keyFromHeaders } from "../shared/api";
import { canOpen, isAdmin, type Person } from "../shared/people";
import { sameSite } from "./lib/same-site";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env; Variables: PeopleVars }>();

/**
 * Mail App: requests made with an API key, rewritten to the app's own /api/v1 routes, and who each one
 * runs as. Only this file can add to it, so nothing a caller sends can claim to be one.
 */
const keyRequests = new WeakMap<Request, Person>();

// Mail App: changes (and the AI chat's live connection) only come from this app's own pages, so another
// website can't make a signed-in person's browser send, delete or change anything. Apps using an API key
// aren't browsers on another site and are let through. Pages also can't be shown inside another website.
app.use("*", async (c, next) => {
	const url = new URL(c.req.url);
	const changes = !["GET", "HEAD", "OPTIONS"].includes(c.req.method) && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/ext/");
	const live = url.pathname.startsWith("/agents/") && c.req.header("Upgrade")?.toLowerCase() === "websocket";
	if ((changes || live) && !keyRequests.has(c.req.raw) && !sameSite(c.req.header("Origin"), url)) {
		return c.text("This request came from another website, so it was refused.", 403);
	}
	await next();
	if (c.res.status === 101 || !(c.res.headers.get("content-type") ?? "").startsWith("text/html")) return;
	c.res = new Response(c.res.body, c.res);
	c.res.headers.set("X-Frame-Options", "SAMEORIGIN");
	if (!c.res.headers.has("Content-Security-Policy")) c.res.headers.set("Content-Security-Policy", "frame-ancestors 'self'");
	c.res.headers.set("X-Content-Type-Options", "nosniff");
	c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
});

// Cloudflare Access JWT validation middleware (production only)
app.use("*", async (c, next) => {
	// Skip validation in development. Mail App: you're signed in as owner@example.com, or as whoever the
	// dev-as header or cookie names, so team access can be tried locally.
	// Mail App: Cloudflare Access asking whether someone may sign in (a Cloudflare Access bypass rule exempts this path; see the README).
	if (new URL(c.req.url).pathname.startsWith(`${ACCESS_CHECK_PATH}/`)) return handleAccessCheck(c.req.raw, c.env);
	// Mail App: passkey sign-in, which Cloudflare's sign-in page sends people to (a Cloudflare Access bypass rule exempts this path; see the README).
	if (new URL(c.req.url).pathname.startsWith(`${PASSKEY_PATH}/`)) return handlePasskey(c.req.raw, c.env);

	// Mail App: the API. a Cloudflare Access bypass rule exempts /api/ext/ from sign-in (see the README), so every request
	// there needs a valid API key, and runs as that key: only its mailboxes, only what it may do.
	const asKey = keyRequests.get(c.req.raw);
	if (asKey) {
		c.set("viewer", asKey.email);
		c.set("person", asKey);
		return next();
	}
	if (new URL(c.req.url).pathname.startsWith("/api/ext/")) {
		const admitted = await admitApiRequest(c.req.raw, c.env, c.executionCtx as ExecutionContext, keyFromHeaders(c.req.raw.headers), import.meta.env.DEV);
		if (admitted instanceof Response) return admitted;
		keyRequests.set(admitted.request, admitted.person);
		const res = await app.fetch(admitted.request, c.env, c.executionCtx as ExecutionContext);
		const out = new Response(res.body, res);
		out.headers.set("cache-control", "no-store");
		return out;
	}

	if (import.meta.env.DEV) {
		if (new URL(c.req.url).pathname.startsWith("/f/")) return next();
		return letIn(c, devViewer(c.req.raw), next);
	}

	// Mail App: download links are for people who can't sign in. a Cloudflare Access bypass rule exempts only /f/ from
	// sign-in (see the README); these routes serve nothing but encrypted files to visitors holding a link's secret.
	if (new URL(c.req.url).pathname.startsWith("/f/")) {
		return next();
	}

	const { POLICY_AUD, TEAM_DOMAIN } = c.env;

	// Fail closed in production if Access is not configured.
	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.text(
			"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
			500,
		);
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		return signInProblem(c.req.path, "Missing required CF Access JWT");
	}

	let email = "";
	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const JWKS = createRemoteJWKSet(certsUrl);
		const { payload } = await jwtVerify(token, JWKS, {
			issuer,
			audience: POLICY_AUD,
		});
		email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
	} catch {
		return signInProblem(c.req.path, "Invalid or expired Access token");
	}
	if (!email) return signInProblem(c.req.path, "No email address in the Access token");

	// Mail App: Cloudflare Access only says who someone is. The people list says what they can open.
	return letIn(c, email, next);
});

/** Mail App: checks a signed-in address against the people list, then carries on as that person. */
async function letIn(c: Context<{ Bindings: Env; Variables: PeopleVars }>, email: string, next: Next) {
	const admission = await admit(c.env, email, c.executionCtx as ExecutionContext);
	if (!admission.ok) return noAccess(c.req.path, email, admission.reason);
	c.set("viewer", email);
	c.set("person", admission.person);
	return next();
}

/** Mail App: someone Cloudflare let in who isn't (or is no longer) on this install's people list. */
function noAccess(path: string, email: string, reason: "not-invited" | "suspended"): Response {
	const text = reason === "suspended"
		? "Your access to this Mail App has been paused. Please ask the person who runs it."
		: "This Mail App hasn't been shared with you. Please ask the person who runs it to invite you.";
	if (path.startsWith("/api/") || path.startsWith("/mcp") || path.startsWith("/agents/")) {
		return new Response(text, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
	}
	const safe = email.replace(/[<>&"]/g, "");
	const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mail App: no access</title>
<style>body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:#eef1f1;color:#12262b}main{max-width:34rem;margin:12vh auto;padding:0 20px}h1{font-size:1.5rem;margin:16px 0 8px}p{color:#4d6066}a{color:#c8102e;font-weight:600}</style></head>
<body><main><svg width="34" height="34" viewBox="0 0 30 30" aria-hidden="true"><rect x="1" y="5" width="28" height="20" rx="4" fill="#c8102e"/><path d="M5 10l10 7 10-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
<h1>${reason === "suspended" ? "Your access is paused" : "No access yet"}</h1>
<p>${text}</p>
<p>You're signed in as ${safe}. <a href="/cdn-cgi/access/logout">Sign out</a> to try a different address.</p></main></body></html>`;
	return new Response(html, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/**
 * Mail App: what people see when a request arrives without a valid Cloudflare sign-in. API callers get
 * the original short text; browsers get a page that says what to do. Usually it means the sign-in
 * protection for a new web address is still switching on (it can take a minute or two).
 */
function signInProblem(path: string, reason: string): Response {
	if (path.startsWith("/api/") || path.startsWith("/mcp") || path.startsWith("/agents/")) {
		return new Response(reason, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
	}
	const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mail App: please sign in</title>
<style>body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:#eef1f1;color:#12262b}main{max-width:34rem;margin:12vh auto;padding:0 20px}h1{font-size:1.5rem;margin:16px 0 8px}p{color:#4d6066}a{color:#c8102e;font-weight:600}code{font-size:.8rem;color:#7f9095}</style></head>
<body><main><svg width="34" height="34" viewBox="0 0 30 30" aria-hidden="true"><rect x="1" y="5" width="28" height="20" rx="4" fill="#c8102e"/><path d="M5 10l10 7 10-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
<h1>Sign-in isn't ready yet</h1>
<p>Mail App only opens after Cloudflare has checked it's you. If you've just installed it or changed its web address, Cloudflare can take a minute or two to switch sign-in on.</p>
<p>Please wait a moment, then <a href="/">try again</a>. If it keeps happening, check the Cloudflare Access steps in the <a href="https://github.com/pobren/mail-app#cloudflare-access">README</a>.</p>
<p><code>${reason}</code></p></main></body></html>`;
	return new Response(html, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
// Mail App: the MCP tools can reach every mailbox, so only an admin may use them.
app.use("/mcp/*", async (c, next) => (isAdmin(c.var.person) ? next() : c.text("Only an admin can use the MCP tools.", 403)));
app.use("/mcp", async (c, next) => (isAdmin(c.var.person) ? next() : c.text("Only an admin can use the MCP tools.", 403)));
app.all("/mcp", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mail App: calendar subscribe links and download links (the only routes open without signing in;
// see the middleware above).
app.route("/f/cal", publicFeeds);
app.route("/f", publicLinks);

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	// Mail App: the agent only answers for mailboxes that have AI switched on.
	// Mail App: only the email assistant answers here, not the app's other internal objects.
	const parts = new URL(c.req.url).pathname.split("/");
	if (parts[2] !== "email-agent") return c.text("Not found", 404);
	let mailboxId = "";
	try {
		mailboxId = decodeURIComponent(parts[3] ?? "");
	} catch {
		return c.text("Not found", 404);
	}
	// Mail App: and only for people who can open that mailbox.
	if (!mailboxId || !canOpen(c.var.person, mailboxId)) return c.text("Not found", 404);
	if (!(await aiEnabledFor(c.env.BUCKET, mailboxId))) {
		return c.text("AI is switched off for this mailbox. Turn it on in Settings.", 403);
	}
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		event: { raw: ReadableStream; rawSize: number; to: string; setReject?: (reason: string) => void; forward?: (rcptTo: string, headers?: Headers) => Promise<void> },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
