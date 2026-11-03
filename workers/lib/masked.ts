// Mail App addition (not part of upstream Agentic Inbox).
// Reads and saves the install's masked email (shared/masked.ts) in R2, and lists every address a
// mailbox may send from, masked ones included.
import { sendableAddresses } from "../../shared/addresses";
import { MASKED_KEY, cleanMaskedFile, sendableMasked, type MaskedFile } from "../../shared/masked";
import { loadAddressBook } from "./addresses";

export async function loadMasked(bucket: R2Bucket): Promise<MaskedFile> {
	try {
		const obj = await bucket.get(MASKED_KEY);
		return cleanMaskedFile(obj ? await obj.json() : null);
	} catch {
		return cleanMaskedFile(null);
	}
}

export async function saveMasked(bucket: R2Bucket, file: MaskedFile): Promise<void> {
	await bucket.put(MASKED_KEY, JSON.stringify(cleanMaskedFile(file)), { httpMetadata: { contentType: "application/json" } });
}

/** The mailbox's own address, its extra addresses, then the masked addresses it can reply from. */
export async function sendableFor(bucket: R2Bucket, mailboxId: string): Promise<string[]> {
	const [book, masked] = await Promise.all([loadAddressBook(bucket), loadMasked(bucket)]);
	return [...sendableAddresses(book, mailboxId), ...sendableMasked(masked, mailboxId)];
}
