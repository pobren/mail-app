// Copyright (c) 2026 Paul O'Brien. Licensed under the Apache 2.0 license.
// Added for Mail App: the shape of GET /api/v1/setup/status, shared by the Worker and the wizard.

export type CheckStatus = "ok" | "fix" | "unknown";

export interface DnsFix {
	type: "TXT" | "MX";
	name: string;
	value: string;
}

export interface SetupCheck {
	id: string;
	status: CheckStatus;
	/** Facts the wizard shows next to its own wording, e.g. the record it found. */
	found?: string;
	fix?: DnsFix;
}

export interface DomainChecks {
	domain: string;
	checks: SetupCheck[];
}

export interface SetupStatus {
	app: SetupCheck[];
	domains: DomainChecks[];
}
