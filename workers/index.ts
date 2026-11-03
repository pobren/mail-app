// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: added the /api/v1/setup/status route; new mail only goes to the AI agent when AI is switched on; new mailboxes get a welcome email; /api/v1/update says when a newer Mail App release is out; spam filtering and a block list; attachments; download links for big files; out-of-office replies; contacts; incoming mail goes by its real delivery address; private picture fetching; labels; replies join the conversation they answer; contact import; extra addresses (aliases), a catch-all and sending from either; team access (people only see their own mailboxes; admins manage people, mailboxes and addresses); /api/v1/sending tells admins whether the install can send to anyone; inbox rules; automatic spam checks; the calendar; masked email (an address for each website, sent back once it's off or has ended). The API and webhooks: events when mail arrives or is sent, and Admin > API & webhooks. Admin > Backups. Calendar invites: answers to ours are noted, changes to ones we accepted are taken in. Files (private storage); Notes; a deleted mailbox's files go with it. Passkeys in Settings. Snooze, "Remind me if no reply" and the company details footer. Calendar sharing. Scheduled send. Admin > Branding and Reports (and the daily tally Reports reads, and Find an email). A stronger spam filter: SpamAssassin's rules, learning from Spam and Not spam, and an optional AI check (Admin > Spam filter).

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { messageTooLarge, storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";
import { requireAdmin, updatePeople, loadPeople, loadPlan, sentBy } from "./lib/people";
import { people as peopleRoutes } from "./routes/people";
import { passkeys as passkeyRoutes } from "./routes/passkeys";
import { domains as domainRoutes } from "./routes/domains";
import { calendar as calendarRoutes } from "./routes/calendar";
import { calendarShares, forgetCalendarShares } from "./routes/calendar-shares";
import { deleteMailboxFiles, files as fileRoutes } from "./routes/files";
import { notes as noteRoutes } from "./routes/notes";
import { createMailbox } from "./lib/new-mailbox";
import { MAX_PEOPLE, canOpen, findPerson, isAdmin, isShared, openable, setMailboxPeople, usersOf, withPerson } from "shared/people";
import { setupStatus } from "./lib/setup-checks";
import { checkSending, loadSending, sendNowOrExplain } from "./lib/sending";
import { BAD_SEND_AT, scheduleEmail, sendAtOf } from "./lib/scheduled-send";
import { scheduled as scheduledRoutes } from "./routes/scheduled";
import { PLAN_URL, checkDue } from "shared/sending";
import { aiEnabledFor, forgetAiChat } from "./lib/ai-setting";
import { isAiEnabled } from "../shared/ai";
import { sendAutoReply } from "./lib/auto-reply";
import { cleanSenderName, isValidContactEmail } from "shared/contacts";
import { cleanLabelName, isLabelColor, nextLabelColor, MAX_LABELS } from "shared/labels";
import { recipientCandidates } from "shared/recipients";
import { DELIVERED_TO_HEADER, aliasProblem, aliasesOf, catchAllDomains, withoutMailboxes, normaliseAddress } from "shared/addresses";
import { installDomains, loadAddressBook, loadDomainsFile, saveAddressBook, saveDomainsFile } from "./lib/addresses";
import { loadMasked, saveMasked, sendableFor } from "./lib/masked";
import { MASKED_LEAK_HEADER, maskedDomainsOf, maskedOf, maskedProblem, maskedWithoutMailboxes, newMaskedAddress, recordMaskedMail, routeIncoming, siteFromLabel, type MaskedAddress } from "shared/masked";
import { addEntry, isValidSenderEntry, removeEntry, senderMatches, spamReason, type SpamSettings } from "shared/spam";
import { SPAM_REASON_HEADER, SPAM_THRESHOLD, plainText, reasonHeaderValue, siteOf, spamChecks, spamScore, type StoredReason } from "shared/spam-checks";
import { learntFinding, tokensFor } from "shared/spam-learning";
import { cleanSpamFilterSettings, spamAiPoints } from "shared/spam-ai";
import { aiChecksToday, aiSpamCheck, loadSpamFilter, saveSpamFilter } from "./lib/spam-ai";
import { domainAgeDays } from "./lib/domain-age";
import { applyRules, cleanRules, type InboxRule } from "shared/rules";
import { cleanForwarding, forwardingProblem, shouldForward, FORWARDED_HEADER } from "shared/forwarding";
import { forwardEmail, loadForwardingStatus } from "./lib/forwarding";
import { importMessages } from "./lib/import";
import { addDevice, listDevices, notifyDevices, publicKey as pushPublicKey, removeDevice } from "./lib/push";
import { systemFolderFor } from "../shared/mbox-import";
import { deleteLink, linksAvailable, listLinks, storeLink } from "./lib/links";
import { emitEvent } from "./lib/api";
import { takeInIncomingInvite } from "./lib/invites";
import { developer as developerRoutes } from "./routes/developer";
import { adminBackups } from "./routes/admin-backups";
import { countRecipients } from "./lib/send-limit";
import { addCompanyFooter, loadCompany, saveCompany } from "./lib/company";
import { cleanCompany } from "shared/company";
import { MAX_LOGO_BYTES, brandManifest, cleanBranding } from "shared/branding";
import { MIN_FIND, cleanFind, dayList, mergeFound, reportDays, type FindAnswer, type FoundEmail, type MailboxReport, type ReportsAnswer, type SpamWhy } from "shared/reports";
import { loadBranding, logoResponse, removeLogo, saveBranding, saveLogo } from "./lib/branding";
import baseManifest from "../public/manifest.webmanifest?raw";
import { validDueAt } from "shared/reminders";
import { CHANGES_URL, LATEST_RELEASE_URL, SENDING_HELP_URL, UPDATE_URL, isNewerVersion, isNumberedVersion } from "shared/version";
import changelog from "shared/changelog.json";

/** The version this copy was built from: the newest entry in shared/changelog.json. */
const APP_VERSION = changelog.releases[0].version;

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.string(), z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
	// Mail App: who will use it (their sign-in address). Missing means the admin creating it.
	forPerson: z.string().optional(),
	// Mail App: a shared mailbox (a team address like sales@), and who else on the People list gets it.
	shared: z.boolean().optional(),
	people: z.array(z.string()).max(MAX_PEOPLE).optional(),
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
	// Mail App: which of the mailbox's addresses the draft is from.
	from: z.string().optional(),
	// Mail App: drafts keep their attachments.
	attachments: z.array(z.object({
		content: z.string(), // base64 encoded
		filename: z.string(),
		type: z.string(),
		disposition: z.enum(["attachment", "inline"]),
		contentId: z.string().optional(),
	})).optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
// Mail App: every answer says which build of Mail App sent it, so an app window that's been open since
// before an update can tell, and reload itself (app/lib/new-version.ts).
app.use("/api/*", async (c, next) => {
	await next();
	c.header("App-Build", __APP_BUILD__);
});
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", async (c) => {
	// Mail App: with any domains added on the Mailboxes page, so a new mailbox can be at any of them.
	const file = await loadDomainsFile(c.env.BUCKET);
	const configured = (c.env.DOMAINS || "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
	const domains = [...new Set([...configured, ...file.domains.map((d) => d.name)])];
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	return c.json({ domains, emailAddresses, downloadLinks: linksAvailable(c.env, import.meta.env.DEV) });
});

// -- Updates (added for Mail App) -------------------------------------

// Reads the newest release number from the code on GitHub, at most about once a day (Cloudflare caches
// the answer). The request comes from Cloudflare's servers, not the person's browser, and sends nothing
// about them. If GitHub can't be reached, the app simply shows no update notice.
app.get("/api/v1/update", async (c) => {
	const raw = APP_VERSION;
	// Only numbered versions ("1.1") are shown to people; older dated builds show none.
	const current = isNumberedVersion(raw) ? raw : undefined;
	try {
		const res = await fetch(LATEST_RELEASE_URL, {
			cf: { cacheTtl: 86400, cacheEverything: true },
			signal: AbortSignal.timeout(3000),
		});
		const info = res.ok ? ((await res.json()) as { releases?: { version?: unknown }[] }) : {};
		const latest = info.releases?.[0]?.version;
		const available = isNewerVersion(latest, raw);
		return c.json({ available, current, latest: available ? latest : undefined, url: UPDATE_URL, changesUrl: CHANGES_URL });
	} catch {
		return c.json({ available: false, current, changesUrl: CHANGES_URL });
	}
});

// -- Setup (added for Mail App) ---------------------------------------

app.get("/api/v1/setup/status", async (c) => {
	const mailboxes = (await listMailboxes(c.env.BUCKET)).map((m) => m.email);
	return c.json(await setupStatus(c.env, import.meta.env.DEV, mailboxes));
});

// -- Ready to send (added for Mail App) ---------------------------------

