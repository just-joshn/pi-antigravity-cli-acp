import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import manifest from "../package.json" with { type: "json" };

const { npm_execpath: npm, PATH, SystemRoot } = process.env;
assert.ok(npm, "Run this script through npm run test:package");
const cwd = process.cwd();
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 2, "Pass a tarball path and an exact Pi version, or no arguments");
const piVersion = args[1] ?? manifest.devDependencies["@earendil-works/pi-coding-agent"];
assert.match(piVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Pi version must be exact");
const host = `@earendil-works/pi-coding-agent@${piVersion}`;
const temp = mkdtempSync(join(tmpdir(), "pi-package-"));

try {
	let tarball: string;
	if (args.length === 0) {
		execFileSync(process.execPath, [npm, "pack", "--ignore-scripts", "--pack-destination", temp], {
			cwd,
			stdio: "inherit",
			timeout: 60_000,
		});
		const tarballs = readdirSync(temp).filter((file) => file.endsWith(".tgz"));
		assert.equal(tarballs.length, 1, "Expected exactly one packed tarball");
		assert.ok(tarballs[0]);
		tarball = join(temp, tarballs[0]);
	} else {
		assert.ok(args[0]);
		tarball = resolve(cwd, args[0]);
		assert.ok(
			tarball.endsWith(".tgz") && statSync(tarball, { throwIfNoEntry: false })?.isFile(),
			"Expected a .tgz file",
		);
	}
	writeFileSync(join(temp, "package.json"), '{"private":true,"type":"module"}\n', { mode: 0o600 });
	execFileSync(
		process.execPath,
		[npm, "install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--save-exact", host, tarball],
		{ cwd: temp, stdio: "inherit", timeout: 180_000 },
	);
	const piPackage = join(temp, "node_modules", "@earendil-works", "pi-coding-agent");
	assert.equal(JSON.parse(readFileSync(join(piPackage, "package.json"), "utf8")).version, piVersion);
	const pi = join(piPackage, "dist", "bundle", "cli.js");
	const work = join(temp, "work");
	const agentDir = join(temp, ".pi-agent");
	const data = process.platform === "darwin" ? join(temp, "Library", "Application Support") : join(temp, "data");
	const registry = join(data, process.platform === "linux" ? "zed" : "Zed", "external_agents", "registry");
	const installed = join(registry, "antigravity-acp", "v_1.0.0_test");
	mkdirSync(installed, { recursive: true });
	mkdirSync(work);
	const executable = process.platform === "win32" ? "node.exe" : "node";
	copyFileSync(process.execPath, join(installed, executable));
	const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
	writeFileSync(
		join(registry, "registry.json"),
		JSON.stringify({
			agents: [
				{
					id: "antigravity-acp",
					distribution: {
						binary: { [platform]: { cmd: executable, args: [resolve(cwd, "tests/support/fake-agy.ts")] } },
					},
				},
			],
		}),
	);
	const env = {
		PATH,
		HOME: temp,
		USERPROFILE: temp,
		SystemRoot,
		TEMP: temp,
		TMP: temp,
		XDG_DATA_HOME: data,
		LOCALAPPDATA: data,
		PI_OFFLINE: "1",
		PI_CODING_AGENT_DIR: agentDir,
		FAKE_AGY_STORE: join(temp, "agy-sessions.json"),
	};
	const runPi = (args: string[], log: string) =>
		execFileSync(process.execPath, [pi, ...args], {
			cwd: work,
			env: { ...env, FAKE_AGY_LOG: log },
			encoding: "utf8",
			timeout: 30_000,
		});
	const packagePath = join(temp, "node_modules", manifest.name);
	runPi(["install", packagePath], join(temp, "install-log"));
	assert.ok(runPi(["list"], join(temp, "list-log")).includes(packagePath), "Pi must list the installed package");
	for (const [index, prompt] of ["hello", "again"].entries()) {
		const log = join(temp, `log-${index}.json`);
		const args = [
			"--offline",
			"--session-dir",
			join(temp, "sessions"),
			"--model",
			"antigravity/default",
			"--agy-agent",
			"registry",
		];
		if (index === 1) args.push("--continue");
		assert.equal(runPi([...args, "--print", prompt], log).trim(), `echo: ${prompt}`);
		for (
			let attempt = 0;
			attempt < 50 && readdirSync(temp).some((name) => name.startsWith(`log-${index}.json.running.`));
			attempt++
		)
			await delay(100);
		assert.ok(
			!readdirSync(temp).some((name) => name.startsWith(`log-${index}.json.running.`)),
			"Agent must exit after Pi shuts down",
		);
		const recorded = JSON.parse(readFileSync(log, "utf8"));
		if (index === 1) {
			assert.equal(recorded.sessions.length, 0, "Resume must not create a new agent session");
			assert.equal(recorded.loads.length, 1, "Resume must load the saved agent session");
			assert.deepEqual(
				recorded.prompts.flat().map((block: { type: string; text?: string }) => `${block.type}:${block.text}`),
				["text:again"],
			);
		}
	}
	process.stdout.write("Pi installed, prompted, resumed without resending, and stopped the agent.\n");
	copyFileSync(resolve(cwd, "scripts/smoke-installed.ts"), join(temp, "smoke-installed.ts"));
	execFileSync(process.execPath, [join(temp, "smoke-installed.ts"), manifest.name], {
		cwd: temp,
		stdio: "inherit",
		timeout: 30_000,
		env: {
			PATH,
			HOME: temp,
			USERPROFILE: temp,
			SystemRoot,
			TEMP: temp,
			TMP: temp,
			PI_OFFLINE: "1",
			PI_CODING_AGENT_DIR: join(temp, ".pi-agent"),
		},
	});
} finally {
	rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
}
