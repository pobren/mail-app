// Mail App addition (not part of upstream Agentic Inbox).
// The company details footer (see shared/company.ts), in R2 at setup/company.json.
import { cleanCompany, withCompanyFooter, type CompanyDetails } from "../../shared/company";

const KEY = "setup/company.json";

export async function loadCompany(bucket: R2Bucket): Promise<CompanyDetails> {
	try {
		const obj = await bucket.get(KEY);
		return cleanCompany(obj ? await obj.json() : null);
	} catch {
		return cleanCompany(null);
	}
}

export async function saveCompany(bucket: R2Bucket, details: CompanyDetails): Promise<void> {
	await bucket.put(KEY, JSON.stringify(details), { httpMetadata: { contentType: "application/json" } });
}

/** An outgoing email with the footer added, when it's switched on. A footer that can't be read is left off. */
export async function addCompanyFooter<T extends { html?: string; text?: string }>(bucket: R2Bucket, email: T): Promise<T> {
	return withCompanyFooter(email, await loadCompany(bucket));
}
