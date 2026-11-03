// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: PUBLIC_LINKS and PUBLIC_API; team access settings; passkey sign-in.

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	/** Mail App: "on" once a Cloudflare Access bypass rule lets people open /f/ download links without signing in. */
	PUBLIC_LINKS?: string;
	/** Mail App: "on" once the installer has let /api/ext/ past Cloudflare sign-in, so the API works. */
	PUBLIC_API?: string;
	/** Mail App: the address that installed Mail App, set at install. Becomes the first admin. */
	OWNER_EMAIL?: string;
	/** Mail App: a second address of the owner's, set at install, for when codes don't reach the first. */
	BACKUP_EMAIL?: string;
	/** "on" once the owner has pointed Cloudflare's sign-in rule at /access-check (workers/lib/access-check.ts). */
	ACCESS_CHECK?: string;
	/** Mail App: shared with Cloudflare Access once passkey sign-in is on (workers/lib/passkeys.ts). */
	PASSKEY_CLIENT_SECRET?: string;
	/**
	 * Mail App: lets the app keep the Cloudflare Access sign-in list up to date when people are
	 * invited or removed. A token for this one account that can only change Access settings, made by
	 * the owner (see the README). Without it, the Access policy has to be updated by hand.
	 */
	ACCESS_API_TOKEN?: string;
	ACCESS_POLICY_ID?: string;
	CF_ACCOUNT_ID?: string;
}