// Whether this install can send email to anyone, for the admin card. When it isn't known to work,
// a sending check runs now and then by itself (at most every 10 minutes), so the card goes away on
// its own once the plan or domain is sorted. "Check again" runs one straight away.
async function sendingAnswer(c: AppContext, force: boolean) {
	let status = await loadSending(c.env.BUCKET);
	const all = (await listMailboxes(c.env.BUCKET)).map((m) => m.email.toLowerCase());
	const mine = openable(c.var.person).find((m) => all.includes(m));
	const from = mine ?? all[0];
	const due = force ? !status.checkedAt || Date.now() - Date.parse(status.checkedAt) >= 15_000 : checkDue(status, Date.now());
	if (from && due) status = await checkSending(c.env, from);
	const domain = (status.from ?? from ?? "").split("@")[1] || null;
	return c.json({ ...status, domain, planUrl: PLAN_URL, installerUrl: SENDING_HELP_URL });
}

// Mail App: the company details footer (Admin > Company details).
app.get("/api/v1/company", requireAdmin, async (c) => c.json(await loadCompany(c.env.BUCKET)));
app.put("/api/v1/company", requireAdmin, async (c) => {
	const details = cleanCompany(await c.req.json().catch(() => null));
	await saveCompany(c.env.BUCKET, details);
	return c.json(details);
});

// Mail App: Admin > Branding. Everyone signed in sees it; only admins change it.
app.get("/api/v1/branding", async (c) => c.json(await loadBranding(c.env.BUCKET)));
app.put("/api/v1/branding", requireAdmin, async (c) => {
	const current = await loadBranding(c.env.BUCKET);
	const next = cleanBranding({ ...current, ...((await c.req.json().catch(() => null)) ?? {}), logo: current.logo });
	await saveBranding(c.env.BUCKET, next);
	return c.json(next);
});
app.put("/api/v1/branding/logo", requireAdmin, async (c) => {
	const size = (name: string) => Math.max(0, Math.floor(Number(c.req.query(name)) || 0));
	if (Number(c.req.header("content-length") ?? 0) > MAX_LOGO_BYTES) return c.json({ error: "That logo is over 200 KB. Please use a smaller file." }, 400);
	const bytes = new Uint8Array(await c.req.arrayBuffer());
	const result = await saveLogo(c.env.BUCKET, bytes, { width: size("width"), height: size("height") });
	return "error" in result ? c.json(result, 400) : c.json(result);
});
app.delete("/api/v1/branding/logo", requireAdmin, async (c) => c.json(await removeLogo(c.env.BUCKET)));
app.get("/api/v1/branding/logo", (c) => logoResponse(c.env.BUCKET));
app.get("/api/v1/branding/manifest", async (c) => {
	const manifest = brandManifest(JSON.parse(baseManifest), await loadBranding(c.env.BUCKET));
	return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/manifest+json", "cache-control": "no-cache" } });
});

// Mail App: Admin > Reports. Each mailbox's tally and storage, read now (one request per mailbox), and who
// has signed in and opened what, from the people list.
app.get("/api/v1/reports", requireAdmin, async (c) => {
	const days = reportDays(c.req.query("days"));
	const list = dayList(days);
	const from = list[0]!;
	const [mailboxes, { book }] = await Promise.all([listMailboxes(c.env.BUCKET), loadPeople(c.env.BUCKET)]);
	const unreadable: string[] = [];
	const reports = await Promise.all(mailboxes.map(async (m): Promise<MailboxReport | null> => {
		try {
			const counts = await (c.env.MAILBOX.get(c.env.MAILBOX.idFromName(m.id)) as any).mailReport(from);
			return { mailbox: m.email, shared: isShared(book, m.email), ...counts };
		} catch {
			unreadable.push(m.email);
			return null;
		}
	}));
	const answer: ReportsAnswer = {
		days, from, to: list[list.length - 1]!,
		mailboxes: reports.filter((r): r is MailboxReport => !!r).sort((a, b) => a.mailbox.localeCompare(b.mailbox)),
		unreadable,
		people: book.people.map((p) => ({ email: p.email, name: p.name, role: p.role, status: p.status, lastSeenAt: p.lastSeenAt ?? null, invitedAt: p.invitedAt })),
		log: book.log.filter((l) => l.at.slice(0, 10) >= from).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200),
	};
	return c.json(answer);
});

// Mail App: Reports > Find an email. Searches every mailbox for an address or subject and says what happened
// to each email (delivered, Spam and why, Bin, sent, couldn't send). Only who, when and the subject come
// back, never the message itself; opening one goes through the mailbox like anywhere else.
app.get("/api/v1/reports/find", requireAdmin, async (c) => {
	const q = cleanFind(c.req.query("q"));
	const days = reportDays(c.req.query("days"));
	if (q.length < MIN_FIND) return c.json({ error: `Type at least ${MIN_FIND} letters.` }, 400);
	const from = dayList(days)[0]!;
	const unreadable: string[] = [];
	const [all, { book }] = await Promise.all([listMailboxes(c.env.BUCKET), loadPeople(c.env.BUCKET)]);
	const lists = await Promise.all(all.map(async (m): Promise<FoundEmail[]> => {
		try {
			return await (c.env.MAILBOX.get(c.env.MAILBOX.idFromName(m.id)) as any).findMail(q, from, m.email);
		} catch {
			unreadable.push(m.email);
			return [];
		}
	}));
	const merged = mergeFound(lists);
	// Opening a mailbox that isn't the admin's goes through the same logged step as on Mailboxes.
	const mailboxes: FindAnswer["mailboxes"] = {};
	for (const m of all) if (merged.found.some((f) => f.mailbox === m.email)) {
		mailboxes[m.email] = { id: m.id, canOpen: canOpen(c.var.person, m.email), people: usersOf(book, m.email).map((p) => p.name || p.email) };
	}
	const answer: FindAnswer = { q, days, ...merged, unreadable, mailboxes };
	return c.json(answer);
});

// Mail App: Admin > Spam filter: the optional AI check and its daily limit (workers/lib/spam-ai.ts).
async function spamFilterAnswer(bucket: R2Bucket) {
	return { settings: await loadSpamFilter(bucket), checksToday: await aiChecksToday(bucket) };
}
app.get("/api/v1/spam-filter", requireAdmin, async (c) => c.json(await spamFilterAnswer(c.env.BUCKET)));
app.put("/api/v1/spam-filter", requireAdmin, async (c) => {
	await saveSpamFilter(c.env.BUCKET, cleanSpamFilterSettings(await c.req.json().catch(() => null)));
	return c.json(await spamFilterAnswer(c.env.BUCKET));
});

app.get("/api/v1/sending", requireAdmin, (c) => sendingAnswer(c as unknown as AppContext, false));
app.post("/api/v1/sending/check", requireAdmin, (c) => sendingAnswer(c as unknown as AppContext, true));

// -- Mailboxes ------------------------------------------------------

// Mail App: each person sees the mailboxes they can open. An admin sees every mailbox, with who uses it,
// but can only open their own (or ones they've given themselves access to, which is logged).
app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	const person = c.var.person;
	const { book } = await loadPeople(c.env.BUCKET);
	if (!isAdmin(person)) {
		const mine = new Set(openable(person));
		return c.json(allMailboxes.filter((m) => mine.has(m.email.toLowerCase())).map((m) => ({ ...m, name: m.id, canOpen: true, shared: isShared(book, m.email) })));
	}
	return c.json(allMailboxes.map((m) => ({
		...m,
		name: m.id,
		canOpen: canOpen(person, m.email),
		shared: isShared(book, m.email),
		people: usersOf(book, m.email).map((p) => ({ email: p.email, name: p.name })),
	})));
});

app.post("/api/v1/mailboxes", requireAdmin, async (c) => {
	const { name, settings, email, forPerson, shared, people } = CreateMailboxBody.parse(await c.req.json());
	const owner = forPerson || c.var.person.email;
	// Mail App: check a shared mailbox can be made before making anything.
	if (shared || people?.length) {
		const problem = setMailboxPeople((await loadPeople(c.env.BUCKET)).book, await loadPlan(c.env), email, [owner, ...(people ?? [])], !!shared, c.var.person.email, new Date().toISOString());
		if (typeof problem === "string") return c.json({ error: problem }, 400);
	}
	// Mail App: made for someone on the People list (the admin making it, unless they say otherwise).
	const made = await createMailbox(c.env, new URL(c.req.url).origin, { email, name, settings, owner });
	if (!made.ok) return c.json({ error: made.error }, made.status);
	if (shared || people?.length) {
		const plan = await loadPlan(c.env);
		await updatePeople(c.env.BUCKET, (b) =>
			setMailboxPeople(b, plan, made.mailbox.email, [owner, ...(people ?? [])], !!shared, c.var.person.email, new Date().toISOString()));
	}
	return c.json(made.mailbox, 201);
});

