// Mail App addition (not part of upstream Agentic Inbox).
// Sending a download-link password to the recipient another way, using the sender's own apps: the phone's
// share sheet, WhatsApp, or a text message. Nothing goes through Mail App's server, and the device decides which
// app opens (Messages on an iPhone or Mac, the texting app on Android, WhatsApp or WhatsApp Web).

export type ShareDevice = "iphone" | "android" | "mac" | "computer";

/** Which kind of device this is, from the browser's user agent. */
export function shareDevice(ua: string, touchPoints = 0): ShareDevice {
	if (/iPhone|iPad|iPod/.test(ua)) return "iphone";
	// iPads ask for the desktop site, so they say Macintosh but have a touch screen.
	if (/Macintosh/.test(ua) && touchPoints > 1) return "iphone";
	if (/Android/.test(ua)) return "android";
	if (/Mac OS X|Macintosh/.test(ua)) return "mac";
	return "computer";
}

export type ShareOption = "share" | "whatsapp" | "sms" | "copy";

/** The buttons to show: the share sheet on phones, WhatsApp and Copy on computers, and Text message on a Mac too. */
export function shareOptions(device: ShareDevice, canShare: boolean): ShareOption[] {
	if (device === "iphone" || device === "android") return canShare ? ["share", "copy"] : ["whatsapp", "sms", "copy"];
	if (device === "mac") return ["whatsapp", "sms", "copy"];
	return ["whatsapp", "copy"];
}

/** A WhatsApp link with the message typed in; the sender picks who it goes to. */
export function whatsappUrl(text: string): string {
	return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** A text-message link with the message typed in. Apple and Android write the body part differently. */
export function smsUrl(text: string, device: ShareDevice): string {
	const apple = device === "iphone" || device === "mac";
	return `sms:${apple ? "&" : "?"}body=${encodeURIComponent(text)}`;
}
