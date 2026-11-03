import { test } from "node:test";
import assert from "node:assert/strict";
import { shareDevice, shareOptions, smsUrl, whatsappUrl } from "../app/lib/share-password.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

test("tells devices apart", () => {
	assert.equal(shareDevice(IPHONE), "iphone");
	assert.equal(shareDevice(ANDROID), "android");
	assert.equal(shareDevice(MAC), "mac");
	assert.equal(shareDevice(MAC, 5), "iphone");
	assert.equal(shareDevice(WINDOWS), "computer");
});

test("picks the buttons for each device", () => {
	assert.deepEqual(shareOptions("iphone", true), ["share", "copy"]);
	assert.deepEqual(shareOptions("android", false), ["whatsapp", "sms", "copy"]);
	assert.deepEqual(shareOptions("mac", true), ["whatsapp", "sms", "copy"]);
	assert.deepEqual(shareOptions("computer", true), ["whatsapp", "copy"]);
});

test("builds links with the message typed in", () => {
	assert.equal(whatsappUrl("Password: a&b c"), "https://wa.me/?text=Password%3A%20a%26b%20c");
	assert.equal(smsUrl("hi there", "iphone"), "sms:&body=hi%20there");
	assert.equal(smsUrl("hi there", "android"), "sms:?body=hi%20there");
});
