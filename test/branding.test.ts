import { test } from "node:test";
import assert from "node:assert/strict";
import { brandColours, brandManifest, cleanBranding, cleanColour, contrastWithWhite, isBranded, logoIsIcon, rebrand, sniffLogo } from "../shared/branding.ts";

test("branding is cleaned, and Mail App's own name and red count as not set", () => {
	const b = cleanBranding({ name: "  Smith &  Jones <Mail> ", colour: "0F766E", supportEmail: " IT@SmithJones.co.uk ", logo: { type: "image/gif", version: "x" } });
	assert.equal(b.name, "Smith & Jones Mail");
	assert.equal(b.colour, "#0f766e");
	assert.equal(b.supportEmail, "it@smithjones.co.uk");
	assert.equal(b.logo, null);
	assert.deepEqual(cleanBranding({ name: "Mail App", colour: "#C8102E", supportEmail: "not an address" }), { name: "", colour: "", logo: null, supportEmail: "" });
	assert.equal(cleanColour("#abc"), "#aabbcc");
	assert.equal(cleanColour("red"), "");
});

test("a name or logo counts as branded; a colour on its own doesn't hide the app's own name", () => {
	assert.equal(isBranded(cleanBranding({ colour: "#1d4ed8" })), false);
	assert.equal(isBranded(cleanBranding({ name: "Acme Mail" })), true);
	assert.equal(rebrand("Install Mail App on Mail App", cleanBranding({ name: "Acme Mail" })), "Install Acme Mail on Acme Mail");
	assert.equal(rebrand("Install Mail App", cleanBranding(null)), "Install Mail App");
});

test("light colours are darkened until white writing is easy to read", () => {
	const yellow = brandColours("#facc15");
	assert.equal(yellow.darkened, true);
	assert.ok(contrastWithWhite(yellow.brand) >= 4.5);
	const teal = brandColours("#0f766e");
	assert.equal(teal.brand, "#0f766e");
	assert.equal(teal.darkened, false);
	assert.equal(brandColours("").brand, "#c8102e");
});

test("logos are recognised by their contents, not their name", () => {
	assert.equal(sniffLogo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
	assert.equal(sniffLogo(new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")), "image/webp");
	assert.equal(sniffLogo(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), "image/svg+xml");
	assert.equal(sniffLogo(new TextEncoder().encode("<html><script>alert(1)</script></html>")), null);
	assert.equal(sniffLogo(new Uint8Array([0x47, 0x49, 0x46, 0x38])), null);
});

test("only a square logo becomes the app icon", () => {
	assert.equal(logoIsIcon({ type: "image/png", width: 512, height: 512, version: "1" }), true);
	assert.equal(logoIsIcon({ type: "image/png", width: 600, height: 200, version: "1" }), false);
	assert.equal(logoIsIcon({ type: "image/png", width: 64, height: 64, version: "1" }), false);
	const base = { name: "Mail App", icons: [{ src: "/icon-192.png" }], shortcuts: [{ name: "Inbox", url: "/" }] };
	const wide = brandManifest(base, cleanBranding({ name: "Acme Mail", logo: { type: "image/png", width: 600, height: 200, version: "1" } }));
	assert.equal(wide.name, "Acme Mail");
	assert.deepEqual(wide.icons, base.icons);
	const square = brandManifest(base, cleanBranding({ name: "Acme Mail", colour: "#1d4ed8", logo: { type: "image/svg+xml", width: 100, height: 100, version: "abc" } }));
	assert.equal(square.theme_color, "#1d4ed8");
	assert.deepEqual(square.icons, [{ src: "/api/v1/branding/logo?v=abc", sizes: "any", type: "image/svg+xml", purpose: "any" }]);
});
