import { test } from "node:test";
import assert from "node:assert/strict";
import { addDomains, cleanDomainName, cleanDomainsFile } from "../shared/domains.ts";

test("cleans the stored list of added domains", () => {
	assert.deepEqual(cleanDomainsFile(null), { domains: [] });
	assert.deepEqual(cleanDomainsFile({ domains: [{ name: "Example.org.", added: "2026-10-14" }, { name: "example.org" }, { name: "not a domain" }, null] }), {
		domains: [{ name: "example.org", added: "2026-10-14" }],
	});
	assert.equal(cleanDomainName(" Example.ORG "), "example.org");
	assert.equal(cleanDomainName("localhost"), null);
});

test("adding domains keeps the ones already there", () => {
	const file = cleanDomainsFile({ domains: [{ name: "example.net", added: "2026-10-14" }] });
	assert.deepEqual(addDomains(file, ["example.net", "example.org", "example.org", "bad"], "2026-10-15"), {
		domains: [{ name: "example.net", added: "2026-10-14" }, { name: "example.org", added: "2026-10-15" }],
	});
});
