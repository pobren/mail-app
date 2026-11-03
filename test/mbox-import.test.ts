import { test } from "node:test";
import assert from "node:assert/strict";
import PostalMime from "postal-mime";
import { mboxEntry } from "../shared/mbox.ts";
import { MboxReader, folderFromFileName, placement, splitLabels } from "../shared/mbox-import.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function readAll(bytes: Uint8Array, chunk: number): Uint8Array[] {
	const r = new MboxReader();
	const out: Uint8Array[] = [];
	for (let i = 0; i < bytes.length; i += chunk) out.push(...r.push(bytes.subarray(i, i + chunk)));
	out.push(...r.end());
	return out;
}

test("a Mail App backup reads back message by message, whatever size the pieces arrive in", async () => {
	const file = [
		mboxEntry({ id: "1", subject: "One", sender: "a@x.com", date: "2026-10-01T00:00:00Z", body: "Hi\nFrom the top\n>From quoted", read: 1 }, [], { folder: "Inbox", labels: ["Bills"] }),
		mboxEntry({ id: "2", subject: "Two", sender: "b@x.com", date: "2026-10-02T00:00:00Z", body: "<p>Hello</p>", starred: 1 }, [], { folder: "Work stuff" }),
		mboxEntry({ id: "3", subject: "Three", sender: "c@x.com", date: "2026-10-03T00:00:00Z", body: "Bye" }, [], { folder: "Sent" }),
	].join("");
	const bytes = enc.encode(file);
	for (const size of [1, 7, 64, 100_000]) {
		const msgs = readAll(bytes, size);
		assert.equal(msgs.length, 3, `chunk ${size}`);
		const parsed = await Promise.all(msgs.map((m) => new PostalMime().parse(m)));
		assert.deepEqual(parsed.map((p) => p.subject), ["One", "Two", "Three"]);
		assert.equal(parsed[0].text?.replace(/\r\n/g, "\n").trim(), "Hi\nFrom the top\n>From quoted");
		const places = parsed.map((p) => placement(p.headers, { name: "Imported" }));
		assert.deepEqual(places[0], { folder: { system: "inbox" }, labels: ["Bills"], read: true, starred: false });
		assert.deepEqual(places[1], { folder: { name: "Work stuff" }, labels: [], read: false, starred: true });
		assert.deepEqual(places[2].folder, { system: "sent" });
	}
});

test("escaped From lines in plain mbox bodies are put back", () => {
	const file = "From a@b Thu Oct  1 00:00:00 2026\nSubject: x\n\nline\n>From me\n>>From you\n\nFrom c@d Thu Oct  1 00:00:00 2026\nSubject: y\n\nok\n";
	const msgs = readAll(enc.encode(file), 5).map((m) => dec.decode(m));
	assert.equal(msgs.length, 2);
	assert.equal(msgs[0], "Subject: x\n\nline\nFrom me\n>From you");
	assert.equal(msgs[1], "Subject: y\n\nok");
});

test("a single .eml with no From line is one message", () => {
	const msgs = readAll(enc.encode("Subject: z\r\n\r\nbody\r\n"), 3);
	assert.equal(msgs.length, 1);
	assert.equal(dec.decode(msgs[0]), "Subject: z\r\n\r\nbody");
});

test("Gmail Takeout labels", () => {
	const p = (labels: string) => placement([{ key: "x-gmail-labels", value: labels }], { name: "x" });
	assert.deepEqual(p('Inbox,Important,Opened,Category Personal,"Bills, home",Work/Clients'),
		{ folder: { system: "inbox" }, labels: ["Bills, home", "Work/Clients"], read: true, starred: false });
	assert.deepEqual(p("Unread,Starred,Sent").folder, { system: "sent" });
	assert.equal(p("Unread,Starred,Sent").read, false);
	assert.equal(p("Unread,Starred,Sent").starred, true);
	assert.deepEqual(p("Archived,Opened,Receipts").folder, { system: "archive" });
	assert.deepEqual(p("Spam,Inbox").folder, { system: "spam" });
	assert.deepEqual(splitLabels('a,"b,c",d'), ["a", "b,c", "d"]);
});

test("Thunderbird flags and file names", () => {
	assert.deepEqual(placement([{ key: "x-mozilla-status", value: "0005" }], { name: "Work" }), { folder: { name: "Work" }, labels: [], read: true, starred: true });
	assert.equal(placement([{ key: "x-mozilla-status", value: "0000" }], { name: "Work" }).read, false);
	assert.equal(placement([], { name: "Work" }).read, true);
	assert.equal(folderFromFileName("Takeout/Mail/All mail Including Spam and Trash.mbox"), "All mail Including Spam and Trash");
	assert.equal(folderFromFileName("Work.mbox"), "Work");
	assert.equal(folderFromFileName("C:\\mail\\old.eml"), "old");
});
