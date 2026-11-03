// Mail App addition (not part of upstream Agentic Inbox).
// Turns a picture someone pastes, drops or picks into something small enough to sit in an email:
// photos are scaled down to at most 1600 pixels across and saved as JPEG; small PNGs and GIFs
// (which may be animated) are kept as they are.

const MAX_SIDE = 1600;
const KEEP_AS_IS_BYTES = 300 * 1024;
export const MAX_PICTURE_BYTES = 2 * 1024 * 1024;

export const isPicture = (file: File) => /^image\/(png|jpe?g|gif|webp)$/i.test(file.type);

function readAsDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result || ""));
		reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the picture"));
		reader.readAsDataURL(blob);
	});
}

/** A data: address for the picture, or null when it's still too big for an email. */
export async function pictureDataUrl(file: File): Promise<string | null> {
	const keep = file.type === "image/gif" || (file.size <= KEEP_AS_IS_BYTES && file.type !== "image/webp");
	if (keep) return file.size <= MAX_PICTURE_BYTES ? readAsDataUrl(file) : null;

	const bitmap = await createImageBitmap(file);
	const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	// White behind transparent areas, since JPEG has no transparency.
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
	if (!blob || blob.size > MAX_PICTURE_BYTES) return null;
	return readAsDataUrl(blob);
}
