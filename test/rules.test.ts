import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRules, bodyText, cleanRules, ruleMatches, type InboxRule, type RuleMessage } from "../shared/rules.ts";

const mail: RuleMessage = {
	sender: "statements@mybank.co.uk",
	senderName: "My Bank",
	recipients: ["paul@example.com", "shop@example.com"],
	subject: "Your October Statement",
	body: "<p>Hello,&nbsp;your <b>invoice</b> is ready.</p><style>.x{color:red}</style>",
	hasAttachment: true,
};

const rule = (over: Partial<InboxRule>): InboxRule => ({ id: "r1", enabled: true, match: "all", conditions: [], actions: { markRead: true }, ...over });

test("each field matches with contains, ignoring capitals", () => {
	assert.ok(ruleMatches(rule({ conditions: [{ field: "from", value: "MYBANK.co.uk" }] }), mail));
	assert.ok(ruleMatches(rule({ conditions: [{ field: "from", value: "my bank" }] }), mail), "display name counts");
	assert.ok(ruleMatches(rule({ conditions: [{ field: "to", value: "shop@" }] }), mail));
	assert.ok(ruleMatches(rule({ conditions: [{ field: "subject", value: "statement" }] }), mail));
	assert.ok(ruleMatches(rule({ conditions: [{ field: "body", value: "your invoice is" }] }), mail), "tags and &nbsp; ignored");
	assert.ok(!ruleMatches(rule({ conditions: [{ field: "body", value: "color" }] }), mail), "style blocks ignored");
	assert.ok(ruleMatches(rule({ conditions: [{ field: "attachment" }] }), mail));
	assert.ok(!ruleMatches(rule({ conditions: [{ field: "attachment" }] }), { ...mail, hasAttachment: false }));
});

test("all and any", () => {
	const conditions = [{ field: "from" as const, value: "mybank" }, { field: "subject" as const, value: "nope" }];
	assert.ok(!ruleMatches(rule({ conditions }), mail));
	assert.ok(ruleMatches(rule({ conditions, match: "any" }), mail));
});

test("switched-off rules and empty rules never match", () => {
	assert.ok(!ruleMatches(rule({ enabled: false, conditions: [{ field: "from", value: "mybank" }] }), mail));
	assert.ok(!ruleMatches(rule({ conditions: [] }), mail));
	assert.ok(!ruleMatches(rule({ conditions: [{ field: "from", value: "  " }] }), mail));
});

test("labels add up and the first folder wins", () => {
	const out = applyRules([
		rule({ id: "a", conditions: [{ field: "from", value: "mybank" }], actions: { folder: "bank", labels: ["money"] } }),
		rule({ id: "b", conditions: [{ field: "subject", value: "statement" }], actions: { folder: "archive", labels: ["money", "important"], star: true } }),
		rule({ id: "c", conditions: [{ field: "subject", value: "nothing" }], actions: { markRead: true } }),
	], mail);
	assert.equal(out.folder, "bank");
	assert.deepEqual(out.labels, ["money", "important"]);
	assert.equal(out.star, true);
	assert.equal(out.markRead, false);
	assert.deepEqual(out.matched, ["a", "b"]);
	assert.deepEqual(applyRules(undefined, mail), { labels: [], markRead: false, star: false, matched: [] });
});

test("cleanRules tidies what's stored and drops rules that can't do anything", () => {
	const clean = cleanRules([
		{ id: "keep", name: "  Bank  ", match: "any", conditions: [{ field: "from", value: " mybank " }, { field: "nonsense", value: "x" }, { field: "attachment", value: "ignored" }], actions: { folder: "bank", labels: ["a", "a", 5], extra: 1 } },
		{ id: "no-action", conditions: [{ field: "from", value: "x" }], actions: {} },
		{ id: "no-condition", conditions: [{ field: "from", value: "" }], actions: { star: true } },
		{ id: "keep", conditions: [{ field: "to", value: "x" }], actions: { markRead: true } },
		"junk",
	]);
	assert.equal(clean.length, 2);
	assert.deepEqual(clean[0], { id: "keep", name: "Bank", enabled: true, match: "any", conditions: [{ field: "from", value: "mybank" }, { field: "attachment" }], actions: { folder: "bank", labels: ["a"] } });
	assert.notEqual(clean[1].id, "keep", "a repeated id gets a new one");
	assert.deepEqual(cleanRules(null), []);
});

test("bodyText", () => {
	assert.equal(bodyText("<div>a&amp;b</div>\n\n<p>c</p>").trim(), "a&b c");
});
