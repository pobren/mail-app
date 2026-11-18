import { test } from "node:test";
import assert from "node:assert/strict";
import { removeHiddenBlocks, removeTags } from "../shared/html-text.ts";
import { bodyText } from "../shared/rules.ts";
import { htmlToText } from "../shared/mbox.ts";
import { newJitsiLink } from "../shared/invites.ts";

test("tags hidden inside other tags are removed too", () => {
	assert.ok(!removeTags("<scr<script>ipt>alert(1)").includes("<"));
	assert.equal(removeTags("a <b>bold</b> word"), "a bold word");
	assert.ok(!removeTags("<<a>img src=x onerror=y>").includes("<"));
});

test("script and style blocks go, even with odd closing tags", () => {
	assert.equal(removeHiddenBlocks("a<script>x()</script >b"), "ab");
	assert.equal(removeHiddenBlocks("a<SCRIPT type=x>x()</SCRIPT foo>b"), "ab");
	assert.equal(removeHiddenBlocks("a<sty<style>x</style>le>y</style>b"), "ab");
	assert.equal(removeHiddenBlocks("<header>keep</header>"), "<header>keep</header>");
});

test("entities are only decoded once", () => {
	assert.equal(bodyText("&amp;lt;b&amp;gt;").trim(), "&lt;b&gt;");
	assert.equal(htmlToText("<p>&amp;lt;tag&amp;gt;</p>"), "&lt;tag&gt;");
});

test("Jitsi room names are 14 letters from the safe alphabet", () => {
	for (let i = 0; i < 50; i++) assert.match(newJitsiLink(), /^https:\/\/meet\.jit\.si\/Mail-[a-km-np-z2-9]{14}$/);
});
