import { test } from "node:test";
import assert from "node:assert/strict";
import {
	binExpiry, cleanFileName, cleanType, formatFileSize, monthlyCost, partCount, previewKind, servedType, sortItems, splitExtension, uniqueName,
	PART_BYTES, type FileItem,
} from "../shared/files.ts";

test("file names are cleaned", () => {
	assert.equal(cleanFileName("  Holiday   photo.jpg "), "Holiday photo.jpg");
	assert.equal(cleanFileName("a/b\\c.txt"), "a_b_c.txt");
	assert.equal(cleanFileName("bad\u0000name"), "bad_name");
	assert.equal(cleanFileName(".."), "");
	assert.equal(cleanFileName(42), "");
	assert.equal(cleanFileName("x".repeat(300)).length, 200);
});

test("extensions are split off", () => {
	assert.deepEqual(splitExtension("Report.final.pdf"), ["Report.final", ".pdf"]);
	assert.deepEqual(splitExtension(".env"), [".env", ""]);
	assert.deepEqual(splitExtension("Notes"), ["Notes", ""]);
});

test("taken names get a number, like a computer does", () => {
	assert.equal(uniqueName("Report.pdf", []), "Report.pdf");
	assert.equal(uniqueName("Report.pdf", ["report.PDF"]), "Report (2).pdf");
	assert.equal(uniqueName("Report.pdf", ["Report.pdf", "Report (2).pdf"]), "Report (3).pdf");
	assert.equal(uniqueName("Tax 2026.v2", ["Tax 2026.v2"], "folder"), "Tax 2026.v2 (2)");
});

test("only safe kinds are shown in the app", () => {
	assert.equal(previewKind("image/jpeg"), "image");
	assert.equal(previewKind("application/pdf"), "pdf");
	assert.equal(previewKind("video/mp4"), "video");
	assert.equal(previewKind("text/html", "page.html", 10), "text");
	assert.equal(previewKind("text/plain", "big.txt", 5 * 1024 * 1024), null);
	assert.equal(previewKind("application/zip"), null);
	// Web pages and SVG never run in the app: shown as text or saved.
	assert.equal(servedType("text/html", "page.html"), "text/plain; charset=utf-8");
	assert.equal(servedType("image/svg+xml", "logo.svg"), "application/octet-stream");
	assert.equal(servedType("application/x-msdownload", "setup.exe"), "application/octet-stream");
	assert.equal(servedType("image/png"), "image/png");
});

test("types are checked, or guessed from the name", () => {
	assert.equal(cleanType("image/PNG", "a.png"), "image/png");
	assert.equal(cleanType("", "photo.JPG"), "image/jpeg");
	assert.equal(cleanType("not a type", "thing.xyz"), "application/octet-stream");
});

test("big files go up in parts", () => {
	assert.equal(partCount(1), 1);
	assert.equal(partCount(PART_BYTES), 1);
	assert.equal(partCount(PART_BYTES + 1), 2);
	assert.equal(partCount(5 * 1024 ** 3), 103);
});

test("sizes, costs and Bin dates", () => {
	assert.equal(formatFileSize(512), "512 bytes");
	assert.equal(formatFileSize(1536), "2 KB");
	assert.equal(formatFileSize(4.2 * 1024 ** 2), "4.2 MB");
	assert.equal(monthlyCost(5 * 1024 ** 3), 0);
	assert.equal(monthlyCost(20 * 1024 ** 3).toFixed(3), "0.150");
	assert.equal(binExpiry("2026-10-01T00:00:00.000Z").toISOString(), "2026-10-31T00:00:00.000Z");
});

test("folders come first, then the chosen order", () => {
	const item = (over: Partial<FileItem>): FileItem => ({ id: over.name!, parentId: null, kind: "file", name: "", size: 0, type: "", createdAt: "", updatedAt: "2026-10-01", createdByName: null, binnedAt: null, ...over });
	const list = [item({ name: "b.txt", size: 5 }), item({ name: "Photos", kind: "folder" }), item({ name: "a10.txt", size: 1 }), item({ name: "a9.txt", size: 9 })];
	assert.deepEqual(sortItems(list, "name", true).map((i) => i.name), ["Photos", "a9.txt", "a10.txt", "b.txt"]);
	assert.deepEqual(sortItems(list, "size", false).map((i) => i.name), ["Photos", "a9.txt", "b.txt", "a10.txt"]);
});
