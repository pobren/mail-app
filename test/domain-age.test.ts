import { test } from "node:test";
import assert from "node:assert/strict";
import { domainAgeDays } from "../workers/lib/domain-age.ts";

const NOW = Date.parse("2026-10-14T12:00:00Z");

function fakeFetch(answers: Record<string, unknown>) {
	const asked: string[] = [];
	globalThis.fetch = (async (url: string) => {
		asked.push(String(url));
		const body = answers[String(url)];
		return body === undefined ? new Response("no", { status: 404 }) : Response.json(body);
	}) as typeof fetch;
	return asked;
}

const bootstrap = { services: [[["com", "net"], ["https://rdap.verisign.com/com/v1/"]], [["uk"], ["https://rdap.nominet.uk/uk/"]]] };

test("asks the domain's own registry and counts the days", async () => {
	const asked = fakeFetch({
		"https://data.iana.org/rdap/dns.json": bootstrap,
		"https://rdap.verisign.com/com/v1/domain/fresh.com": { events: [{ eventAction: "last changed", eventDate: "2026-10-13T00:00:00Z" }, { eventAction: "registration", eventDate: "2026-10-10T12:00:00Z" }] },
	});
	assert.equal(await domainAgeDays("fresh.com", NOW), 4);
	assert.deepEqual(asked, ["https://data.iana.org/rdap/dns.json", "https://rdap.verisign.com/com/v1/domain/fresh.com"]);
});

test("anything unknown is null, never a guess", async () => {
	fakeFetch({ "https://data.iana.org/rdap/dns.json": bootstrap });
	assert.equal(await domainAgeDays("missing.com", NOW), null, "registry has no answer");
	assert.equal(await domainAgeDays("thing.zz", NOW), null, "ending not in IANA's list");
	assert.equal(await domainAgeDays("localhost", NOW), null);
	globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
	assert.equal(await domainAgeDays("fresh.com", NOW), null, "network failure");
});
