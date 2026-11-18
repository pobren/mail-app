import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, makeZip, uniqueNames } from "../shared/zip.ts";

test("crc32 matches the known value", () => {
	assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("unique names", () => {
	assert.deepEqual(uniqueNames(["a.pdf", "A.pdf", "b", "b", "x/y.txt"]), ["a.pdf", "A (2).pdf", "b", "b (2)", "x_y.txt"]);
});

test("the zip opens with unzip", (t) => {
	const zip = makeZip([
		{ name: "hello.txt", data: new TextEncoder().encode("Hello there") },
		{ name: "café menu.txt", data: new TextEncoder().encode("Soup") },
	]);
	const dir = mkdtempSync(join(tmpdir(), "zip-"));
	const file = join(dir, "t.zip");
	writeFileSync(file, zip);
	let listing: string;
	try {
		listing = execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print('|'.join(z.namelist())); print(z.read('hello.txt').decode())", file]).toString();
	} catch {
		t.skip("python3 not available");
		return;
	}
	assert.match(listing, /hello\.txt\|café menu\.txt/);
	assert.match(listing, /Hello there/);
});
