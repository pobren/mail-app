// Mail App addition (not part of upstream Agentic Inbox).
// Reading and saving calendar-shares.json in R2 (see shared/calendar-shares.ts).

import { cleanShares, SHARES_KEY, type ShareBook } from "../../shared/calendar-shares";

export async function loadShares(bucket: R2Bucket): Promise<{ book: ShareBook; etag: string | null }> {
	const obj = await bucket.get(SHARES_KEY);
	if (!obj) return { book: cleanShares(null), etag: null };
	try {
		return { book: cleanShares(await obj.json()), etag: obj.etag };
	} catch {
		return { book: cleanShares(null), etag: obj.etag };
	}
}

/**
 * Changes the shares safely when two changes happen at once (as updatePeople does): only saves if
 * nobody else saved in between, otherwise tries again. `change` returns the new book, or a sentence
 * to stop with.
 */
export async function updateShares(bucket: R2Bucket, change: (book: ShareBook) => ShareBook | string): Promise<ShareBook | string> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const { book, etag } = await loadShares(bucket);
		const next = change(book);
		if (typeof next === "string") return next;
		const opts: R2PutOptions = { httpMetadata: { contentType: "application/json" } };
		// The very first save has nothing to compare with.
		if (etag) opts.onlyIf = { etagMatches: etag };
		const saved = await bucket.put(SHARES_KEY, JSON.stringify(cleanShares(next)), opts);
		if (saved) return next;
	}
	return "Sharing is busy. Please try again.";
}
