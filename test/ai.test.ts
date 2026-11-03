import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_MODELS, aiModelFor, DEFAULT_AI_MODEL, isAiEnabled } from "../shared/ai.ts";

test("the AI assistant is off unless the mailbox has switched it on", () => {
	assert.equal(isAiEnabled(null), false);
	assert.equal(isAiEnabled({}), false);
	assert.equal(isAiEnabled({ aiEnabled: "true" }), false);
	assert.equal(isAiEnabled({ aiEnabled: false }), false);
	assert.equal(isAiEnabled({ aiEnabled: true }), true);
});

test("an unknown or missing model falls back to the default", () => {
	assert.equal(aiModelFor(null), DEFAULT_AI_MODEL);
	assert.equal(aiModelFor({ aiModel: "@cf/someone/else" }), DEFAULT_AI_MODEL);
	assert.equal(aiModelFor({ aiModel: AI_MODELS[1].id }), AI_MODELS[1].id);
});
