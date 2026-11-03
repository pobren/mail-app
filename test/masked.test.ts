import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanAddressBook } from "../shared/addresses.ts";
import {
	MASKED_BOUNCE, cleanMaskedFile, leakFromHeaders, maskedEnded, maskedProblem, maskedWithoutMailboxes, maskedWorks,
	newMaskedAddress, recordMaskedMail, routeIncoming, sendableMasked, siteFromLabel,
} from "../shared/masked.ts";

const book = cleanAddressBook({ aliases: [{ address: "hello@paul.com", mailbox: "me@paul.com" }], catchAll: { "paul.com": "me@paul.com" } });
const boxes = ["me@paul.com", "jo@paul.com"];
const now = new Date("2026-10-16T12:00:00Z");
const file = cleanMaskedFile({
	domains: { "paul.com": "me@paul.com", "Bad Domain": "x" },
	addresses: [
		{ address: "amazon.k7q2xm@paul.com", mailbox: "me@paul.com", label: "Amazon", sites: ["amazon.co.uk"], status: "on", created: "2026-10-01T00:00:00Z", count: 3 },
		{ address: "gone.aaaa@paul.com", mailbox: "me@paul.com", sites: [], status: "off", created: "2026-10-01T00:00:00Z", count: 0 },
		{ address: "old.bbbb@paul.com", mailbox: "me@paul.com", sites: [], status: "on", created: "2026-10-01T00:00:00Z", expires: "2026-10-10T00:00:00Z", count: 0 },
		{ address: "code.cccc@paul.com", mailbox: "me@paul.com", sites: [], status: "on", created: "2026-10-01T00:00:00Z", once: true, count: 1 },
		{ address: "not an address", mailbox: "me@paul.com" },
	],
});

test("cleans the stored file", () => {
	assert.deepEqual(Object.keys(file.domains), ["paul.com"]);
	assert.equal(file.addresses.length, 4);
	assert.deepEqual(cleanMaskedFile(null), { domains: {}, addresses: [] });
	assert.equal(cleanMaskedFile({ addresses: [{ address: "a@b.com", mailbox: "me@b.com", status: "weird" }] }).addresses[0].status, "on");
});

test("works, ends and switches off", () => {
	const [amazon, gone, old, code] = file.addresses;
	assert.equal(maskedWorks(amazon, now), true);
	assert.equal(maskedWorks(gone, now), false);
	assert.equal(maskedEnded(old, now), true);
	assert.equal(maskedEnded(code, now), true);
	assert.equal(maskedEnded({ ...code, count: 0 }, now), false);
	// Replies still go from one that ended after its first email, but not one that's off or past its date.
	assert.deepEqual(sendableMasked(file, "me@paul.com", now), ["amazon.k7q2xm@paul.com", "code.cccc@paul.com"]);
});

test("routes incoming mail: mailbox and alias first, then masked, then catch-all", () => {
	assert.deepEqual(routeIncoming(["me@paul.com"], boxes, book, file, ["paul.com"], now), { mailbox: "me@paul.com", deliveredTo: "me@paul.com" });
	assert.deepEqual(routeIncoming(["hello@paul.com"], boxes, book, file, ["paul.com"], now), { mailbox: "me@paul.com", deliveredTo: "hello@paul.com" });
	assert.deepEqual(routeIncoming(["Amazon.K7Q2XM@paul.com"], boxes, book, file, ["paul.com"], now),
		{ mailbox: "me@paul.com", deliveredTo: "amazon.k7q2xm@paul.com", masked: { address: "amazon.k7q2xm@paul.com", isNew: false } });
	// Off, past its date, or used up: sent back.
	for (const a of ["gone.aaaa@paul.com", "old.bbbb@paul.com", "code.cccc@paul.com"]) {
		assert.deepEqual(routeIncoming([a], boxes, book, file, ["paul.com"], now), { reject: MASKED_BOUNCE, address: a });
	}
	// But a mailbox in CC still gets it.
	assert.deepEqual(routeIncoming(["gone.aaaa@paul.com", "jo@paul.com"], boxes, book, file, ["paul.com"], now), { mailbox: "jo@paul.com", deliveredTo: "jo@paul.com" });
	// Anything else at a masked-email domain is a new masked address, ahead of the catch-all.
	assert.deepEqual(routeIncoming(["shop.anything@paul.com"], boxes, book, file, ["paul.com"], now),
		{ mailbox: "me@paul.com", deliveredTo: "shop.anything@paul.com", masked: { address: "shop.anything@paul.com", isNew: true } });
	// Without masked email there, the catch-all takes it.
	assert.deepEqual(routeIncoming(["shop.anything@paul.com"], boxes, book, { ...file, domains: {} }, ["paul.com"], now), { mailbox: "me@paul.com", deliveredTo: "shop.anything@paul.com" });
	assert.equal(routeIncoming(["x@elsewhere.com"], boxes, book, file, ["paul.com"], now), null);
});

