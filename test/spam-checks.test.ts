import { test } from "node:test";
import assert from "node:assert/strict";
import { SPAM_THRESHOLD, checkLinks, checkName, readReasonHeader, reasonFromHeaders, reasonHeaderValue, siteOf, spamChecks, spamScore } from "../shared/spam-checks.ts";

const checks = (found: { check: string }[]) => found.map((f) => f.check).sort();

test("siteOf keeps two-part endings together", () => {
	assert.equal(siteOf("mail.bank.co.uk"), "bank.co.uk");
	assert.equal(siteOf("a.b.example.com"), "example.com");
	assert.equal(siteOf("example.com"), "example.com");
});

test("links that say one site and go to another", () => {
	assert.deepEqual(checks(checkLinks(`<a href="https://evil.example/login">www.paypal.com</a>`)), ["lying-link"]);
	assert.deepEqual(checkLinks(`<a href="https://www.paypal.com/x">https://paypal.com</a>`), [], "same site");
	assert.deepEqual(checkLinks(`<a href="https://login.mybank.co.uk/">mybank.co.uk</a>`), [], "subdomain of the same site");
	assert.deepEqual(checkLinks(`<a href="https://shop.us1.list-manage.com/track?u=1">www.shop.com</a>`), [], "newsletter click counter");
	assert.deepEqual(checkLinks(`<a href="https://evil.example/">Click here</a>`), [], "ordinary words");
	assert.deepEqual(checks(checkLinks(`<a href='http://192.168.10.5/pay'>Pay now</a>`)), ["number-link"]);
});

test("names that pretend to be someone else", () => {
	assert.equal(checkName("x@cheap.ru", "service@paypal.com")?.points, 4);
	assert.equal(checkName("x@cheap.ru", "PayPal Support")?.detail, "PayPal");
	assert.equal(checkName("service@paypal.co.uk", "PayPal"), null);
	assert.equal(checkName("no-reply@hmrc.gov.uk", "HMRC"), null);
	assert.equal(checkName("jo@applefarm.co.uk", "Apple Tree Farm"), null);
	assert.equal(checkName("jo@friend.example", "Jo Bloggs"), null);
});

test("a typical scam reaches the threshold, ordinary mail doesn't", () => {
	const scam = spamChecks({
		sender: "alerts@secure-verify.example", senderName: "PayPal Security",
		subject: "URGENT: ACCOUNT SUSPENDED!!!",
		html: `<p>Your account has been suspended. Verify your account now.</p><a href="https://secure-verify.example/x">www.paypal.com</a>`,
	});
	assert.ok(spamScore(scam) >= SPAM_THRESHOLD, JSON.stringify(scam));
	assert.ok(checks(scam).includes("fake-name") && checks(scam).includes("lying-link"));

	const newsletter = spamChecks({
		sender: "news@shop.com", senderName: "Shop", subject: "Our autumn sale starts today",
		html: `<p>Hello, our sale is on. Up to 30% off coats.</p><a href="https://click.shop.com/t">Shop now</a>`,
		replyTo: "help@shop-support.com",
	});
	assert.ok(spamScore(newsletter) < SPAM_THRESHOLD);

	const friend = spamChecks({ sender: "jo@friend.example", senderName: "Jo", subject: "Lunch?", text: "Fancy lunch on Friday?" });
	assert.deepEqual(friend, []);
});

test("brand-new domains add points, unknown age doesn't", () => {
	assert.deepEqual(checks(spamChecks({ sender: "a@new.example", subject: "Hi", text: "hello", domainAgeDays: 3 })), ["new-domain"]);
	assert.deepEqual(spamChecks({ sender: "a@old.example", subject: "Hi", text: "hello", domainAgeDays: 900 }), []);
	assert.deepEqual(spamChecks({ sender: "a@old.example", subject: "Hi", text: "hello", domainAgeDays: null }), []);
});

test("spammy words count up to three points", () => {
	const found = spamChecks({ sender: "a@b.example", subject: "You've won the lottery", text: "Claim your prize, dear beneficiary, by wire transfer." });
	assert.equal(found.find((f) => f.check === "spammy-words")?.points, 3);
});

test("look-alike domains, picture-only mail and shouting", () => {
	assert.deepEqual(checks(spamChecks({ sender: "a@xn--pypal-4ve.com", subject: "Hello there", text: "a normal message" })), ["lookalike-domain"]);
	assert.deepEqual(checks(spamChecks({ sender: "a@b.example", subject: "Offer", html: `<img src="https://b.example/a.png">` })), ["picture-only"]);
	assert.deepEqual(checks(spamChecks({ sender: "a@b.example", subject: "BUY THIS AMAZING THING", text: "some words here" })), ["shouting"]);
});

test("the reason header round-trips", () => {
	const value = reasonHeaderValue([{ check: "lying-link" }, { check: "fake-name", detail: "Royal Mail" }]);
	assert.deepEqual(readReasonHeader(value), [{ check: "lying-link" }, { check: "fake-name", detail: "Royal Mail" }]);
	assert.deepEqual(reasonFromHeaders(JSON.stringify([{ key: "X-Mail-App-Spam", value: "blocked" }])), [{ check: "blocked" }]);
	assert.deepEqual(reasonFromHeaders("not json"), []);
});