// Mail App: who uses a mailbox, and whether it's shared, chosen on the Mailboxes page.
const MailboxPeopleBody = z.object({ people: z.array(z.string()).max(MAX_PEOPLE), shared: z.boolean() });

app.put("/api/v1/mailboxes/:mailboxId/people", requireAdmin, async (c) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase();
	if (!(await c.env.BUCKET.head(`mailboxes/${mailboxId}.json`))) return c.json({ error: "Not found" }, 404);
	const { people, shared } = MailboxPeopleBody.parse(await c.req.json());
	const plan = await loadPlan(c.env);
	const saved = await updatePeople(c.env.BUCKET, (b) => setMailboxPeople(b, plan, mailboxId, people, shared, c.var.person.email, new Date().toISOString()));
	if (typeof saved === "string") return c.json({ error: saved }, 400);
	return c.json({ shared: isShared(saved, mailboxId), people: usersOf(saved, mailboxId).map((p) => ({ email: p.email, name: p.name })) });
});

// Mail App: only people who can open a mailbox can read or change its settings.
app.on(["GET", "PUT"], "/api/v1/mailboxes/:mailboxId", async (c, next) => {
	if (!canOpen(c.var.person, c.req.param("mailboxId")!)) return c.json({ error: "Not found" }, 404);
	await next();
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	// Mail App: an open mailbox has its nightly backup booked (see workers/durableObject/backup.ts).
	c.executionCtx.waitUntil(c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId)).rememberMailbox(mailboxId).catch(() => {}));
	// Mail App: shared = two or more people use it, so their emails are signed with their own name.
	const { book } = await loadPeople(c.env.BUCKET);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json(), shared: isShared(book, mailboxId) });
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	const before = await c.env.BUCKET.get(key);
	if (!before) return c.json({ error: "Not found" }, 404);
	const wasAiOn = isAiEnabled(await before.json<{ aiEnabled?: unknown }>().catch(() => null));
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	// Mail App: switching the AI assistant off deletes its chat history too.
	if (wasAiOn && !isAiEnabled(settings)) await forgetAiChat(c.env, mailboxId);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", requireAdmin, async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.delete(key); // TODO: also delete DO data and R2 attachment blobs
	// Mail App: and the AI assistant's chat history.
	await forgetAiChat(c.env, mailboxId);
	// Mail App: its files go with it.
	await deleteMailboxFiles(c.env, mailboxId);
	// Mail App: its calendars are no longer shared with anyone.
	await forgetCalendarShares(c.env, mailboxId);
	// Mail App: its extra addresses and catch-all go with it, so they can be used again.
	const book = await loadAddressBook(c.env.BUCKET);
	const id = mailboxId.toLowerCase();
	if (catchAllDomains(book, id).length || book.aliases.some((a) => a.mailbox === id)) {
		await saveAddressBook(c.env.BUCKET, withoutMailboxes(book, [id]));
	}
	// Mail App: and its masked email. Its masked addresses go too, so mail to them is no longer taken in.
	const masked = await loadMasked(c.env.BUCKET);
	if (maskedDomainsOf(masked, id).length || maskedOf(masked, id).length) await saveMasked(c.env.BUCKET, maskedWithoutMailboxes(masked, [id]));
	// Mail App: and nobody has it any more.
	await updatePeople(c.env.BUCKET, (b) => ({
		...b,
		people: b.people.map((p) => ({ ...p, mailboxes: p.mailboxes.filter((m) => m !== id), adminAccess: p.adminAccess.filter((m) => m !== id) })),
		shared: (b.shared ?? []).filter((m) => m !== id),
	}));
	return c.body(null, 204);
});

// -- Extra addresses (added for Mail App) -----------------------------

// The mailbox's extra addresses, the domains it catches mail for every other address at (and which
// mailbox does for the rest), and the domains an address can be at.
async function addressesFor(env: Env, mailboxId: string) {
	const [book, masked] = await Promise.all([loadAddressBook(env.BUCKET), loadMasked(env.BUCKET)]);
	const { mailboxes, domains } = await installDomains(env);
	const id = mailboxId.toLowerCase();
	return { book, masked, mailboxes, domains, view: {
		aliases: aliasesOf(book, id),
		catchAll: domains.map((domain) => ({ domain, mailbox: book.catchAll[domain] ?? null })),
		// Mail App: which mailbox gets masked email at each domain.
		masked: domains.map((domain) => ({ domain, mailbox: masked.domains[domain] ?? null })),
		domains,
	} };
}

const AliasBody = z.object({ address: z.string().optional(), name: z.string().optional(), signature: z.string().optional() });

// Every mailbox's extra addresses and the catch-all, for the Mailboxes page.
app.get("/api/v1/addresses", requireAdmin, async (c: AppContext) => {
	const book = await loadAddressBook(c.env.BUCKET);
	const { domains } = await installDomains(c.env);
	return c.json({ aliases: book.aliases, catchAll: book.catchAll, domains });
});

app.get("/api/v1/mailboxes/:mailboxId/addresses", async (c: AppContext) => {
	return c.json((await addressesFor(c.env, c.req.param("mailboxId")!)).view);
});

// Mail App: only an admin adds or removes addresses, so nobody can take an address that isn't theirs.
app.post("/api/v1/mailboxes/:mailboxId/addresses", requireAdmin, async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase();
	const { address = "", name, signature } = AliasBody.parse(await c.req.json());
	const { book, masked, mailboxes, domains } = await addressesFor(c.env, mailboxId);
	const problem = aliasProblem(address, mailboxId, book, mailboxes, domains)
		?? (masked.addresses.some((m) => m.address === normaliseAddress(address)) ? "That address is already a masked address." : null);
	if (problem) return c.json({ error: problem }, 400);
	book.aliases.push({ address: normaliseAddress(address), mailbox: mailboxId, name, signature });
	await saveAddressBook(c.env.BUCKET, book);
	return c.json((await addressesFor(c.env, mailboxId)).view, 201);
});

app.put("/api/v1/mailboxes/:mailboxId/addresses/:address", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase();
	const address = normaliseAddress(c.req.param("address")!);
	const { name, signature } = AliasBody.parse(await c.req.json());
	const book = await loadAddressBook(c.env.BUCKET);
	const alias = book.aliases.find((a) => a.address === address && a.mailbox === mailboxId);
	if (!alias) return c.json({ error: "Not found" }, 404);
	if (name !== undefined) alias.name = name;
	if (signature !== undefined) alias.signature = signature;
	await saveAddressBook(c.env.BUCKET, book);
	return c.json((await addressesFor(c.env, mailboxId)).view);
});

app.delete("/api/v1/mailboxes/:mailboxId/addresses/:address", requireAdmin, async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase();
	const address = normaliseAddress(c.req.param("address")!);
	const book = await loadAddressBook(c.env.BUCKET);
	const kept = book.aliases.filter((a) => !(a.address === address && a.mailbox === mailboxId));
	if (kept.length === book.aliases.length) return c.json({ error: "Not found" }, 404);
	await saveAddressBook(c.env.BUCKET, { ...book, aliases: kept });
	return c.json((await addressesFor(c.env, mailboxId)).view);
});

// Each domain has at most one catch-all: switching it on here moves it from any other mailbox.
app.put("/api/v1/mailboxes/:mailboxId/catch-all", requireAdmin, async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase();
	const { on, domain: asked } = z.object({ on: z.boolean(), domain: z.string().optional() }).parse(await c.req.json());
	const { book, domains } = await addressesFor(c.env, mailboxId);
	// Without a domain (older app windows), the mailbox's own domain.
	const domain = (asked ?? mailboxId.split("@")[1] ?? "").toLowerCase();
	if (!domains.includes(domain)) return c.json({ error: `${domain} isn't one of your domains.` }, 400);
	if (on) book.catchAll[domain] = mailboxId;
	else if (book.catchAll[domain] === mailboxId) delete book.catchAll[domain];
	await saveAddressBook(c.env.BUCKET, book);
	// A domain has a catch-all or masked email, not both.
	const masked = await loadMasked(c.env.BUCKET);
	if (on && masked.domains[domain]) { delete masked.domains[domain]; await saveMasked(c.env.BUCKET, masked); }
	return c.json((await addressesFor(c.env, mailboxId)).view);
});

// -- Masked email (added for Mail App) ---------------------------------

