import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	addressesOf, flagsFromPatch, flattenFilter, folderFromPatch, fromJmapId, jsonPointer, keyFromAuthorization, keywordsOf,
	parseBlobId, previewOf, resolveBackRefs, roleOf, sortOf, textOf, toJmapId, type Invocation,
} from "../shared/jmap.ts";

describe("JMAP ids", () => {
	it("keeps safe ids and encodes the rest so they come back the same", () => {
		assert.equal(toJmapId("inbox"), "inbox");
		assert.equal(toJmapId("6f1c-AB_9"), "6f1c-AB_9");
		for (const id of ["abc@example.com", "<x.y@z>", "~tilde", "café"]) {
			const j = toJmapId(id);
			assert.match(j, /^~[A-Za-z0-9_-]+$/);
			assert.equal(fromJmapId(j), id);
		}
		assert.equal(fromJmapId("bad id"), null);
	});
});

describe("folders and keywords", () => {
	it("maps folders to roles", () => {
		assert.equal(roleOf("draft"), "drafts");
		assert.equal(roleOf("spam"), "junk");
		assert.equal(roleOf("receipts"), null);
	});
	it("turns read, starred and drafts into keywords", () => {
		assert.deepEqual(keywordsOf({ read: true, starred: true, folder: "draft" }), { $seen: true, $flagged: true, $draft: true });
		assert.deepEqual(keywordsOf({ read: false, starred: false, folder: "inbox" }), {});
	});
	it("reads keyword patches whole or by path", () => {
		assert.deepEqual(flagsFromPatch({ "keywords/$seen": true }), { read: true });
		assert.deepEqual(flagsFromPatch({ "keywords/$flagged": null }), { starred: false });
		assert.deepEqual(flagsFromPatch({ keywords: { $seen: true } }), { read: true, starred: false });
		assert.deepEqual(flagsFromPatch({ "keywords/$answered": true }), {});
	});
	it("reads moves", () => {
		assert.equal(folderFromPatch({ mailboxIds: { archive: true } }, "inbox"), "archive");
		assert.equal(folderFromPatch({ mailboxIds: { inbox: true } }, "inbox"), null);
		assert.equal(folderFromPatch({ mailboxIds: { a: true, b: true } }, "inbox"), "many");
		assert.equal(folderFromPatch({ "mailboxIds/inbox": null, "mailboxIds/trash": true }, "inbox"), "trash");
		assert.equal(folderFromPatch({ "keywords/$seen": true }, "inbox"), null);
	});
});

describe("text", () => {
	it("makes a preview without tags, hidden blocks or extra spaces", () => {
		const html = "<style>p{color:red}</style><p>Hello&nbsp;<b>there</b></p><script>x()</script><p>Second</p>";
		assert.equal(previewOf(html), "Hello there Second");
		assert.equal((previewOf("x".repeat(300))).length, 256);
		assert.equal(textOf("<p>One</p><p>Two</p>"), "One\nTwo");
		assert.equal(textOf("Plain <not a tag"), "Plain <not a tag");
	});
	it("lists addresses", () => {
		assert.deepEqual(addressesOf("a@x.com, b@y.com"), [{ name: null, email: "a@x.com" }, { name: null, email: "b@y.com" }]);
		assert.equal(addressesOf(""), null);
	});
});

describe("blob ids", () => {
	it("reads each kind", () => {
		assert.deepEqual(parseBlobId("Mabc"), { kind: "email", emailId: "abc" });
		assert.deepEqual(parseBlobId("Aabc.def"), { kind: "attachment", emailId: "abc", attachmentId: "def" });
		assert.deepEqual(parseBlobId("U123"), { kind: "upload", id: "123" });
		assert.deepEqual(parseBlobId("Habc"), { kind: "body", emailId: "abc", part: "html" });
		assert.equal(parseBlobId("A.x"), null);
		assert.equal(parseBlobId("M../x"), null);
	});
});

describe("queries", () => {
	it("flattens AND filters and refuses the rest", () => {
		assert.deepEqual(flattenFilter({ operator: "AND", conditions: [{ inMailbox: "inbox" }, { notKeyword: "$seen" }] }), { ok: true, filter: { inMailbox: "inbox", notKeyword: "$seen" } });
		assert.equal(flattenFilter({ operator: "OR", conditions: [] }).ok, false);
		assert.equal(flattenFilter({ header: ["x"] }).ok, false);
		assert.deepEqual(flattenFilter({ hasKeyword: "$important" }), { ok: true, filter: { hasKeyword: "$important", inMailbox: "\u0000none" } });
	});
	it("sorts newest first unless asked", () => {
		assert.deepEqual(sortOf(undefined), { property: "receivedAt", isAscending: false });
		assert.deepEqual(sortOf([{ property: "subject" }]), { property: "subject", isAscending: true });
		assert.equal(sortOf([{ property: "weird" }]), "unsupported");
	});
});

describe("requests", () => {
	it("follows result references", () => {
		const done: Invocation[] = [["Email/query", { ids: ["a", "b"] }, "q"], ["Thread/get", { list: [{ emailIds: ["x"] }, { emailIds: ["y", "z"] }] }, "t"]];
		assert.deepEqual(resolveBackRefs({ "#ids": { resultOf: "q", name: "Email/query", path: "/ids" } }, done), { ok: true, args: { ids: ["a", "b"] } });
		assert.deepEqual(resolveBackRefs({ "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" } }, done), { ok: true, args: { ids: ["x", "y", "z"] } });
		assert.equal(resolveBackRefs({ "#ids": { resultOf: "nope", name: "Email/query", path: "/ids" } }, done).ok, false);
		assert.equal(jsonPointer({ a: { "b/c": 1 } }, "/a/b~1c"), 1);
	});
	it("reads the key from Bearer or Basic", () => {
		assert.equal(keyFromAuthorization("Bearer mailapp_x"), "mailapp_x");
		assert.equal(keyFromAuthorization(`Basic ${btoa("me@x.com:mailapp_y")}`), "mailapp_y");
		assert.equal(keyFromAuthorization(null), null);
	});
});
