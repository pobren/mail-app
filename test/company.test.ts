import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPANY_FOOTER_MARK, cleanCompany, companyFooterLines, withCompanyFooter } from "../shared/company.ts";

const company = cleanCompany({
	enabled: true,
	disclaimer: "  Example Ltd. Registered in England and Wales, company number 12345678.  \r\nRegistered office: 1 High Street, London AB1 2CD.\n\n\n\nThis email is confidential.\n",
});

test("the disclaimer is tidied, keeps its lines, and needs text to be on", () => {
	assert.equal(company.disclaimer, "Example Ltd. Registered in England and Wales, company number 12345678.\nRegistered office: 1 High Street, London AB1 2CD.\n\nThis email is confidential.");
	assert.equal(company.enabled, true);
	assert.equal(cleanCompany({ enabled: true, disclaimer: "  \n " }).enabled, false);
	assert.equal(cleanCompany(null).enabled, false);
	assert.deepEqual(companyFooterLines(company), [
		"Example Ltd. Registered in England and Wales, company number 12345678.",
		"Registered office: 1 High Street, London AB1 2CD.",
		"",
		"This email is confidential.",
	]);
});

test("details saved by the old form become the same footer", () => {
	const old = cleanCompany({ enabled: true, name: " Example Ltd ", number: "12345678", registeredIn: "england-wales", office: "1 High Street,\nLondon\nAB1 2CD", vat: "gb 123 4567 89" });
	assert.equal(old.enabled, true);
	assert.deepEqual(companyFooterLines(old), [
		"Example Ltd. Registered in England and Wales, company number 12345678.",
		"Registered office: 1 High Street, London, AB1 2CD.",
		"VAT number: GB 123 4567 89.",
	]);
	const scot = cleanCompany({ name: "Glen Ltd", number: "sc123456", registeredIn: "scotland", extra: "Authorised and regulated by the FCA" });
	assert.deepEqual(companyFooterLines(scot), ["Glen Ltd. Registered in Scotland, company number SC123456.", "Authorised and regulated by the FCA."]);
	assert.equal(cleanCompany({ enabled: true, name: "  " }).enabled, false);
});

test("goes at the end of a new email, once", () => {
	const out = withCompanyFooter({ html: "<p>Hello</p>", text: "Hello" }, company);
	assert.match(out.html!, /^<p>Hello<\/p><div data-app-company="1"/);
	assert.match(out.html!, /AB1 2CD\.<br><br>This email is confidential\./);
	assert.match(out.text!, /^Hello\n\n--\nExample Ltd\. Registered in England and Wales/);
	assert.equal(withCompanyFooter(out, company).html, out.html);
	assert.equal(out.html!.split(COMPANY_FOOTER_MARK).length, 2);
});

test("goes above the quoted email in a reply or forward", () => {
	const reply = '<p>Thanks</p><br><blockquote style="border-left: 2px solid #ccc; margin: 0;">On Mon, Jo wrote:<br><div data-app-company="1">Old Ltd</div></blockquote>';
	const out = withCompanyFooter({ html: reply, text: "Thanks\n\nOn Mon, Jo wrote:\n\nHi" }, company);
	assert.ok(out.html!.indexOf("Example Ltd") < out.html!.indexOf("<blockquote"));
	assert.ok(out.text!.indexOf("Example Ltd") < out.text!.indexOf("On Mon, Jo wrote:"));
	const fwd = '<p>FYI</p><div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>Forwarded message:</strong></div>';
	const outFwd = withCompanyFooter({ html: fwd }, company);
	assert.ok(outFwd.html!.indexOf("Example Ltd") < outFwd.html!.indexOf("Forwarded message"));
});

test("left off when switched off, and safe in HTML", () => {
	const email = { html: "<p>Hi</p>", text: "Hi" };
	assert.deepEqual(withCompanyFooter(email, { ...company, enabled: false }), email);
	assert.deepEqual(withCompanyFooter(email, null), email);
	const odd = cleanCompany({ enabled: true, disclaimer: "<b>Tom & Co</b>" });
	assert.match(withCompanyFooter(email, odd).html!, /&lt;b&gt;Tom &amp; Co&lt;\/b&gt;/);
});
