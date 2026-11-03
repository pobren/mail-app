import { test } from "node:test";
import assert from "node:assert/strict";
import { aliasProblem, catchAllDomains, cleanAddressBook, withoutMailboxes, mailboxProblem, deliveredTo, replyFrom, replyFromSetting, resolveDelivery, sendableAddresses } from "../shared/addresses.ts";

const book = cleanAddressBook({
	aliases: [
		{ address: "Hello@Example.com", mailbox: "paul@example.com", name: "Mail App", signature: "The Mail App team" },
		{ address: "support@example.com", mailbox: "paul@example.com" },
		{ address: "bad", mailbox: "paul@example.com" },
		{ address: "hello@example.com", mailbox: "other@example.com" },
	],
	catchAll: "paul@example.com",
});
const boxes = ["paul@example.com"];

test("cleans the stored file", () => {
	assert.equal(book.aliases.length, 2);
	assert.deepEqual(book.aliases[0], { address: "hello@example.com", mailbox: "paul@example.com", name: "Mail App", signature: "The Mail App team" });
	assert.deepEqual(cleanAddressBook(null), { aliases: [], catchAll: {} });
	// A catch-all saved before they were per domain covers its own domain.
	assert.deepEqual(book.catchAll, { "example.com": "paul@example.com" });
});

test("delivers to a mailbox, an alias, a +tag and the catch-all", () => {
	assert.deepEqual(resolveDelivery(["paul@example.com"], boxes, book, ["example.com"]), { mailbox: "paul@example.com", deliveredTo: "paul@example.com" });
	assert.deepEqual(resolveDelivery(["hello@example.com"], boxes, book, ["example.com"]), { mailbox: "paul@example.com", deliveredTo: "hello@example.com" });
	assert.deepEqual(resolveDelivery(["support+orders@example.com"], boxes, book, ["example.com"]), { mailbox: "paul@example.com", deliveredTo: "support@example.com" });
	assert.deepEqual(resolveDelivery(["anything@example.com"], boxes, book, ["example.com"]), { mailbox: "paul@example.com", deliveredTo: "anything@example.com" });
	assert.equal(resolveDelivery(["someone@elsewhere.com"], boxes, book, ["example.com"]), null);
	assert.equal(resolveDelivery(["anything@example.com"], boxes, { ...book, catchAll: {} }, ["example.com"]), null);
});

test("an alias whose mailbox is gone gets nothing", () => {
	assert.equal(resolveDelivery(["hello@example.com"], [], { ...book, catchAll: {} }, ["example.com"]), null);
});

test("replies come from the address the email came in on", () => {
	assert.deepEqual(sendableAddresses(book, "paul@example.com"), ["paul@example.com", "hello@example.com", "support@example.com"]);
	assert.equal(replyFrom(book, "paul@example.com", ["support@example.com"]), "support@example.com");
	assert.equal(replyFrom(book, "paul@example.com", [null, "Jo <jo@x.com>, Mail App <hello@example.com>"]), "hello@example.com");
	assert.equal(replyFrom(book, "paul@example.com", ["hello+news@example.com"]), "hello@example.com");
	assert.equal(replyFrom(book, "paul@example.com", ["random@example.com"]), "paul@example.com");
});

test("reads the delivered-to header", () => {
	assert.equal(deliveredTo(JSON.stringify([{ key: "x-mail-app-delivered-to", value: "hello@example.com" }])), "hello@example.com");
	assert.equal(deliveredTo("not json"), null);
	assert.equal(deliveredTo(null), null);
});

test("explains why an alias can't be added", () => {
	assert.equal(aliasProblem("sales@example.com", "paul@example.com", book, boxes, ["example.com"]), null);
	assert.match(aliasProblem("sales", "paul@example.com", book, boxes, ["example.com"])!, /doesn't look like/);
	assert.match(aliasProblem("sales@other.com", "paul@example.com", book, boxes, ["example.com"])!, /at example.com/);
	assert.match(aliasProblem("paul@example.com", "paul@example.com", book, boxes, ["example.com"])!, /mailbox of its own/);
	assert.match(aliasProblem("hello@example.com", "paul@example.com", book, boxes, ["example.com"])!, /already has/);
});

test("a new mailbox can't take an address that is already an extra address", () => {
	const b = cleanAddressBook({ aliases: [{ address: "hello@example.com", mailbox: "paul@example.com" }] });
	assert.match(mailboxProblem("Hello@Example.com", b) ?? "", /already an extra address of paul@example.com/);
	assert.equal(mailboxProblem("new@example.com", b), null);
});

test("each domain has its own catch-all", () => {
	const b = cleanAddressBook({ aliases: [], catchAll: { "Example.com": "paul@example.com", "example.net": "Hello@Example.com", "bad domain": "x@y.z" } });
	assert.deepEqual(b.catchAll, { "example.com": "paul@example.com", "example.net": "hello@example.com" });
	const mailboxes = ["paul@example.com", "hello@example.com"];
	const domains = ["example.com", "example.net", "example.org"];
	assert.deepEqual(resolveDelivery(["typo@example.net"], mailboxes, b, domains), { mailbox: "hello@example.com", deliveredTo: "typo@example.net" });
	assert.deepEqual(resolveDelivery(["typo@example.com"], mailboxes, b, domains), { mailbox: "paul@example.com", deliveredTo: "typo@example.com" });
	// A domain with no catch-all drops mail to unknown addresses.
	assert.equal(resolveDelivery(["typo@example.org"], mailboxes, b, domains), null);
	// Only your own domains.
	assert.equal(resolveDelivery(["typo@example.net"], mailboxes, b, ["example.com"]), null);
	assert.deepEqual(catchAllDomains(b, "hello@example.com"), ["example.net"]);
	assert.deepEqual(withoutMailboxes(b, ["hello@example.com"]).catchAll, { "example.com": "paul@example.com" });
});

test("the Reply from setting picks the reply's address", () => {
	const book = cleanAddressBook({ aliases: [{ address: "hello@second.test", mailbox: "paul@example.com" }, { address: "sales@example.com", mailbox: "paul@example.com" }] });
	const to = ["hello@second.test"];
	assert.equal(replyFromSetting(book, "paul@example.com", undefined, to), "hello@second.test");
	assert.equal(replyFromSetting(book, "paul@example.com", "received", to), "hello@second.test");
	assert.equal(replyFromSetting(book, "paul@example.com", "main", to), "paul@example.com");
	assert.equal(replyFromSetting(book, "paul@example.com", "Sales@example.com", to), "sales@example.com");
	// An address that's been removed falls back to the one the email came to.
	assert.equal(replyFromSetting(book, "paul@example.com", "old@example.com", to), "hello@second.test");
});
