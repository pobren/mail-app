// A small PNG encoder for Workers (no canvas there): CompressionStream does the deflate.

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
	// "deflate" is the zlib format, which is what PNG's image data uses.
	const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A PNG from rows that each start with a filter byte of 0: colour type 0 is 8-bit greyscale (one byte a pixel),
 * 6 is 8-bit RGBA (four). Used by the QR codes (site/src/qr-image.ts) and the home screen icons (letter-icon.ts).
 */
export async function png(width: number, height: number, colourType: 0 | 6, raw: Uint8Array): Promise<Uint8Array> {
	const head = new Uint8Array(13);
	const hv = new DataView(head.buffer);
	hv.setUint32(0, width);
	hv.setUint32(4, height);
	head.set([8, colourType, 0, 0, 0], 8); // 8-bit, deflate, no filter variants, not interlaced
	const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", await deflate(raw)), chunk("IEND", new Uint8Array())];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let i = 0;
	for (const p of parts) { out.set(p, i); i += p.length; }
	return out;
}
