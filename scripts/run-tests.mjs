/**
 * Runs the lock-layer unit tests.
 *
 * The plugin's runtime modules import `obsidian`, which only exists inside the
 * app, so the tests target dependency-free modules (src/agent/tool-locks.ts and
 * src/agent/tool-targets.ts). esbuild (already a devDependency) transpiles them
 * to a temp directory and Node's built-in test runner executes the bundles.
 * This keeps the test setup dependency-free and works on Node 20 and 22.
 */

import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const testDir = path.resolve("test");
const entryPoints = (await readdir(testDir))
	.filter((file) => file.endsWith(".test.ts"))
	.sort()
	.map((file) => path.join(testDir, file));

if (entryPoints.length === 0) {
	console.error("No *.test.ts files found in test/.");
	process.exit(1);
}

const outdir = await mkdtemp(path.join(tmpdir(), "porygon-tests-"));

try {
	await build({
		entryPoints,
		outdir,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
		sourcemap: "inline",
		logLevel: "warning",
	});

	const testFiles = (await readdir(outdir))
		.filter((file) => file.endsWith(".js"))
		.sort()
		.map((file) => path.join(outdir, file));

	const exitCode = await new Promise((resolve) => {
		const child = spawn(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
		child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
	});

	process.exitCode = exitCode;
} finally {
	await rm(outdir, { recursive: true, force: true });
}
