// Mail App addition (not part of upstream Agentic Inbox).
// Notes' API. The notes are in the mailbox's own database (workers/durableObject/notes.ts). requireMailbox
// has already checked the person can open the mailbox; each person sees their own notes and the ones
// shared with the mailbox.

import { Hono, type Context } from "hono";
import { cleanNoteInput } from "../../shared/notes";
import { isShared } from "../../shared/people";
import type { MailboxContext } from "../lib/mailbox";
import { loadPeople } from "../lib/people";

export const notes = new Hono<MailboxContext>();

const base = "/api/v1/mailboxes/:mailboxId/notes";
const ID = /^[0-9a-f-]{36}$/;
const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && ID.test(x)).slice(0, 1000) : []);
const viewerOf = (c: Context<MailboxContext>) => ({ email: (c.var.person?.email ?? "").toLowerCase(), name: c.var.person?.name ?? "" });
const GONE = "That note isn't there any more. Someone may have deleted it.";
const FULL = "This mailbox has as many notes as it can keep. Delete a few you don't need and try again.";

/** Does anyone else use this mailbox? Only then can a note be shared, and private ones keep quiet in reminders. */
async function sharedMailbox(c: Context<MailboxContext>): Promise<boolean> {
	const { book } = await loadPeople(c.env.BUCKET);
	return isShared(book, decodeURIComponent(c.req.param("mailboxId") ?? ""));
}

notes.get(base, async (c) => {
	const bin = c.req.query("bin") === "1";
	const [list, shared] = await Promise.all([c.var.mailboxStub.listNotes(viewerOf(c), bin), sharedMailbox(c)]);
	return c.json({ notes: list, sharedMailbox: shared });
});

notes.post(base, async (c) => {
	const input = cleanNoteInput(await c.req.json().catch(() => null));
	if (typeof input === "string") return c.json({ error: input }, 400);
	const made = await c.var.mailboxStub.createNote(input, viewerOf(c), await sharedMailbox(c));
	if (made === "full") return c.json({ error: FULL }, 400);
	return c.json(made, 201);
});

notes.put(`${base}/:id`, async (c) => {
	const id = c.req.param("id");
	if (!ID.test(id)) return c.json({ error: GONE }, 404);
	const input = cleanNoteInput(await c.req.json().catch(() => null));
	if (typeof input === "string") return c.json({ error: input }, 400);
	const done = await c.var.mailboxStub.updateNote(id, input, viewerOf(c), await sharedMailbox(c));
	if (done === "missing") return c.json({ error: GONE }, 404);
	if (done === "not-yours") return c.json({ error: "Only the person who wrote this note can change who sees it." }, 403);
	return c.json(done);
});

notes.post(`${base}/bin`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
	return c.json({ binned: await c.var.mailboxStub.binNotes(idList(body.ids), viewerOf(c)) });
});

notes.post(`${base}/restore`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
	return c.json({ restored: await c.var.mailboxStub.restoreNotes(idList(body.ids), viewerOf(c)) });
});

/** Deletes notes in the Bin for good; { all: true } empties the Bin. */
notes.post(`${base}/delete`, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; all?: unknown };
	return c.json({ deleted: await c.var.mailboxStub.deleteNotesForever(body.all === true ? null : idList(body.ids), viewerOf(c)) });
});