// The admin picks the one mailbox that gets masked email at a domain. It replaces any catch-all there.
app.put("/api/v1/mailboxes/:mailboxId/masked-domain", requireAdmin, async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase();
	const { on, domain: asked } = z.object({ on: z.boolean(), domain: z.string() }).parse(await c.req.json());
	const { book, masked, domains } = await addressesFor(c.env, mailboxId);
	const domain = asked.toLowerCase();
	if (!domains.includes(domain)) return c.json({ error: `${domain} isn't one of your domains.` }, 400);
	if (on) {
		masked.domains[domain] = mailboxId;
		if (book.catchAll[domain]) { delete book.catchAll[domain]; await saveAddressBook(c.env.BUCKET, book); }
	} else if (masked.domains[domain] === mailboxId) delete masked.domains[domain];
	await saveMasked(c.env.BUCKET, masked);
	return c.json((await addressesFor(c.env, mailboxId)).view);
});

async function maskedView(env: Env, mailboxId: string) {
	const masked = await loadMasked(env.BUCKET);
	const id = mailboxId.toLowerCase();
	// Newest first, with any waiting for Keep or Block at the top.
	const addresses = maskedOf(masked, id).sort((a, b) => (a.status === "waiting" ? 0 : 1) - (b.status === "waiting" ? 0 : 1) || b.created.localeCompare(a.created));
	return { addresses, domains: maskedDomainsOf(masked, id) };
}

// The mailbox's masked addresses, and the domains it has masked email at. Its own user manages them.
app.get("/api/v1/mailboxes/:mailboxId/masked", async (c: AppContext) => c.json(await maskedView(c.env, c.req.param("mailboxId")!)));

const MaskedBody = z.object({
	label: z.string().max(200).optional(),
	domain: z.string().optional(),
	expires: z.string().nullable().optional(),
	once: z.boolean().optional(),
	status: z.enum(["on", "off"]).optional(),
	/** "It's from them": stop warning about email from this website. */
	trustSite: z.string().optional(),
});

app.post("/api/v1/mailboxes/:mailboxId/masked", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase();
	const body = MaskedBody.parse(await c.req.json());
	const [masked, book, { mailboxes }] = await Promise.all([loadMasked(c.env.BUCKET), loadAddressBook(c.env.BUCKET), installDomains(c.env)]);
	const domain = (body.domain ?? maskedDomainsOf(masked, mailboxId)[0] ?? "").toLowerCase();
	if (!domain || masked.domains[domain] !== mailboxId) return c.json({ error: "Masked email isn't switched on for this mailbox yet. Ask your admin to switch it on for a domain on the Mailboxes page." }, 400);
	let address: string;
	try {
		address = newMaskedAddress(domain, body.label, (a) => maskedProblem(a, mailboxId, masked, book, mailboxes) !== null);
	} catch (e) {
		return c.json({ error: (e as Error).message }, 409);
	}
	const site = siteFromLabel(body.label);
	const label = body.label?.trim();
	const entry: MaskedAddress = {
		address, mailbox: mailboxId, ...(label ? { label } : {}), sites: site ? [site] : [], status: "on",
		created: new Date().toISOString(), count: 0,
		...(body.expires && !Number.isNaN(Date.parse(body.expires)) ? { expires: new Date(body.expires).toISOString() } : {}),
		...(body.once ? { once: true } : {}),
	};
	await saveMasked(c.env.BUCKET, { ...masked, addresses: [...masked.addresses, entry] });
	return c.json({ ...(await maskedView(c.env, mailboxId)), created: address }, 201);
});

// Keep or Block a waiting one, switch one off or on again, change its end date or label, or trust a website.
app.put("/api/v1/mailboxes/:mailboxId/masked/:address", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase();
	const address = normaliseAddress(c.req.param("address")!);
	const body = MaskedBody.parse(await c.req.json());
	const masked = await loadMasked(c.env.BUCKET);
	const m = masked.addresses.find((a) => a.address === address && a.mailbox === mailboxId);
	if (!m) return c.json({ error: "Not found" }, 404);
	if (body.status) m.status = body.status;
	if (body.label !== undefined) {
		const label = body.label.trim();
		if (label) m.label = label; else delete m.label;
	}
	if (body.expires !== undefined) {
		if (body.expires && !Number.isNaN(Date.parse(body.expires))) m.expires = new Date(body.expires).toISOString(); else delete m.expires;
	}
	if (body.once !== undefined) {
		if (body.once) m.once = true; else delete m.once;
		// Switching "after its first email" on for one that's had mail ends it from the next email.
		if (body.once && m.count > 0) m.count = 0;
	}
	if (body.trustSite) {
		const site = body.trustSite.toLowerCase();
		if (!m.sites.includes(site)) m.sites.push(site);
		if (m.leak === site) delete m.leak;
	}
	await saveMasked(c.env.BUCKET, masked);
	return c.json(await maskedView(c.env, mailboxId));
});

// -- Team access (added for Mail App) ---------------------------------

app.route("/", peopleRoutes);

// -- Domains (added for Mail App) ---------------------------------------

app.route("/", domainRoutes);
app.route("/", calendarRoutes);
app.route("/", calendarShares);
// Mail App: Files.
app.route("/", fileRoutes);
// Mail App: Notes.
app.route("/", noteRoutes);
// Mail App: scheduled send.
app.route("/", scheduledRoutes);
// Mail App: Admin > API & webhooks.
app.route("/", developerRoutes);
app.route("/", adminBackups);
// Mail App: Settings > Account > Passkeys.
app.route("/", passkeyRoutes);

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	// Mail App: a label's page lists the conversations with that label, from any folder.
	const label = c.req.query("label");
	if (label) {
		const emails = await (stub as any).getLabelledEmails(label, page, limit);
		const totalCount = await (stub as any).countLabelledEmails(label);
		return c.json({ emails, totalCount });
	}
	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, attachments, in_reply_to, references, thread_id, remind_at } = body;
	// Mail App: scheduled send.
	const sendAt = sendAtOf(body.send_at);
	if (sendAt === "bad") return c.json({ error: BAD_SEND_AT }, 400);
	// Mail App: the company details footer.
	const { html, text } = await addCompanyFooter(c.env.BUCKET, { html: body.html, text: body.text });

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId, await sendableFor(c.env.BUCKET, mailboxId)));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const tooLarge = messageTooLarge(attachments, html, text);
	if (tooLarge) return c.json({ error: tooLarge }, 413);

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = sendAt ? null : await (stub as any).checkSendRateLimit(countRecipients(to, cc, bcc));
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(sendAt ? Folders.SCHEDULED : Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		...(await sentBy(c.env, c.var.person, mailboxId)),
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, attachmentData);

	const params = {
		to, cc, bcc, from, subject, html, text,
		attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment" as const, contentId: att.contentId })),
		...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
	};
	const event = {
		id: messageId, thread_id: thread_id || in_reply_to || messageId, folder: Folders.SENT, subject, from: fromEmail, to: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		has_attachments: !!attachments?.some((a) => a.disposition !== "inline"),
	};
	// Mail App: scheduled send: it waits in Scheduled, and the mailbox's alarm sends it.
	if (sendAt) {
		await scheduleEmail(c.env, stub, mailboxId, messageId, sendAt, {
			params, recipients: countRecipients(to, cc, bcc), event, remindAfterMs: validDueAt(remind_at) ? remind_at - Date.now() : null,
		});
		return c.json({ id: messageId, status: "scheduled", send_at: sendAt }, 202);
	}
	// Mail App: wait for Cloudflare's answer, so a refusal shows in the composer rather than the email
	// sitting in Sent without ever arriving.
	const refused = await sendNowOrExplain(c.env, stub, messageId, params);
	if (refused) return c.json({ error: refused }, 502);
	if (validDueAt(remind_at)) await stub.remindIfNoReply(messageId, remind_at);
	// Mail App: tell webhooks it went (see workers/lib/api.ts).
	emitEvent(c.env, c.executionCtx as ExecutionContext, "email.sent", mailboxId, { ...event, date: new Date().toISOString() });
	return c.json({ id: messageId, status: "sent" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id, attachments, from } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	const mine = await sendableFor(c.env.BUCKET, mailboxId);
	const sender = from && mine.includes(normaliseAddress(from)) ? normaliseAddress(from) : mailboxId.toLowerCase();
	if (draft_id) {
		// not atomic — create-then-delete would be safer
		const old = await stub.deleteEmail(draft_id);
		if (old?.length) await c.env.BUCKET.delete(old.map((att: any) => `attachments/${draft_id}/${att.id}/${att.filename}`));
	}
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender,
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, attachmentData);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await c.var.mailboxStub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

