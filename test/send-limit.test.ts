import { test } from "node:test";
import assert from "node:assert/strict";
import { SEND_LIMITS, countRecipients, sendLimitError } from "../workers/lib/send-limit.ts";
import { sameSite } from "../workers/lib/same-site.ts";

test("every recipient counts, in to, cc and bcc", () => {
	assert.equal(countRecipients("a@x.com"), 1);
	assert.equal(countRecipients("a@x.com, b@x.com", ["c@x.com"], "d@x.com,e@x.com"), 5);
	assert.equal(countRecipients(undefined, null, "", []), 0);
});

test("the sending limit counts people, per email, per hour and per day", () => {
	assert.equal(sendLimitError(1, 0, 0), null);
	assert.match(sendLimitError(SEND_LIMITS.perEmail + 1, 0, 0)!, /at most 50 people/);
	assert.equal(sendLimitError(10, SEND_LIMITS.perHour - 10, 0), null);
	assert.match(sendLimitError(11, SEND_LIMITS.perHour - 10, 0)!, /an hour/);
	assert.match(sendLimitError(1, 0, SEND_LIMITS.perDay)!, /a day/);
});

test("changes only come from this app's own pages", () => {
	const app = new URL("https://mail.example.com/api/v1/x");
	assert.ok(sameSite(undefined, app), "apps and older browsers send no Origin");
	assert.ok(sameSite("https://mail.example.com", app));
	assert.ok(!sameSite("https://evil.example", app));
	assert.ok(!sameSite("not a url", app));
});
