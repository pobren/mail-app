// Mail App addition (not part of upstream Agentic Inbox).
// Settings > Account > Passkeys: everyone adds and removes their own. Signing in with one happens at
// /passkey/ (workers/lib/passkeys.ts), which Cloudflare's sign-in page sends people to.

import { Hono } from "hono";
import { z } from "zod";
import { MAX_PASSKEYS_PER_PERSON, guessDeviceName, passkeysOf, toView } from "../../shared/passkeys";
import { finishRegistration, loadPasskeys, passkeysSwitchedOn, registrationOptions, updatePasskeys } from "../lib/passkeys";
import type { MailboxContext } from "../lib/mailbox";

export const passkeys = new Hono<MailboxContext>();

const dev = () => !!import.meta.env?.DEV;

passkeys.get("/api/v1/passkeys", async (c) => {
	const { book } = await loadPasskeys(c.env.BUCKET);
	return c.json({
		on: passkeysSwitchedOn(c.env, dev()),
		passkeys: passkeysOf(book, c.var.person.email).map(toView),
		suggestedName: guessDeviceName(c.req.header("user-agent") ?? ""),
		max: MAX_PASSKEYS_PER_PERSON,
	});
});

passkeys.post("/api/v1/passkeys/options", async (c) => {
	if (!passkeysSwitchedOn(c.env, dev())) return c.json({ error: "Passkeys switch on with the next update of Mail App." }, 409);
	return c.json(await registrationOptions(c.env, c.req.raw, c.var.person.email, c.var.person.name));
});

const AddBody = z.object({
	state: z.string().max(4000),
	name: z.string().max(200).optional(),
	// Checked in full by the WebAuthn library; only its size is limited here.
	response: z.object({ id: z.string().max(1400) }).passthrough(),
});

passkeys.post("/api/v1/passkeys", async (c) => {
	if (!passkeysSwitchedOn(c.env, dev())) return c.json({ error: "Passkeys switch on with the next update of Mail App." }, 409);
	const raw = await c.req.text();
	if (raw.length > 64_000) return c.json({ error: "That passkey is too large." }, 413);
	const input = AddBody.parse(JSON.parse(raw));
	const result = await finishRegistration(c.env, c.req.raw, c.var.person.email, input as never);
	if (!result.ok) return c.json({ error: result.error }, 400);
	return c.json(toView(result.passkey));
});

passkeys.delete("/api/v1/passkeys/:id", async (c) => {
	const id = c.req.param("id");
	const email = c.var.person.email;
	const removed = await updatePasskeys(c.env.BUCKET, (book) => {
		const before = book.passkeys.length;
		book.passkeys = book.passkeys.filter((p) => !(p.id === id && p.email === email));
		return book.passkeys.length < before;
	});
	return removed ? c.body(null, 204) : c.json({ error: "Passkey not found" }, 404);
});
