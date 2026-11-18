// Builds the npm package `@mrpwob/mail-app` into npm/: the command-line installer (npm/cli.mjs) and the
// built app it installs (npm/releases/). Run from the repo root:
//
//   npm run package              builds the app, then the package
//   npm run package -- --skip-build
//   cd npm && npm publish        publishes it (the release workflow does this for each tag)
//
// The version is the newest entry in shared/changelog.json ("2.0" is published as 2.0.0).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { RELEASES_PATH, buildManifest, extensionOf, isWorkerModule, type BuiltWranglerConfig } from "./release.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(root, "build/server");
const clientDir = join(root, "build/client");
const npmDir = join(root, "npm");
const releasesDir = join(npmDir, RELEASES_PATH.slice(1));

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

const toPosix = (p: string) => p.split(sep).join("/");

/** Same idea as Wrangler: a hash of the base64 contents plus the extension, cut to 32 hex characters. */
function assetHash(file: string): string {
	const base64 = readFileSync(file).toString("base64");
	return createHash("sha256").update(base64 + extensionOf(file)).digest("hex").slice(0, 32);
}

const changelog = JSON.parse(readFileSync(join(root, "shared/changelog.json"), "utf8")) as { releases: { version: string }[] };
const version = changelog.releases[0]?.version;
if (!version || !/^\d+\.\d+(\.\d+)?$/.test(version)) throw new Error('shared/changelog.json needs a release like "2.0" at the top.');
const npmVersion = version.split(".").length === 2 ? `${version}.0` : version;

if (!process.argv.includes("--skip-build")) execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
if (!existsSync(join(serverDir, "wrangler.json"))) throw new Error("No build/server/wrangler.json. Run `npm run build` first.");

// 1. The release: the Worker's modules, the static assets and a manifest saying how they fit together.
const config = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8")) as BuiltWranglerConfig;
const modules = walk(serverDir).map((f) => toPosix(relative(serverDir, f))).filter(isWorkerModule);
const assets = walk(clientDir).map((f) => ({ path: `/${toPosix(relative(clientDir, f))}`, hash: assetHash(f), size: statSync(f).size }));
const manifest = buildManifest({ version, builtAt: new Date().toISOString(), config, modules, assets });

rmSync(releasesDir, { recursive: true, force: true });
const out = join(releasesDir, version);
for (const m of modules) {
	mkdirSync(dirname(join(out, "worker", m)), { recursive: true });
	cpSync(join(serverDir, m), join(out, "worker", m));
}
cpSync(clientDir, join(out, "assets"), { recursive: true });
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, "\t"));
writeFileSync(join(releasesDir, "latest.json"), JSON.stringify({ version }));

// 2. The command-line installer, in one file.
await build({
	entryPoints: [join(root, "installer/cli.ts")],
	outfile: join(npmDir, "cli.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	banner: { js: `#!/usr/bin/env node\n// Mail App installer ${npmVersion}. GNU AGPL 3.0. https://github.com/pobren/mail-app` },
	define: { CLI_VERSION: JSON.stringify(npmVersion) },
});

// 3. The package's own files.
const pkg = JSON.parse(readFileSync(join(root, "installer/package.json"), "utf8"));
writeFileSync(join(npmDir, "package.json"), `${JSON.stringify({ ...pkg, version: npmVersion }, null, "\t")}\n`);
cpSync(join(root, "installer/README.md"), join(npmDir, "README.md"));
for (const file of ["LICENSE", "LICENSE-APACHE", "NOTICE"]) cpSync(join(root, file), join(npmDir, file));

console.log(`@mrpwob/mail-app ${npmVersion}: ${modules.length} Worker modules, ${assets.length} assets, in npm/`);
