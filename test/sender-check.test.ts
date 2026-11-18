import { test } from "node:test";
import assert from "node:assert/strict";
import { FIRST_CONTACT_HEADER, lookalikeOf, senderCheck, siteDomain } from "../shared/sender-check.ts";

const cf = (v: string) => ({ key: "authentication-results", value: `mx.cloudflare.net; ${v}` });

test("reads SPF, DKIM and DMARC from Cloudflare's header only", () => {
	const c = senderCheck("a@example.com", JSON.stringify([cf("dkim=pass header.d=example.com; dmarc=pass; spf=pass")]));
	assert.equal(c.status, "verified");
	assert.deepEqual([c.spf, c.dkim, c.dmarc], ["pass", "pass", "pass"]);
	const forged = senderCheck("a@example.com", [{ key: "authentication-results", value: "evil.example; dmarc=pass" }]);
	assert.equal(forged.status, "unknown");
	assert.equal(senderCheck("a@example.com", [cf("dmarc=fail; spf=softfail")]).status, "failed");
	assert.equal(senderCheck("a@example.com", [cf("dmarc=fail; spf=softfail")]).spf, "fail");
	assert.equal(senderCheck("a@example.com", "not json").status, "unknown");
});

test("ARC header with an i= prefix counts", () => {
	const c = senderCheck("a@example.com", [{ key: "ARC-Authentication-Results", value: "i=1; mx.cloudflare.net; dmarc=pass" }]);
	assert.equal(c.status, "verified");
});

test("first contact comes from our own header", () => {
	assert.equal(senderCheck("a@example.com", [{ key: FIRST_CONTACT_HEADER, value: "1" }]).firstContact, true);
	assert.equal(senderCheck("a@example.com", []).firstContact, false);
});

test("lookalike domains", () => {
	assert.equal(lookalikeOf("paypa1.com"), "paypal.com");
	assert.equal(lookalikeOf("rnicrosoft.com"), "microsoft.com");
	assert.equal(lookalikeOf("paypal-security.com"), "paypal.com");
	assert.equal(lookalikeOf("paypa1-secure.com"), "paypal.com");
	assert.equal(lookalikeOf("secure-rnicrosoft.co.uk"), "microsoft.com");
	assert.equal(lookalikeOf("mail.paypal.com"), null);
	assert.equal(lookalikeOf("sun-studio.com"), null);
	assert.equal(lookalikeOf("office-supplies.co.uk"), null);
	assert.equal(lookalikeOf("offices.com"), null);
	assert.equal(lookalikeOf("apple-farm.co.uk"), null);
	assert.equal(lookalikeOf("app1e.com"), "apple.com");
	assert.equal(lookalikeOf("amazom.co.uk"), "amazon.com");
	assert.equal(lookalikeOf("paypal.com"), null);
	assert.equal(lookalikeOf("northwind-design.co.uk"), null);
	assert.equal(lookalikeOf("example.com"), null);
	assert.equal(lookalikeOf("gmail.co"), null);
});

test("site domain", () => {
	assert.equal(siteDomain("mail.example.co.uk"), "example.co.uk");
	assert.equal(siteDomain("a.b.example.com"), "example.com");
});
