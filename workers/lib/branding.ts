// Mail App addition (not part of upstream Agentic Inbox).
// Branding (see shared/branding.ts), in R2 at setup/branding.json, and the logo at setup/branding-logo.
import { MAX_LOGO_BYTES, cleanBranding, sniffLogo, type Branding } from "../../shared/branding";

const KEY = "setup/branding.json";
const LOGO_KEY = "setup/branding-logo";

export async function loadBranding(bucket: R2Bucket | undefined): Promise<Branding> {
	try {
		const obj = bucket ? await bucket.get(KEY) : null;
		return cleanBranding(obj ? await obj.json() : null);
	} catch {
		return cleanBranding(null);
	}
}

export async function saveBranding(bucket: R2Bucket, branding: Branding): Promise<void> {
	await bucket.put(KEY, JSON.stringify(branding), { httpMetadata: { contentType: "application/json" } });
}

/** Saves a new logo, keeping the rest. Says what was wrong with the file if it can't be used. */
export async function saveLogo(bucket: R2Bucket, bytes: Uint8Array, size: { width: number; height: number }): Promise<Branding | { error: string }> {
	if (!bytes.byteLength) return { error: "That file is empty." };
	if (bytes.byteLength > MAX_LOGO_BYTES) return { error: "That logo is over 200 KB. Please use a smaller file." };
	const type = sniffLogo(bytes);
	if (!type) return { error: "Please use a PNG, SVG or WebP file." };
	await bucket.put(LOGO_KEY, bytes, { httpMetadata: { contentType: type } });
	const next = cleanBranding({ ...(await loadBranding(bucket)), logo: { type, ...size, version: Date.now().toString(36) } });
	await saveBranding(bucket, next);
	return next;
}

export async function removeLogo(bucket: R2Bucket): Promise<Branding> {
	await bucket.delete(LOGO_KEY);
	const next = { ...(await loadBranding(bucket)), logo: null };
	await saveBranding(bucket, next);
	return next;
}

/**
 * The logo for the browser. An SVG can carry scripts, so it's sent with a policy that stops anything in
 * it running, even if someone opens it on its own.
 */
export async function logoResponse(bucket: R2Bucket): Promise<Response> {
	const [branding, obj] = await Promise.all([loadBranding(bucket), bucket.get(LOGO_KEY)]);
	if (!obj || !branding.logo) return new Response("Not found", { status: 404 });
	return new Response(obj.body, {
		headers: {
			"content-type": branding.logo.type,
			"cache-control": "private, max-age=86400",
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
			"x-content-type-options": "nosniff",
		},
	});
}
