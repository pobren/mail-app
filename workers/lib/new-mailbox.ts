// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: moved here from workers/index.ts so the People page can make a
// mailbox while inviting someone; welcome email; address clash check; each mailbox belongs to a person.

import { Folders } from "../../shared/folders";
import { mailboxProblem } from "../../shared/addresses";
import { findPerson, withPerson } from "../../shared/people";
import welcomeCopy from "../../app/copy/welcome.en-GB.json";
import { loadAddressBook } from "./addresses";
import { loadMasked } from "./masked";
import { loadPeople, updatePeople } from "./people";
import { welcomeEmail } from "./welcome";
import { loadBranding } from "./branding";
import type { Env } from "../types";

export interface NewMailbox {
	email: string;
	name: string;
	settings?: Record<string, unknown>;
	/** Sign-in address of the person who will use it. */
	owner: string;
}

export type Made =
	| { ok: true; mailbox: { id: string; email: string; name: string; settings: Record<string, unknown> } }
	| { ok: false; status: 400 | 403 | 409; error: string };

export async function createMailbox(env: Env, origin: string, input: NewMailbox): Promise<Made> {
	const email = input.email.trim().toLowerCase();
	const name = input.name;
	const allowedAddresses = (env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return { ok: false, status: 403, error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" };
	}
	const key = `mailboxes/${email}.json`;
	if (await env.BUCKET.head(key)) return { ok: false, status: 409, error: "Mailbox already exists" };
	// Mail App: an extra address of another mailbox can't also be a mailbox, or the new one would quietly take its mail.
	const clash = mailboxProblem(email, await loadAddressBook(env.BUCKET));
	if (clash) return { ok: false, status: 409, error: clash };
	// Mail App: nor can someone's masked address.
	const masked = (await loadMasked(env.BUCKET)).addresses.find((m) => m.address === email.toLowerCase());
	if (masked) return { ok: false, status: 409, error: `${email} is already a masked address of ${masked.mailbox}.` };
	const owner = input.owner.trim().toLowerCase();
	if (!findPerson((await loadPeople(env.BUCKET)).book, owner)) return { ok: false, status: 400, error: `${owner} isn't on the People list.` };
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	const finalSettings = { ...defaultSettings, ...input.settings };
	await env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(email));
	await stub.getFolders();
	// Mail App: leave a welcome email in the new inbox. Best effort: a failure here mustn't stop the mailbox being created.
	try {
		const welcome = welcomeEmail(email, name, origin, new Date(), await loadBranding(env.BUCKET));
		await stub.createEmail(Folders.INBOX, welcome, []);
		// Mail App: the welcome email arrives with an "Important" label, so labels are easy to discover.
		const important = await (stub as any).createLabel(welcomeCopy.label, "red");
		if (typeof important === "object") await stub.setConversationLabels(welcome.id, [important.id], []);
	} catch (e) {
		console.error("Couldn't add the welcome email", e);
	}
	// Mail App: the new mailbox belongs to the person it was made for.
	await updatePeople(env.BUCKET, (b) => {
		const p = findPerson(b, owner);
		return p ? withPerson(b, { ...p, mailboxes: [...p.mailboxes, email] }) : b;
	});
	return { ok: true, mailbox: { id: email, email, name, settings: finalSettings } };
}