// Mail App: pictures in emails are fetched here, through your own Cloudflare account, so the sender
// never sees your IP address, location or device. Tracking pictures are removed before this.
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
app.get("/api/v1/image", async (c) => {
	const u = c.req.query("u") ?? "";
	let target: URL;
	try { target = new URL(u); } catch { return c.text("Bad address", 400); }
	if (target.protocol !== "https:" && target.protocol !== "http:") return c.text("Bad address", 400);
	let res: Response;
	try {
		res = await fetch(target.toString(), {
			headers: { "User-Agent": "Mozilla/5.0 (compatible; Mail App image proxy)", Accept: "image/*" },
			redirect: "follow",
			cf: { cacheTtl: 86400, cacheEverything: true },
		});
	} catch { return c.text("Couldn't fetch the picture", 502); }
	const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
	if (!res.ok || !type.startsWith("image/")) return c.text("Not a picture", 404);
	if (Number(res.headers.get("content-length") ?? 0) > IMAGE_MAX_BYTES) return c.text("Picture too big", 413);
	const body = await res.arrayBuffer();
	if (body.byteLength > IMAGE_MAX_BYTES) return c.text("Picture too big", 413);
	return new Response(body, { headers: {
		"Content-Type": type,
		"Cache-Control": "private, max-age=86400",
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
	} });
});

// Mail App: contacts. Everyone you've emailed, plus saved details, kept in the mailbox's database.
const ContactBody = z.object({ name: z.string().max(200).default(""), notes: z.string().max(2000).default("") });

