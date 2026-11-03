import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanForwarding, copyFromName, forwardingProblem, shouldForward, FORWARDED_HEADER } from "../shared/forwarding.ts";

test("settings are cleaned, and forwarding needs a real address to be on", () => {
	assert.deepEqual(cleanForwarding(undefined), { enabled: false, email: "", keepCopy: true, includeSpam: false });
	assert.deepEqual(cleanForwarding({ enabled: true, email: " Paul@Gmail.com " }), { enabled: true, email: "paul@gmail.com", keepCopy: true, includeSpam: false });
	assert.equal(cleanForwarding({ enabled: true, email: "not an address" }).enabled, false);
	assert.equal(cleanForwarding({ enabled: true, email: "a@b.com", keepCopy: false }).keepCopy, false);
	// The old placeholder from new mailboxes.
	assert.deepEqual(cleanForwarding({ enabled: false, email: "" }), { enabled: false, email: "", keepCopy: true, includeSpam: false });
});

test("own address and own domains are refused", () => {
	const domains = ["example.com", "example.co.uk"];
	assert.equal(forwardingProblem("someone@gmail.com", "paul@example.com", domains), null);
	assert.match(forwardingProblem("paul@example.com", "paul@example.com", domains)!, /own address/);
	assert.match(forwardingProblem("hello@EXAMPLE.co.uk", "paul@example.com", domains)!, /own domains/);
	assert.match(forwardingProblem("nope", "paul@example.com", domains)!, /Enter the email address/);
});

test("spam and mail this mailbox already forwarded are not forwarded", () => {
	const on = { enabled: true, email: "x@gmail.com", keepCopy: true, includeSpam: false };
	const mail = { isSpam: false, mailboxId: "paul@example.com", headers: [{ key: "subject", value: "Hi" }] };
	assert.equal(shouldForward(on, mail), true);
	assert.equal(shouldForward({ ...on, enabled: false }, mail), false);
	assert.equal(shouldForward(on, { ...mail, isSpam: true }), false);
	// "Forward spam too", for trying Mail App alongside an old email service.
	assert.equal(shouldForward({ ...on, includeSpam: true }, { ...mail, isSpam: true }), true);
	assert.equal(cleanForwarding({ enabled: true, email: "a@b.com", includeSpam: true }).includeSpam, true);
	assert.equal(shouldForward(on, { ...mail, headers: [{ key: FORWARDED_HEADER, value: "other@example.com, paul@example.com" }] }), false);
	assert.equal(shouldForward(on, { ...mail, headers: [{ key: FORWARDED_HEADER, value: "other@example.com" }] }), true);
});

test("a copy is named after who wrote it", () => {
	assert.equal(copyFromName("Jane \"JJ\" Smith", "jane@x.com"), "Jane JJ Smith via Mail App");
	assert.equal(copyFromName(null, "jane@x.com"), "jane@x.com via Mail App");
});
