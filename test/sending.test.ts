import { test } from "node:test";
import assert from "node:assert/strict";
import { afterCheck, afterSend, checkDue, sendFailureText, sendProblem } from "../shared/sending.ts";

const err = (code: string | undefined, message: string) => Object.assign(new Error(message), code ? { code } : {});

test("send errors are sorted into plan, domain or nothing", () => {
	assert.equal(sendProblem(err("E_SENDER_NOT_VERIFIED", "x")), "domain");
	assert.equal(sendProblem(err("E_SENDER_DOMAIN_NOT_AVAILABLE", "x")), "domain");
	assert.equal(sendProblem(err("E_RECIPIENT_NOT_ALLOWED", "x")), "plan");
	assert.equal(sendProblem(err("E_RATE_LIMIT_EXCEEDED", "slow down")), null);
	assert.equal(sendProblem(err("E_VALIDATION_ERROR", "bad address")), null);
	assert.equal(sendProblem(err(undefined, "Sending to unverified destination address requires the Workers Paid plan")), "plan");
	assert.equal(sendProblem(err(undefined, "network went away")), null);
});

test("a check that gets through marks sending as working", () => {
	const s = afterCheck("me@ex.com", "2026-10-12T10:00:00Z");
	assert.deepEqual(s, { state: "ok", from: "me@ex.com", checkedAt: "2026-10-12T10:00:00Z" });
});

test("a failed check names the problem, defaulting to the plan", () => {
	assert.equal(afterCheck("me@ex.com", "t", err("E_SENDER_DOMAIN_NOT_AVAILABLE", "no")).state, "domain");
	const s = afterCheck("me@ex.com", "t", err(undefined, "something odd"));
	assert.equal(s.state, "plan");
	assert.equal(s.detail, "something odd");
	// A fault in Mail App's own code isn't the account's problem.
	assert.equal(afterCheck("me@ex.com", "t", new TypeError("x is undefined")).state, "unknown");
});

test("everyday sends only record setup problems, and never mark sending as working", () => {
	assert.equal(afterSend({ state: "unknown" }, "me@ex.com"), null);
	assert.equal(afterSend({ state: "plan" }, "me@ex.com"), null);
	assert.equal(afterSend({ state: "ok" }, "me@ex.com", err("E_RATE_LIMIT_EXCEEDED", "x")), null);
	const s = afterSend({ state: "ok", checkedAt: "t" }, "me@ex.com", err("E_RECIPIENT_NOT_ALLOWED", "no"));
	assert.equal(s?.state, "plan");
	assert.equal(s?.checkedAt, "t");
	// The same failure again needs no new write.
	assert.equal(afterSend(s!, "me@ex.com", err("E_RECIPIENT_NOT_ALLOWED", "no")), null);
});

test("automatic checks run at most every 10 minutes, and never once sending works", () => {
	const now = Date.parse("2026-10-12T10:00:00Z");
	assert.equal(checkDue({ state: "unknown" }, now), true);
	assert.equal(checkDue({ state: "ok", checkedAt: "2026-10-01T00:00:00Z" }, now), false);
	assert.equal(checkDue({ state: "plan", checkedAt: "2026-10-12T09:55:00Z" }, now), false);
	assert.equal(checkDue({ state: "plan", checkedAt: "2026-10-12T09:49:00Z" }, now), true);
});

test("a refused send is explained in plain English", () => {
	assert.match(sendFailureText(err("E_RECIPIENT_NOT_ALLOWED", "x")), /\$5 a month/);
	assert.match(sendFailureText(err("E_SENDER_DOMAIN_NOT_AVAILABLE", "x")), /isn't switched on for sending/);
	assert.match(sendFailureText(err("E_RECIPIENT_SUPPRESSED", "x")), /bounced/);
	assert.match(sendFailureText(err(undefined, "Sending to unverified destination address requires the Workers Paid plan")), /\$5 a month/);
	assert.equal(sendFailureText(err("E_SOMETHING_NEW", "mailbox unavailable")), 'Not sent. Cloudflare refused this email and said: "E_SOMETHING_NEW: mailbox unavailable". Try again, and if it keeps happening ask your admin.');
	assert.match(sendFailureText(undefined), /without saying why/);
});
