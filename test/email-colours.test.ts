import { test } from "node:test";
import assert from "node:assert/strict";
import { setsOwnColours } from "../shared/email-colours.ts";

test("plain emails can go dark", () => {
	assert.equal(setsOwnColours("<p>Hi Paul,</p><p>Thanks, <b>Sarah</b></p>"), false);
	assert.equal(setsOwnColours('<div style="border-color: red; margin: 0">x</div>'), false);
	assert.equal(setsOwnColours('<a href="https://example.com/color:red">link</a>'), false);
});

test("designed emails keep their look", () => {
	assert.equal(setsOwnColours('<table bgcolor="#ffffff"><tr><td>x</td></tr></table>'), true);
	assert.equal(setsOwnColours('<div style="background-color:#fff">x</div>'), true);
	assert.equal(setsOwnColours('<p style="color: #333">x</p>'), true);
	assert.equal(setsOwnColours('<font color="red">x</font>'), true);
});
