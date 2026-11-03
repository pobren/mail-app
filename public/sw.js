// Mail App, 2026: the service worker for Mail App as an app on your Dock or home screen. It shows
// new-mail notifications and opens the right email when you click one. It doesn't keep copies of
// your mail: everything still comes fresh from your own install.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Chrome and Edge only offer to install a site that has a fetch handler. This one lets every
// request through untouched.
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
	let data = {};
	try { data = event.data ? event.data.json() : {}; } catch { /* a push with no details */ }
	const title = data.title || "New email";
	const work = [
		self.registration.showNotification(title, {
			body: data.body || "",
			// No tag: a tag would make each new email quietly replace the last notification instead of
			// showing (and sounding) a new one.
			icon: "/icon-192.png",
			badge: "/icon-192.png",
			data: { url: data.url || "/" },
		}),
	];
	if (typeof data.unread === "number" && "setAppBadge" in self.navigator) {
		work.push(data.unread > 0 ? self.navigator.setAppBadge(data.unread) : self.navigator.clearAppBadge());
	}
	// Tells an open Mail App window, so its inbox and counts update straight away.
	work.push(self.clients.matchAll({ type: "window" }).then((open) => open.forEach((c) => c.postMessage({ type: "new-mail" }))));
	event.waitUntil(Promise.all(work).catch(() => {}));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
	event.waitUntil((async () => {
		const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		for (const client of open) {
			if (new URL(client.url).origin === self.location.origin && "focus" in client) {
				await client.focus();
				if ("navigate" in client) await client.navigate(url).catch(() => {});
				return;
			}
		}
		await self.clients.openWindow(url);
	})());
});
