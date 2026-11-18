import { test } from "node:test";
import assert from "node:assert/strict";
import { unsubscribeFrom } from "../shared/unsubscribe.ts";

test("one-click when the post header is there", () => {
	const u = unsubscribeFrom([
		{ key: "List-Unsubscribe", value: "<mailto:leave@news.example.com?subject=stop>, <https://news.example.com/u/abc>" },
		{ key: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
	]);
	assert.equal(u?.oneClick, "https://news.example.com/u/abc");
	assert.equal(u?.mailto?.to, "leave@news.example.com");
	assert.equal(u?.mailto?.subject, "stop");
});

test("a link without the post header is opened, not posted", () => {
	const u = unsubscribeFrom(JSON.stringify([{ key: "list-unsubscribe", value: "<https://news.example.com/u/abc>" }]));
	assert.equal(u?.oneClick, null);
	assert.equal(u?.url, "https://news.example.com/u/abc");
});

test("http links and nonsense are ignored", () => {
	assert.equal(unsubscribeFrom([{ key: "List-Unsubscribe", value: "<http://insecure.example.com/u>" }]), null);
	assert.equal(unsubscribeFrom([{ key: "List-Unsubscribe", value: "<mailto:not-an-address>" }]), null);
	assert.equal(unsubscribeFrom([]), null);
	assert.equal(unsubscribeFrom(null), null);
});
