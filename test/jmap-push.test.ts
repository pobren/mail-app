import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_LIFE_MS, clampExpires, pushKeysProblem, pushUrlProblem, typesProblem, wantsDelivery } from "../shared/jmap-push.ts";

const b64 = (n: number) => Buffer.from(new Uint8Array(n).fill(7)).toString("base64url");

describe("JMAP push subscriptions", () => {
	it("only posts to public https addresses", () => {
		assert.equal(pushUrlProblem("https://push.jmapconnect.app/p/abc"), null);
		for (const bad of ["http://push.example.com/p", "https://localhost/p", "https://10.0.0.1/p", "https://[::1]/p", "https://intranet/p", "https://box.local/p", 42, "not a url"]) {
			assert.notEqual(pushUrlProblem(bad), null, String(bad));
		}
	});
	it("checks the app's encryption keys", () => {
		assert.equal(pushKeysProblem(null), null);
		assert.equal(pushKeysProblem({ p256dh: b64(65), auth: b64(16) }), null);
		assert.notEqual(pushKeysProblem({ p256dh: b64(64), auth: b64(16) }), null);
		assert.notEqual(pushKeysProblem({ p256dh: b64(65) }), null);
		assert.notEqual(pushKeysProblem("keys"), null);
	});
	it("keeps a subscription for at most 30 days", () => {
		const now = Date.parse("2026-11-20T12:00:00Z");
		assert.equal(clampExpires("2026-11-25T12:00:00Z", now), "2026-11-25T12:00:00Z");
		assert.equal(clampExpires("2027-06-01T00:00:00Z", now), new Date(now + MAX_LIFE_MS).toISOString().replace(/\.\d{3}Z$/, "Z"));
		assert.equal(clampExpires(null, now), new Date(now + MAX_LIFE_MS).toISOString().replace(/\.\d{3}Z$/, "Z"));
		assert.equal(clampExpires("2026-01-01T00:00:00Z", now), new Date(now + MAX_LIFE_MS).toISOString().replace(/\.\d{3}Z$/, "Z"));
	});
	it("knows which apps want to hear about new mail", () => {
		assert.equal(wantsDelivery({ types: null }), true);
		assert.equal(wantsDelivery({ types: ["EmailDelivery"] }), true);
		assert.equal(wantsDelivery({ types: ["CalendarEvent"] }), false);
		assert.equal(typesProblem(["Email"]), null);
		assert.notEqual(typesProblem("Email"), null);
	});
});
