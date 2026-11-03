// Scheduled send: which times can be chosen, and the words when one couldn't go (shared/scheduled.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SCHEDULE_AHEAD_MS, failedWords, scheduledKey, validSendAt } from "../shared/scheduled.ts";

const NOW = Date.UTC(2026, 9, 25, 12);

test("send times must be a minute to a year ahead", () => {
	assert.equal(validSendAt(NOW + 3_600_000, NOW), true);
	assert.equal(validSendAt(NOW + 30_000, NOW), false);
	assert.equal(validSendAt(NOW - 3_600_000, NOW), false);
	assert.equal(validSendAt(NOW + MAX_SCHEDULE_AHEAD_MS + 1, NOW), false);
	assert.equal(validSendAt("tomorrow", NOW), false);
	assert.equal(validSendAt(Number.NaN, NOW), false);
});

test("where it waits, and what a failure says", () => {
	assert.equal(scheduledKey("Sam@Example.com", "abc"), "scheduled/sam@example.com/abc.json");
	const w = failedWords("  ", "Cloudflare refused it.");
	assert.equal(w.title, "A scheduled email wasn't sent");
	assert.match(w.body, /“\(no subject\)”: Cloudflare refused it\. It's in Drafts\./);
});

