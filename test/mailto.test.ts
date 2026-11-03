import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMailto } from "../shared/mailto.ts";

test("plain address", () => {
	assert.deepEqual(parseMailto("mailto:hannah@example.com"), { to: "hannah@example.com", cc: "", subject: "", body: "" });
});

test("subject, body, cc and extra to", () => {
	const m = parseMailto("mailto:a@x.com,b@x.com?to=c@x.com&cc=d%40x.com&subject=Hello%20there&body=Line%201%0D%0ALine%202");
	assert.equal(m.to, "a@x.com, b@x.com, c@x.com");
	assert.equal(m.cc, "d@x.com");
	assert.equal(m.subject, "Hello there");
	assert.equal(m.body, "Line 1\r\nLine 2");
});

test("no address, broken escapes", () => {
	const m = parseMailto("MAILTO:?subject=50%");
	assert.equal(m.to, "");
	assert.equal(m.subject, "50%");
});
