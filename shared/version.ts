// Mail App: release versions. Releases are numbered like "1.1" (small update) and "2.0" (big one); see
// shared/changelog.json. Installs from before numbering report a build like "2026.10.10-b8cf1f4".

/** Where the code lives. Releases, updates and help all come from here. */
export const REPO_URL = "https://github.com/pobren/mail-app";
/** The newest release notes, read now and then to tell admins about an update. */
export const LATEST_RELEASE_URL = "https://raw.githubusercontent.com/pobren/mail-app/main/shared/changelog.json";
/** How to update (the README's "Updating" section). */
export const UPDATE_URL = `${REPO_URL}#updating`;
export const CHANGES_URL = `${REPO_URL}/releases`;
/** How to set a domain up for sending (the README's "Sending email" section). */
export const SENDING_HELP_URL = `${REPO_URL}#sending-email`;

const NUMBERED_RE = /^(\d+)\.(\d+)(?:\.(\d+))?$/;
const BUILD_RE = /^(\d{4}\.\d{2}\.\d{2})-[0-9a-z]+$/;

/** True for "1.1" or "2.0.3", the versions people see. */
export function isNumberedVersion(v: unknown): v is string {
	return typeof v === "string" && NUMBERED_RE.test(v);
}

/** True when `latest` is a newer release than `current`. */
export function isNewerVersion(latest: unknown, current: unknown): boolean {
	if (typeof latest !== "string" || typeof current !== "string" || latest === current) return false;
	const l = NUMBERED_RE.exec(latest);
	if (l) {
		// Every numbered release is newer than the dated builds from before numbering.
		if (BUILD_RE.test(current)) return true;
		const c = NUMBERED_RE.exec(current);
		if (!c) return false;
		for (let i = 1; i <= 3; i++) {
			const a = Number(l[i] ?? 0), b = Number(c[i] ?? 0);
			if (a !== b) return a > b;
		}
		return false;
	}
	const lb = BUILD_RE.exec(latest), cb = BUILD_RE.exec(current);
	return Boolean(lb && cb && lb[1] >= cb[1]);
}
