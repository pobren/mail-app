// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: added the /setup, /compose, contacts and label routes; the People page; All inboxes; the calendar; the Domains page; API & webhooks; the Users (was People), Routing, Backups and Reports pages; Files; Company details; Notes.

import {
	index,
	type RouteConfig,
	route,
} from "@react-router/dev/routes";

export default [
	index("routes/home.tsx"),
	route("setup", "routes/setup.tsx"),
	route("compose", "routes/compose.tsx"),
	route("users", "routes/people.tsx"),
	route("people", "routes/people-moved.tsx"),
	route("domains", "routes/domains.tsx"),
	route("routing", "routes/routing.tsx"),
	route("spam-filter", "routes/spam-filter.tsx"),
	route("backups", "routes/backups.tsx"),
	route("company", "routes/company.tsx"),
	route("branding", "routes/branding.tsx"),
	route("reports", "routes/reports.tsx"),
	route("developer", "routes/developer.tsx"),
	route("mailbox/:mailboxId", "routes/mailbox.tsx", [
		index("routes/mailbox-index.tsx"),
		route("emails/:folder", "routes/email-list.tsx"),
		route("labels/:labelId", "routes/email-list.tsx", { id: "routes/label-list" }),
		route("settings", "routes/settings.tsx"),
		route("contacts", "routes/contacts.tsx"),
		route("calendar", "routes/calendar.tsx"),
		route("files", "routes/files.tsx"),
		route("notes", "routes/notes.tsx"),
		route("search", "routes/search-results.tsx"),
		route("all-inboxes", "routes/all-inboxes.tsx"),
	]),
	route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