app.get("/api/v1/mailboxes/:mailboxId/contacts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	// Adding people from your emails can be switched off in Settings; missing means on.
	const settings = (await (await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`))?.json()) as { autoContacts?: boolean } | undefined;
	return c.json(await c.var.mailboxStub.getContacts(mailboxId, settings?.autoContacts !== false));
});

// Mail App: contact import. The page reads the file and sends the people in it; anyone already saved is skipped.
const ImportBody = z.object({
	contacts: z.array(z.object({ email: z.string().max(254), name: z.string().max(200).default(""), notes: z.string().max(2000).default("") })).max(1000),
});

app.post("/api/v1/mailboxes/:mailboxId/contacts/import", async (c: AppContext) => {
	const self = c.req.param("mailboxId")!.toLowerCase();
	const { contacts } = ImportBody.parse(await c.req.json());
	const valid = contacts
		.map((p) => ({ email: p.email.trim().toLowerCase(), name: p.name.trim(), notes: p.notes.trim() }))
		.filter((p) => p.email !== self && isValidContactEmail(p.email));
	return c.json({ added: await c.var.mailboxStub.importContacts(valid) });
});

app.put("/api/v1/mailboxes/:mailboxId/contacts/:email", async (c: AppContext) => {
	const email = decodeURIComponent(c.req.param("email") ?? "").trim().toLowerCase();
	if (!isValidContactEmail(email)) return c.json({ error: "That doesn't look like an email address." }, 400);
	const { name, notes } = ContactBody.parse(await c.req.json());
	await c.var.mailboxStub.saveContact(email, name.trim(), notes.trim());
	return c.body(null, 204);
});

app.delete("/api/v1/mailboxes/:mailboxId/contacts/:email", async (c: AppContext) => {
	await c.var.mailboxStub.removeContact(decodeURIComponent(c.req.param("email") ?? "").trim().toLowerCase());
	return c.body(null, 204);
});

// Mail App: labels. Kept in the mailbox's database; a label goes on a whole conversation.
const LabelBody = z.object({ name: z.string().max(200).optional(), color: z.string().max(20).optional() });
const LabelChanges = z.object({
	add: z.array(z.string().max(100)).max(MAX_LABELS).default([]),
	remove: z.array(z.string().max(100)).max(MAX_LABELS).default([]),
});

app.get("/api/v1/mailboxes/:mailboxId/labels", async (c: AppContext) => c.json(await c.var.mailboxStub.getLabels()));

app.post("/api/v1/mailboxes/:mailboxId/labels", async (c: AppContext) => {
	const body = LabelBody.parse(await c.req.json());
	const name = cleanLabelName(body.name);
	if (!name) return c.json({ error: "Give the label a name." }, 400);
	const stub = c.var.mailboxStub;
	const color = isLabelColor(body.color) ? body.color : nextLabelColor(await stub.getLabels());
	const label = await stub.createLabel(name, color);
	if (label === "taken") return c.json({ error: "You already have a label with that name." }, 409);
	if (label === "full") return c.json({ error: `You can have up to ${MAX_LABELS} labels.` }, 400);
	return c.json(label, 201);
});

// Registered before /labels/:id so "order" isn't taken for a label id.
app.put("/api/v1/mailboxes/:mailboxId/labels/order", async (c: AppContext) => {
	const { ids } = z.object({ ids: z.array(z.string().max(100)).max(MAX_LABELS) }).parse(await c.req.json());
	await (c.var.mailboxStub as any).reorderLabels(ids);
	return c.body(null, 204);
});

app.put("/api/v1/mailboxes/:mailboxId/labels/:id", async (c: AppContext) => {
	const body = LabelBody.parse(await c.req.json());
	const name = body.name === undefined ? undefined : cleanLabelName(body.name);
	if (name === "") return c.json({ error: "Give the label a name." }, 400);
	if (body.color !== undefined && !isLabelColor(body.color)) return c.json({ error: "Pick one of the colours." }, 400);
	const label = await c.var.mailboxStub.updateLabel(c.req.param("id")!, { name, color: body.color as never });
	if (label === "taken") return c.json({ error: "You already have a label with that name." }, 409);
	return label ? c.json(label) : c.json({ error: "Label not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/labels/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteLabel(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Label not found" }, 404);
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id/labels", async (c: AppContext) => {
	const { add, remove } = LabelChanges.parse(await c.req.json());
	const labels = await c.var.mailboxStub.setConversationLabels(c.req.param("id")!, add, remove);
	return labels ? c.json({ labels }) : c.json({ error: "Email not found" }, 404);
});

/** A score this high is spam beyond doubt, so the mailbox learns from it without being told. */
const SURE_SPAM_SCORE = 10;

// Mail App: block list and "Not spam" (and inbox rules, below). They live in the mailbox's settings file in R2.
async function updateSpamLists(bucket: R2Bucket, mailboxId: string, change: (s: SpamSettings) => SpamSettings & { rules?: InboxRule[] }) {
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await bucket.get(key);
	if (!obj) return null;
	const settings = (await obj.json()) as Record<string, unknown> & SpamSettings;
	const next = { ...settings, ...change(settings) };
	await bucket.put(key, JSON.stringify(next));
	return next;
}

const SpamBody = z.object({ sender: z.string().max(254), emailId: z.string().max(100).optional() });

app.post("/api/v1/mailboxes/:mailboxId/spam/block", async (c: AppContext) => {
	const { sender, emailId } = SpamBody.parse(await c.req.json());
	if (!isValidSenderEntry(sender)) return c.json({ error: "That doesn't look like an email address or domain." }, 400);
	const settings = await updateSpamLists(c.env.BUCKET, c.req.param("mailboxId")!, (s) => ({
		blockedSenders: addEntry(s.blockedSenders, sender),
		safeSenders: removeEntry(s.safeSenders, sender),
	}));
	if (!settings) return c.json({ error: "Not found" }, 404);
	if (emailId) await c.var.mailboxStub.moveEmail(emailId, Folders.SPAM);
	return c.json({ settings });
});

app.post("/api/v1/mailboxes/:mailboxId/spam/not-spam", async (c: AppContext) => {
	const { sender, emailId } = SpamBody.parse(await c.req.json());
	const domain = sender.split("@")[1] ?? "";
	const settings = await updateSpamLists(c.env.BUCKET, c.req.param("mailboxId")!, (s) => ({
		blockedSenders: removeEntry(removeEntry(s.blockedSenders, sender), domain),
		safeSenders: isValidSenderEntry(sender) ? addEntry(s.safeSenders, sender) : s.safeSenders,
	}));
	if (!settings) return c.json({ error: "Not found" }, 404);
	if (emailId) await c.var.mailboxStub.moveEmail(emailId, Folders.INBOX);
	// Mail App: Admin > Reports counts "Not spam" presses.
	await (c.var.mailboxStub as any).countMail(["not-spam"]).catch(() => {});
	return c.json({ settings });
});

// Mail App: how much this mailbox has learnt from Spam and Not spam (Settings > Spam).
app.get("/api/v1/mailboxes/:mailboxId/spam/learning", async (c: AppContext) => {
	return c.json(await c.var.mailboxStub.spamLearningSummary());
});

app.post("/api/v1/mailboxes/:mailboxId/spam/unblock", async (c: AppContext) => {
	const { sender } = SpamBody.parse(await c.req.json());
	const settings = await updateSpamLists(c.env.BUCKET, c.req.param("mailboxId")!, (s) => ({
		blockedSenders: removeEntry(s.blockedSenders, sender),
	}));
	if (!settings) return c.json({ error: "Not found" }, 404);
	return c.json({ settings });
});

// Mail App: inbox rules. Kept in the mailbox's settings file in R2, saved as a whole list (order matters).
app.put("/api/v1/mailboxes/:mailboxId/rules", async (c: AppContext) => {
	const { rules } = z.object({ rules: z.array(z.unknown()).max(200) }).parse(await c.req.json());
	const clean = cleanRules(rules);
	const settings = await updateSpamLists(c.env.BUCKET, c.req.param("mailboxId")!, () => ({ rules: clean }));
	if (!settings) return c.json({ error: "Not found" }, 404);
	return c.json({ settings });
});

// Mail App: automatic forwarding. Kept in the mailbox's settings file in R2; how the last one went is beside it.
app.get("/api/v1/mailboxes/:mailboxId/forwarding", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const settings = await spamSettingsFor(c.env.BUCKET, mailboxId);
	if (!settings) return c.json({ error: "Not found" }, 404);
	return c.json({
		forwarding: cleanForwarding((settings as { forwarding?: unknown }).forwarding),
		status: await loadForwardingStatus(c.env.BUCKET, mailboxId),
	});
});

app.put("/api/v1/mailboxes/:mailboxId/forwarding", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = z.object({ enabled: z.boolean(), email: z.string().max(254), keepCopy: z.boolean(), includeSpam: z.boolean().optional() }).parse(await c.req.json());
	const email = body.email.trim().toLowerCase();
	if (body.enabled || email) {
		const problem = forwardingProblem(email, mailboxId, (await installDomains(c.env)).domains);
		if (problem) return c.json({ error: problem }, 400);
	}
	const forwarding = cleanForwarding({ ...body, email });
	const settings = await updateSpamLists(c.env.BUCKET, mailboxId, () => ({ forwarding }) as SpamSettings);
	if (!settings) return c.json({ error: "Not found" }, 404);
	return c.json({ forwarding, status: await loadForwardingStatus(c.env.BUCKET, mailboxId) });
});

// Mail App: "Apply to existing mail too": runs one saved rule on what's already in the Inbox.
app.post("/api/v1/mailboxes/:mailboxId/rules/:id/apply", async (c: AppContext) => {
	const settings = await spamSettingsFor(c.env.BUCKET, c.req.param("mailboxId")!);
	const rule = cleanRules((settings as { rules?: unknown } | null)?.rules).find((r) => r.id === c.req.param("id"));
	if (!rule) return c.json({ error: "Rule not found" }, 404);
	const changed = await (c.var.mailboxStub as any).applyRuleToInbox(rule) as number;
	return c.json({ changed });
});

// Mail App: tick several conversations in the list and act on them all at once (and the Archive button).
const ConversationsBody = z.object({
	ids: z.array(z.string().max(200)).min(1).max(100),
	action: z.enum(["move", "read", "unread", "delete"]),
	folderId: z.string().max(100).optional(),
	// Mail App: the folder being looked at (a "no reply" reminder in the Inbox is a sent email).
	fromFolder: z.string().max(100).optional(),
});

app.post("/api/v1/mailboxes/:mailboxId/conversations", async (c: AppContext) => {
	const { ids, action, folderId, fromFolder } = ConversationsBody.parse(await c.req.json());
	if (folderId === Folders.SNOOZED) return c.json({ error: "Use Snooze to choose when it comes back." }, 400);
	const removed = await c.var.mailboxStub.updateConversations(ids, action, folderId, fromFolder);
	if (removed === null) return c.json({ error: "Folder not found" }, 400);
	if (removed.length > 0) await c.env.BUCKET.delete(removed.map((att) => `attachments/${att.email_id}/${att.id}/${att.filename}`));
	return c.json({ status: "done" });
});

// Mail App: snooze conversations until a set time, or bring them back now.
const SnoozeBody = z.object({
	ids: z.array(z.string().max(200)).min(1).max(100),
	until: z.number(),
	fromFolder: z.string().max(100).optional(),
});

app.post("/api/v1/mailboxes/:mailboxId/snooze", async (c: AppContext) => {
	const { ids, until, fromFolder } = SnoozeBody.parse(await c.req.json());
	if (!validDueAt(until)) return c.json({ error: "Choose a time in the next year." }, 400);
	const snoozed = await c.var.mailboxStub.snooze(ids, until, fromFolder);
	return c.json({ snoozed });
});

app.post("/api/v1/mailboxes/:mailboxId/unsnooze", async (c: AppContext) => {
	const { ids } = z.object({ ids: z.array(z.string().max(200)).min(1).max(100) }).parse(await c.req.json());
	await c.var.mailboxStub.unsnooze(ids);
	return c.json({ status: "done" });
});

// Mail App: "Remind me if no reply" on an email already sent, and cancelling a reminder or snooze.
app.put("/api/v1/mailboxes/:mailboxId/emails/:id/reminder", async (c: AppContext) => {
	const { at } = z.object({ at: z.number() }).parse(await c.req.json());
	if (!validDueAt(at)) return c.json({ error: "Choose a time in the next year." }, 400);
	const ok = await c.var.mailboxStub.remindIfNoReply(c.req.param("id")!, at);
	return ok ? c.json({ status: "done" }) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id/reminder", async (c: AppContext) => {
	const kind = c.req.query("kind") === "snooze" ? "snooze" : "no-reply";
	await c.var.mailboxStub.cancelReminder(c.req.param("id")!, kind);
	return c.json({ status: "done" });
});

const MarkAllReadBody = z.object({ folderId: z.string().max(100).optional(), labelId: z.string().max(100).optional() });

app.post("/api/v1/mailboxes/:mailboxId/mark-all-read", async (c: AppContext) => {
	const where = MarkAllReadBody.parse(await c.req.json());
	if (!where.folderId && !where.labelId) return c.json({ error: "Say which folder or label." }, 400);
	await c.var.mailboxStub.markAllRead(where);
	return c.json({ status: "done" });
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	if (folderId === Folders.SNOOZED) return c.json({ error: "Use Snooze to choose when it comes back." }, 400);
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Mail App: backups ---------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/backups", async (c: AppContext) => {
	return c.json(await c.var.mailboxStub.listBackups());
});

app.post("/api/v1/mailboxes/:mailboxId/backups", async (c: AppContext) => {
	return c.json(await c.var.mailboxStub.startBackup(), 202);
});

const BackupSettingsBody = z.object({ nightly: z.boolean().optional(), keep: z.number().int().min(1).max(7).optional() });

app.put("/api/v1/mailboxes/:mailboxId/backups/settings", async (c: AppContext) => {
	return c.json(await c.var.mailboxStub.updateBackupSettings(BackupSettingsBody.parse(await c.req.json())));
});

app.delete("/api/v1/mailboxes/:mailboxId/backups/:id", async (c: AppContext) => {
	return (await c.var.mailboxStub.removeBackup(c.req.param("id")!)) ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
});

// The backup's pieces, one after another, as one .mbox file.
app.get("/api/v1/mailboxes/:mailboxId/backups/:id/download", async (c: AppContext) => {
	const found = await c.var.mailboxStub.backupPieces(c.req.param("id")!);
	if (!found) return c.json({ error: "Not found" }, 404);
	// A fixed-length stream, so the browser knows the size and can show download progress.
	const { readable, writable } = new FixedLengthStream(found.row.size);
	const pump = async () => {
		for (const key of found.keys) {
			const obj = await c.env.BUCKET.get(key);
			if (!obj) throw new Error("A piece of this backup is missing.");
			await obj.body.pipeTo(writable, { preventClose: true });
		}
		await writable.close();
	};
	c.executionCtx.waitUntil(pump().catch((e) => writable.abort(e)));
	const mailbox = c.req.param("mailboxId")!.replace(/[^A-Za-z0-9@._-]/g, "_");
	const day = found.row.started_at.slice(0, 10);
	return new Response(readable, {
		headers: {
			"Content-Type": "application/mbox",
			"Content-Disposition": `attachment; filename="Mail App ${mailbox} ${day}.mbox"`,
			"Cache-Control": "no-store",
		},
	});
});

// -- Mail App: new-mail notifications on this device ------------------------

app.get("/api/v1/push/key", async (c) => c.json({ publicKey: await pushPublicKey(c.env) }));

const PushBody = z.object({
	endpoint: z.string().url().startsWith("https://").max(1000),
	keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
	device: z.string().max(60).optional(),
});

app.get("/api/v1/mailboxes/:mailboxId/push", async (c: AppContext) => {
	const devices = await listDevices(c.env, c.req.param("mailboxId")!);
	return c.json(devices.map(({ endpoint, device, created }) => ({ endpoint, device, created })));
});

app.post("/api/v1/mailboxes/:mailboxId/push", async (c: AppContext) => {
	const { endpoint, keys, device } = PushBody.parse(await c.req.json());
	await addDevice(c.env, c.req.param("mailboxId")!, { endpoint, p256dh: keys.p256dh, auth: keys.auth, device: device || "This device" });
	return c.json({ status: "on" });
});

app.delete("/api/v1/mailboxes/:mailboxId/push", async (c: AppContext) => {
	const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(await c.req.json());
	await removeDevice(c.env, c.req.param("mailboxId")!, endpoint);
	return c.json({ status: "off" });
});

app.post("/api/v1/mailboxes/:mailboxId/push/test", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const sent = await notifyDevices(c.env, mailboxId, {
		title: "Mail App", body: "Notifications are working. You'll see one like this when new mail arrives.",
		url: `/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox`,
	});
	return c.json({ sent });
});

// Bringing mail in from an .mbox file: the browser splits the file and sends up to 100 messages at a time.
const IMPORT_MAX_MESSAGES = 100;

app.post("/api/v1/mailboxes/:mailboxId/import", async (c: AppContext) => {
	const form = await c.req.formData();
	const files = form.getAll("m").filter((m): m is File => typeof m !== "string");
	if (files.length === 0) return c.json({ error: "No messages were sent." }, 400);
	if (files.length > IMPORT_MAX_MESSAGES) return c.json({ error: `Send at most ${IMPORT_MAX_MESSAGES} messages at a time.` }, 400);
	const name = String(form.get("folder") ?? "").trim().slice(0, 60);
	const system = systemFolderFor(name);
	const fallback = system ? { system } : { name: name || "Imported" };
	const raws = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
	return c.json(await importMessages(c.env, c.var.mailboxStub, c.req.param("mailboxId")!, raws, fallback));
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
		label: c.req.query("label"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- Download links (added for Mail App) -------------------------------

// The composer uploads each big file here, already encrypted in the browser.
app.post("/api/v1/mailboxes/:mailboxId/links", async (c: AppContext) => {
	if (!linksAvailable(c.env, import.meta.env.DEV)) return c.json({ error: "Download links aren't switched on yet. The README shows how to switch them on." }, 409);
	const { status, body } = await storeLink(c.env, decodeURIComponent(c.req.param("mailboxId") ?? ""), c.req.raw);
	return c.json(body, status as 201 | 400);
});

app.get("/api/v1/mailboxes/:mailboxId/links", async (c: AppContext) => {
	return c.json(await listLinks(c.env, decodeURIComponent(c.req.param("mailboxId") ?? "")));
});

app.delete("/api/v1/mailboxes/:mailboxId/links/:token", async (c: AppContext) => {
	const ok = await deleteLink(c.env, decodeURIComponent(c.req.param("mailboxId") ?? ""), c.req.param("token") ?? "");
	return ok ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

async function spamSettingsFor(bucket: R2Bucket, mailboxId: string): Promise<SpamSettings | null> {
	try {
		const obj = await bucket.get(`mailboxes/${mailboxId}.json`);
		return obj ? ((await obj.json()) as SpamSettings) : null;
	} catch {
		return null;
	}
}

async function receiveEmail(event: { raw: ReadableStream; rawSize: number; to?: string; setReject?: (reason: string) => void; forward?: (rcptTo: string, headers?: Headers) => Promise<void> }, env: Env, ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	const allowedAddresses = ((env.EMAIL_ADDRESSES ?? []) as string[]).map((a) => a.toLowerCase());
	const allRecipients = (parsedEmail.to || []).map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	// Mail App: use the real delivery address first, so mail where you're only in CC or BCC, or that
	// came through a mailing list, isn't dropped. Then the first of To and CC that is a mailbox.
	const candidates = recipientCandidates(
		event.to,
		(parsedEmail.to || []).map((t) => t.address),
		(parsedEmail.cc || []).map((t) => t.address),
		allowedAddresses,
	);
	// Mail App: a recipient can be a mailbox, one of its extra addresses (with or without a +tag), a masked
	// address, or any other address at your domains when a mailbox catches all of them.
	const { mailboxes, domains } = await installDomains(env);
	const [book, masked] = await Promise.all([loadAddressBook(env.BUCKET), loadMasked(env.BUCKET)]);
	const route = routeIncoming(candidates, mailboxes, book, masked, domains);
	if (!route) { console.log(`Ignoring email: none of ${candidates.length} recipient(s) is a mailbox or address here.`); return; }
	// A masked address that's off or has ended: the email goes back to whoever sent it.
	if ("reject" in route) { event.setReject?.(route.reject); return; }
	const delivery = route;
	const mailboxId = delivery.mailbox;
	const settingsForMasked = delivery.masked ? await spamSettingsFor(env.BUCKET, mailboxId) : null;
	const maskedLeak = delivery.masked ? await noteMaskedMail(env.BUCKET, masked, { ...delivery.masked, mailbox: mailboxId },
		parsedEmail.from?.address || "", !!(settingsForMasked as { maskedKeepNew?: boolean } | null)?.maskedKeepNew) : null;
	// Remember which address it came in on, so a reply can come from the same one. Any copy of the
	// header in the email itself is dropped first, so a sender can't choose it.
	const headers = [
		...(parsedEmail.headers || []).filter((h) => ![DELIVERED_TO_HEADER, SPAM_REASON_HEADER, MASKED_LEAK_HEADER].includes(h.key.toLowerCase())),
		{ key: DELIVERED_TO_HEADER, value: delivery.deliveredTo },
		// Mail App: from a different website than the masked address was for.
		...(maskedLeak ? [{ key: MASKED_LEAK_HEADER, value: maskedLeak }] : []),
	];

	const messageId = crypto.randomUUID();
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			// Mail App: a calendar invite usually comes without a file name.
			const isInvite = /^(text\/calendar|application\/ics)/i.test(att.mimeType || "");
			const filename = (att.filename || (isInvite ? "invite.ics" : "untitled")).replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	// Mail App: a guest's answer to one of our invites, or a change to an event already in the calendar.
	const invite = parsedEmail.attachments?.find((a) => /^(text\/calendar|application\/ics)/i.test(a.mimeType || ""));
	if (invite) {
		const ics = typeof invite.content === "string" ? invite.content : new TextDecoder().decode(invite.content);
		await takeInIncomingInvite(stub as any, ics, parsedEmail.from?.address || "").catch((e) => console.error("Invite not taken in:", (e as Error).message));
	}

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;
	// Mail App: a reply joins the conversation of the message it answers, if we have it, so it sits
	// with the rest of the conversation and keeps its labels.
	const knownThread = await (stub as any).findThreadByMessageIds([inReplyTo, ...emailReferences].filter(Boolean));
	if (knownThread) threadId = knownThread;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await (stub as any).findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined,
			delivery.deliveredTo !== mailboxId.toLowerCase() ? delivery.deliveredTo : undefined);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

	// Mail App: blocked senders, and mail whose DMARC check failed at Cloudflare, go to Spam. The reason is kept
	// in our own header so the message can say why it's there.
	const sender = (parsedEmail.from?.address || "").toLowerCase();
	const spamSettings = await spamSettingsFor(env.BUCKET, mailboxId);
	const listed = spamReason(sender, parsedEmail.headers, spamSettings);
	let isSpam = listed !== null;
	let reasons: { check: StoredReason; detail?: string }[] = listed ? [{ check: listed }] : [];

	// Mail App: automatic spam checks (shared/spam-checks.ts), skipped for senders you trust: "Not spam",
	// your contacts, people you've emailed, and replies in a conversation you already have. Then what
	// this mailbox has learnt from Spam and Not spam (shared/spam-learning.ts) and, when an admin has
	// switched it on and the free checks haven't decided, the AI check (shared/spam-ai.ts).
	const trusted = !!knownThread || senderMatches(sender, spamSettings?.safeSenders) || (await stub.knowsSender(sender));
	const learnTokens = tokensFor({ sender, subject: parsedEmail.subject || "", body: parsedEmail.html || parsedEmail.text || "" });
	let autoScore = 0;
	if (!isSpam && !trusted) {
		const replyTo = parsedEmail.replyTo?.[0]?.address || null;
		const found = spamChecks({
			sender, senderName: parsedEmail.from?.name || null, replyTo,
			subject: parsedEmail.subject || "", html: parsedEmail.html || null, text: parsedEmail.text || null,
			domainAgeDays: await domainAgeDays(siteOf(sender.split("@")[1] ?? "")),
			headers: parsedEmail.headers || [],
			attachments: attachmentData.filter((a) => a.disposition !== "inline").map((a) => a.filename),
		});
		const learnt = learntFinding(await stub.learntSpamProbability(learnTokens).catch(() => null));
		if (learnt) found.push(learnt);
		if (spamScore(found) < SPAM_THRESHOLD) {
			const verdict = await aiSpamCheck(env, {
				sender, senderName: parsedEmail.from?.name || null, replyTo, subject: parsedEmail.subject || "",
				text: parsedEmail.text?.trim() || plainText(parsedEmail.html || ""),
				links: [...(parsedEmail.html || "").matchAll(/href\s*=\s*["']https?:\/\/([^/"'?#:]+)/gi)].map((m) => m[1].toLowerCase()),
			});
			const points = verdict ? spamAiPoints(verdict) : 0;
			if (verdict && points) {
				const detail = verdict.reason || (verdict.verdict === "phishing" ? "it looks like phishing." : "it looks like spam.");
				found.push({ check: "ai-check", points, detail });
			}
		}
		autoScore = spamScore(found);
		if (autoScore >= SPAM_THRESHOLD) { isSpam = true; reasons = found.filter((f) => f.points > 0).sort((a, b) => b.points - a.points); }
	}
	if (reasons.length) headers.push({ key: SPAM_REASON_HEADER, value: reasonHeaderValue(reasons) });

	// Mail App: inbox rules, top first, on mail that isn't spam. A rule can move it, label it, mark it read or star it.
	const rules = isSpam ? { labels: [], markRead: false, star: false, matched: [] } : applyRules(
		cleanRules((spamSettings as { rules?: InboxRule[] } | null)?.rules),
		{
			sender, senderName: parsedEmail.from?.name || null,
			recipients: [...allRecipients, ...ccRecipients, delivery.deliveredTo],
			subject: parsedEmail.subject || "", body: parsedEmail.html || parsedEmail.text || "",
			hasAttachment: attachmentData.some((a) => a.disposition !== "inline"),
		},
	);
	let folder: string = isSpam ? Folders.SPAM : Folders.INBOX;
	if (rules.folder && (await stub.getFolders()).some((f: { id: string }) => f.id === rules.folder)) folder = rules.folder;
	// Mail a rule sends to Spam or Trash is treated like spam: no out-of-office reply and no AI.
	if (folder === Folders.SPAM || folder === Folders.TRASH) isSpam = true;

	// Mail App: automatic forwarding (Settings > Forwarding). Never spam (unless "Forward spam too"), or mail this mailbox already forwarded
	// once (it came back round). When it has gone and the person doesn't keep a copy in the inbox, it's
	// filed in Archive, marked as read, so nothing is lost.
	const forwarding = cleanForwarding((spamSettings as { forwarding?: unknown } | null)?.forwarding);
	let markRead = rules.markRead;
	if (shouldForward(forwarding, { isSpam, mailboxId, headers: parsedEmail.headers || [] })) {
		const forwarded = await forwardEmail(env, forwarding, {
			mailboxId, forward: event.forward ? (to: string, h?: Headers) => event.forward!(to, h) : undefined, rawSize: event.rawSize,
			sender, senderName: parsedEmail.from?.name || null, subject: parsedEmail.subject || "",
			html: parsedEmail.html || null, text: parsedEmail.text || null,
			forwardedBy: (parsedEmail.headers || []).filter((h) => h.key.toLowerCase() === FORWARDED_HEADER).flatMap((h) => h.value.toLowerCase().split(/[\s,]+/).filter(Boolean)),
			spam: isSpam,
			attachments: (parsedEmail.attachments || []).map((a, i) => ({
				content: a.content, filename: attachmentData[i]?.filename || a.filename || "untitled", mimeType: a.mimeType,
				disposition: a.disposition === "inline" ? "inline" : "attachment", contentId: a.contentId || null,
			})),
		});
		if (forwarded && !forwarding.keepCopy && folder === Folders.INBOX) { folder = Folders.ARCHIVE; markRead = true; }
	}

	// Mail a rule files away, or marks as read, doesn't buzz your phone.
	const quiet = isSpam || folder !== Folders.INBOX || markRead;

	await stub.createEmail(folder, {
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(), sender_name: parsedEmail.from?.name || null,
		recipient: (allRecipients.length ? allRecipients : [mailboxId]).join(", "),
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(headers),
		read: markRead, starred: rules.star,
	}, attachmentData);
	if (rules.labels.length) await stub.setConversationLabels(messageId, rules.labels, []);
	// Mail App: Admin > Reports: count it, and why it went to Spam.
	const spamWhy: SpamWhy | null = folder !== Folders.SPAM ? null : listed ?? (reasons.length ? "checks" : "rule");
	ctx.waitUntil((stub as any).countMail(spamWhy ? ["received", `spam:${spamWhy}`] : ["received"]).catch(() => {}));

	// Mail App: learn from the clearest cases without anyone pressing anything: mail from blocked senders or
	// that scored very high is spam, and mail from people you know that stayed out of Spam is genuine.
	const learnAs = listed === "blocked" || autoScore >= SURE_SPAM_SCORE ? true
		: trusted && folder !== Folders.SPAM && folder !== Folders.TRASH ? false : null;
	if (learnAs !== null) ctx.waitUntil(stub.learnNewEmail(messageId, learnAs, learnTokens).catch(() => {}));

	// Mail App: tell webhooks (see workers/lib/api.ts). Not for spam, or mail a rule put in the Bin.
	if (folder !== Folders.SPAM && folder !== Folders.TRASH) emitEvent(env, ctx, "email.received", mailboxId, {
		id: messageId, thread_id: threadId, folder, subject: parsedEmail.subject || "",
		from: sender, from_name: parsedEmail.from?.name || null,
		to: (allRecipients.length ? allRecipients : [mailboxId]).join(", "), cc: ccRecipients.join(", ") || null,
		date: new Date().toISOString(), has_attachments: attachmentData.some((a) => a.disposition !== "inline"),
	});

	// Mail App: a notification on each device that has them switched on. Never for spam.
	if (!quiet) ctx.waitUntil(notifyNewMail(env, stub, mailboxId, {
		id: messageId, threadId, sender: parsedEmail.from?.name || parsedEmail.from?.address || "", subject: parsedEmail.subject || "",
	}).catch((e) => console.error("New-mail notification failed:", (e as Error).message)));

	// Mail App: out of office. Never for spam, or mail to a masked address (it would give away your real one);
	// failures (such as the free plan's sending limits) are only logged.
	if (!isSpam && !delivery.masked) {
		ctx.waitUntil(sendAutoReply(env, spamSettings as Record<string, unknown> | null, {
			mailboxId, replyAs: book.aliases.find((a) => a.address === delivery.deliveredTo && a.mailbox === mailboxId),
			sender, subject: parsedEmail.subject || "", headers: parsedEmail.headers,
			threadId, messageId: originalMessageId, references: emailReferences,
		}).catch((e) => console.error("Automatic reply failed:", (e as Error).message)));
	}

	// Mail App: only hand new mail to the AI agent when the person has switched AI on, and never spam.
	if (isSpam || !(await aiEnabledFor(env.BUCKET, mailboxId))) return;

	const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
	ctx.waitUntil(agentStub.fetch(new Request("https://agents/onNewEmail", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, emailId: messageId, sender: (parsedEmail.from?.address || "").toLowerCase(), subject: parsedEmail.subject || "", threadId }),
	})).catch((e) => console.error("Auto-draft trigger failed:", (e as Error).message)));
}

// Mail App: counts an email to a masked address (adding it if it's new) and returns the website to warn about, if any.
async function noteMaskedMail(bucket: R2Bucket, file: Awaited<ReturnType<typeof loadMasked>>, route: { address: string; isNew: boolean; mailbox: string }, sender: string, keepNew: boolean) {
	try {
		const { file: next, leak } = recordMaskedMail(file, route, sender, { keepNew });
		await saveMasked(bucket, next);
		return leak;
	} catch (e) {
		console.error("Masked address not noted:", (e as Error).message);
		return null;
	}
}

async function notifyNewMail(env: Env, stub: { getFolders(): Promise<unknown> }, mailboxId: string, mail: { id: string; threadId: string; sender: string; subject: string }) {
	if ((await listDevices(env, mailboxId)).length === 0) return;
	const folders = (await stub.getFolders()) as { id: string; unreadCount: number }[];
	await notifyDevices(env, mailboxId, {
		title: cleanSenderName(mail.sender) || mail.sender || "New email",
		body: mail.subject || "(no subject)",
		url: `/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox?open=${encodeURIComponent(mail.id)}`,
		unread: folders.find((f) => f.id === Folders.INBOX)?.unreadCount ?? undefined,
	});
}

// Mail App: anything that goes wrong in the app's own code comes back as a sentence the person can read,
// never a bare "Request failed: 500". The real error goes to the Worker's logs.
app.onError((e, c) => {
	if (e instanceof z.ZodError) {
		const line = { to: "To", cc: "Cc", bcc: "Bcc", from: "From" }[String(e.issues[0]?.path[0] ?? "")];
		return c.json({ error: line
			? `Not sent. An address on the ${line} line isn't a valid email address. Check it and try again.`
			: "Some details were missing or not valid. Please check and try again." }, 400);
	}
	console.error("Request failed:", c.req.method, c.req.path, (e as Error)?.stack ?? e);
	return c.json({ error: "Something went wrong in Mail App. Please try again. If it keeps happening, your admin can find the details in the Worker's logs in Cloudflare." }, 500);
});

export { app, receiveEmail };
