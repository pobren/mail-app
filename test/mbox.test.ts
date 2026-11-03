// Round trip: emails rebuilt for backups must read back the same in a real email parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import PostalMime from "postal-mime";
import { buildMessage, mboxEntry, emailDate, htmlToText } from "../shared/mbox.ts";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

test("an incoming HTML email with a picture and an attachment reads back the same", async () => {
	const raw = buildMessage({
		id: "abc",
		subject: "Café plans für Zoë",
		sender: "zoe@example.com",
		sender_name: "Zoë Müller",
		recipient: "paul@example.co.uk",
		date: "2026-10-11T08:12:00.000Z",
		body: '<p>Hello <b>Paul</b>,</p><p><img src="cid:pic1@x"></p><p>See attached.</p>',
		message_id: "orig-1@example.com",
		raw_headers: JSON.stringify([
			{ key: "from", value: "Zoë Müller <zoe@example.com>" },
			{ key: "to", value: "paul@example.co.uk" },
			{ key: "subject", value: "Café plans für Zoë" },
			{ key: "date", value: "Sat, 10 Oct 2026 22:01:00 +0100" },
			{ key: "message-id", value: "<orig-1@example.com>" },
			{ key: "received", value: "from a by b" },
			{ key: "received", value: "from c by d" },
			{ key: "content-type", value: "multipart/alternative; boundary=old" },
		]),
	}, [
		{ filename: "pic.png", mimetype: "image/png", content_id: "<pic1@x>", disposition: "inline", bytes: png },
		{ filename: "Rechnung Nr. 5.pdf", mimetype: "application/pdf", disposition: "attachment", bytes: new Uint8Array([1, 2, 3, 4]) },
	]);
	assert.ok(raw.split("\r\n").every((l) => l.length <= 998));
	const parsed = await new PostalMime().parse(raw);
	assert.equal(parsed.subject, "Café plans für Zoë");
	assert.equal(parsed.from?.name, "Zoë Müller");
	assert.equal(parsed.from?.address, "zoe@example.com");
	assert.equal(parsed.messageId, "<orig-1@example.com>");
	assert.equal(parsed.date, new Date("Sat, 10 Oct 2026 22:01:00 +0100").toISOString());
	assert.match(parsed.html ?? "", /<b>Paul<\/b>/);
	assert.match(parsed.text ?? "", /Hello Paul,/);
	assert.equal(parsed.attachments.length, 2);
	const pic = parsed.attachments.find((a) => a.filename === "pic.png")!;
	assert.equal(pic.contentId, "<pic1@x>");
	assert.deepEqual(new Uint8Array(pic.content as ArrayBuffer), png);
	assert.ok(parsed.attachments.some((a) => a.filename === "Rechnung Nr. 5.pdf"));
	assert.equal(parsed.headers.filter((h) => h.key === "received").length, 2);
});

test("a sent plain-text email without stored headers gets standard ones", async () => {
	const raw = buildMessage({
		id: "s1", subject: "Hi", sender: "paul@example.co.uk", recipient: "tom@example.com",
		date: "2026-10-11T09:00:00.000Z", body: "Line one\nFrom the start\n\nBye", in_reply_to: "x@y",
		email_references: JSON.stringify(["a@b", "x@y"]),
	});
	const parsed = await new PostalMime().parse(raw);
	assert.equal(parsed.to?.[0]?.address, "tom@example.com");
	assert.equal(parsed.text?.replace(/\r\n/g, "\n").trim(), "Line one\nFrom the start\n\nBye");
	assert.equal(parsed.inReplyTo, "<x@y>");
	assert.equal(parsed.messageId, "<s1@mail-app.local>");
	assert.equal(parsed.date, "2026-10-11T09:00:00.000Z");
});

test("mbox entries carry the folder, labels and flags, and quote From lines", () => {
	const entry = mboxEntry(
		{ id: "e", subject: "S", sender: "a@b.c", date: "2026-10-01T07:05:09.000Z", body: "x\nFrom here\n>From there", read: 1, starred: 1 },
		[], { folder: "Inbox", labels: ["Bills", "Work"] },
	);
	assert.ok(entry.startsWith("From a@b.c Thu Oct  1 07:05:09 2026\n"));
	assert.match(entry, /\nX-Mail-App-Folder: Inbox\n/);
	assert.match(entry, /\nX-Mail-App-Labels: Bills, Work\n/);
	assert.match(entry, /\nStatus: RO\n/);
	assert.match(entry, /\nX-Status: F\n/);
	assert.ok(!entry.includes("\r"));
	assert.ok(entry.endsWith("\n\n"));
	// Body is base64, so its own From lines can't break the file; headers are checked the same way anyway.
	assert.equal(entry.split("\n").filter((l) => l.startsWith("From ")).length, 1);
});

test("helpers", () => {
	assert.equal(emailDate("2026-10-11T08:12:00.000Z"), "Sun, 11 Oct 2026 08:12:00 +0000");
	assert.equal(htmlToText("<p>A &amp; B</p><p>C<br>D</p>"), "A & B\nC\nD");
});
