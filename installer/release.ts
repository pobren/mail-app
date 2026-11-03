// The Mail App release that the installer puts on someone's Cloudflare account.
//
// How the installer gets Mail App: `npm run package` builds Mail App and copies the output into the npm
// package, in npm/releases/<version>/:
//
//   releases/latest.json                  {"version": "<version>"}
//   releases/<version>/manifest.json      ReleaseManifest, below
//   releases/<version>/worker/<module>    the Worker's ES modules (from build/server)
//   releases/<version>/assets/<path>      the static assets (from build/client)
//
// The installer reads these from the package while installing, so nothing else is downloaded. This file
// has no imports so that installer/build-release.ts and the tests can load it with
// `node --experimental-strip-types`.

export const RELEASES_PATH = "/releases";

export interface ReleaseModule {
	/** Module name as the Worker sees it, e.g. "index.js" or "assets/worker-entry-abc.js". */
	name: string;
	contentType: string;
}

export interface ReleaseAsset {
	/** Path the asset is served at on the Mail App Worker, starting with "/". */
	path: string;
	/** 32 hex characters: the start of a SHA-256 of the file plus its extension. */
	hash: string;
	size: number;
	contentType: string;
}

export interface DurableObjectMigration {
	tag: string;
	new_sqlite_classes?: string[];
	new_classes?: string[];
	renamed_classes?: { from: string; to: string }[];
	deleted_classes?: string[];
}

export interface ReleaseManifest {
	schema: 1;
	version: string;
	builtAt: string;
	worker: {
		mainModule: string;
		compatibilityDate: string;
		compatibilityFlags: string[];
		modules: ReleaseModule[];
		durableObjects: { name: string; className: string }[];
		migrations: DurableObjectMigration[];
		/** Binding name of the R2 bucket. */
		bucketBinding: string;
		/** Binding names of send_email bindings. */
		sendEmail: string[];
		/** Binding name for Workers AI, if the app uses it. */
		ai: string | null;
	};
	assets: ReleaseAsset[];
}

/** The parts of the wrangler.json that `npm run build` writes to build/server that we read. */
export interface BuiltWranglerConfig {
	main?: string;
	compatibility_date?: string;
	compatibility_flags?: string[];
	durable_objects?: { bindings?: { name: string; class_name: string; script_name?: string }[] };
	migrations?: DurableObjectMigration[];
	r2_buckets?: { binding: string }[];
	send_email?: { name: string }[];
	ai?: { binding: string };
}

const CONTENT_TYPES: Record<string, string> = {
	js: "application/javascript",
	mjs: "application/javascript",
	css: "text/css",
	html: "text/html",
	json: "application/json",
	map: "application/json",
	txt: "text/plain",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	webmanifest: "application/manifest+json",
	wasm: "application/wasm",
};

export function extensionOf(path: string): string {
	const file = path.slice(path.lastIndexOf("/") + 1);
	const dot = file.lastIndexOf(".");
	return dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
}

/** "application/null" tells Cloudflare to serve the file without a Content-Type, as Wrangler does. */
export function contentTypeFor(path: string): string {
	return CONTENT_TYPES[extensionOf(path)] ?? "application/null";
}

/** Server build files that are Worker modules. Wrangler's default rule is **\/*.js and **\/*.mjs. */
export function isWorkerModule(relativePath: string): boolean {
	return /\.(m?js)$/.test(relativePath) && !relativePath.startsWith(".vite/") && relativePath !== "wrangler.json";
}

/** Release versions end up in URLs, so keep them to safe characters. */
export function isSafeVersion(version: string): boolean {
	return /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version);
}

export function buildManifest(input: {
	version: string;
	builtAt: string;
	config: BuiltWranglerConfig;
	modules: string[];
	assets: { path: string; hash: string; size: number }[];
}): ReleaseManifest {
	const { version, config } = input;
	if (!isSafeVersion(version)) throw new Error(`Release version "${version}" has characters we can't put in a URL.`);
	if (!config.main) throw new Error("build/server/wrangler.json has no main module.");
	if (!config.compatibility_date) throw new Error("build/server/wrangler.json has no compatibility_date.");
	if (!input.modules.includes(config.main)) throw new Error(`Main module ${config.main} is missing from build/server.`);
	const bucket = config.r2_buckets?.[0]?.binding;
	if (!bucket) throw new Error("build/server/wrangler.json has no R2 bucket binding.");
	const durableObjects = (config.durable_objects?.bindings ?? []).map((b) => {
		if (b.script_name) throw new Error(`Durable Object ${b.name} lives in another Worker; the installer can't set that up.`);
		return { name: b.name, className: b.class_name };
	});
	for (const a of input.assets) {
		if (!a.path.startsWith("/")) throw new Error(`Asset path ${a.path} must start with "/".`);
		if (!/^[0-9a-f]{32}$/.test(a.hash)) throw new Error(`Asset ${a.path} has a bad hash.`);
	}
	return {
		schema: 1,
		version,
		builtAt: input.builtAt,
		worker: {
			mainModule: config.main,
			compatibilityDate: config.compatibility_date,
			compatibilityFlags: config.compatibility_flags ?? [],
			modules: [...input.modules].sort().map((name) => ({ name, contentType: "application/javascript+module" })),
			durableObjects,
			migrations: config.migrations ?? [],
			bucketBinding: bucket,
			sendEmail: (config.send_email ?? []).map((s) => s.name),
			ai: config.ai?.binding ?? null,
		},
		assets: [...input.assets]
			.sort((a, b) => a.path.localeCompare(b.path))
			.map((a) => ({ ...a, contentType: contentTypeFor(a.path) })),
	};
}

/** Checks a manifest read back from mailapp.com's own assets. */
export function isReleaseManifest(value: unknown): value is ReleaseManifest {
	const m = value as ReleaseManifest;
	return Boolean(
		m &&
			m.schema === 1 &&
			typeof m.version === "string" &&
			isSafeVersion(m.version) &&
			m.worker &&
			typeof m.worker.mainModule === "string" &&
			Array.isArray(m.worker.modules) &&
			Array.isArray(m.assets),
	);
}