test("records mail: new ones wait, learn the website, spot leaks", () => {
	const first = recordMaskedMail(file, { address: "shop.anything@paul.com", isNew: true, mailbox: "me@paul.com" }, "Orders@mail.shop.co.uk", { keepNew: false, now });
	const added = first.file.addresses.find((a) => a.address === "shop.anything@paul.com")!;
	assert.equal(first.added, true);
	assert.equal(added.status, "waiting");
	assert.deepEqual(added.sites, ["shop.co.uk"]);
	assert.equal(added.count, 1);
	assert.equal(first.leak, null);
	assert.equal(recordMaskedMail(file, { address: "x.y@paul.com", isNew: true, mailbox: "me@paul.com" }, "a@b.com", { keepNew: true, now }).file.addresses.at(-1)!.status, "on");

	const fine = recordMaskedMail(file, { address: "amazon.k7q2xm@paul.com", isNew: false, mailbox: "me@paul.com" }, "auto@marketplace.amazon.co.uk", { keepNew: false, now });
	assert.equal(fine.leak, null);
	assert.equal(fine.file.addresses[0].count, 4);
	const leaked = recordMaskedMail(file, { address: "amazon.k7q2xm@paul.com", isNew: false, mailbox: "me@paul.com" }, "deals@spammy.biz", { keepNew: false, now });
	assert.equal(leaked.leak, "spammy.biz");
	assert.equal(leaked.file.addresses[0].leak, "spammy.biz");
});

test("makes fresh addresses", () => {
	assert.equal(newMaskedAddress("paul.com", "https://www.Amazon.co.uk/signup", () => false, () => "k7q2xm9p"), "amazon.k7q2xm@paul.com");
	assert.equal(newMaskedAddress("paul.com", "Café Nero", () => false, () => "k7q2xm9p"), "cafenero.k7q2xm@paul.com");
	assert.equal(newMaskedAddress("paul.com", undefined, () => false, () => "k7q2xm9p"), "k7q2xm9p@paul.com");
	let n = 0;
	assert.equal(newMaskedAddress("paul.com", "", (a) => a === "aaaaaaaa@paul.com", () => (n++ ? "bbbbbbbb" : "aaaaaaaa")), "bbbbbbbb@paul.com");
	assert.match(newMaskedAddress("paul.com", "x", () => false), /^x\.[a-z2-9]{6}@paul\.com$/);
	assert.equal(siteFromLabel("Amazon"), null);
	assert.equal(siteFromLabel("shop.example.co.uk"), "example.co.uk");
});

test("refuses clashes and domains without masked email", () => {
	assert.equal(maskedProblem("new.one@paul.com", "me@paul.com", file, book, boxes), null);
	assert.match(maskedProblem("new.one@paul.com", "jo@paul.com", file, book, boxes)!, /doesn't have masked email/);
	assert.match(maskedProblem("hello@paul.com", "me@paul.com", file, book, boxes)!, /already in use/);
	assert.match(maskedProblem("jo@paul.com", "me@paul.com", file, book, boxes)!, /already in use/);
	assert.match(maskedProblem("gone.aaaa@paul.com", "me@paul.com", file, book, boxes)!, /already in use/);
});

test("leak header and deleting a mailbox", () => {
	assert.equal(leakFromHeaders(JSON.stringify([{ key: "X-Mail-App-Masked-Leak", value: "Spammy.biz" }])), "spammy.biz");
	assert.equal(leakFromHeaders("not json"), null);
	assert.deepEqual(maskedWithoutMailboxes(file, ["ME@paul.com"]), { domains: {}, addresses: [] });
});
