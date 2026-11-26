import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Stream } from "@agentclientprotocol/sdk/unstable";
import { expect, onTestFinished, test, vi } from "vitest";

import { findRegistryAgent, launch, registryRoot, resolveAgent } from "../src/agent.ts";
import { AcpError } from "../src/client.ts";
import { alive, scratchDir } from "./support/scratch.ts";

async function program(file: string) {
	await mkdir(join(file, ".."), { recursive: true });
	await writeFile(file, "#!/bin/sh\n");
	await chmod(file, 0o755);
}

/** Two registry copies of the agent under a scratch HOME, as Zed installs them on macOS. */
async function installCopies() {
	const home = await scratchDir("agent");
	const root = registryRoot({ HOME: home }, "darwin");
	const older = join(root, "antigravity-acp", "v_1.5.2_aaaa", "agy_acp_server.par");
	const newer = join(root, "antigravity-acp", "v_1.10.0_bbbb", "agy_acp_server.par");
	await Promise.all([program(older), program(newer)]);
	await mkdir(join(root, "antigravity-acp", "not-a-version"));
	return { home, root, newer, env: { HOME: home, PATH: join(home, "bin") } };
}

/** Resolves when the agent's output ends: with the error that ended it, or undefined. */
async function ended(stream: Stream): Promise<unknown> {
	const reader = stream.readable.getReader();
	try {
		while (!(await reader.read()).done);
		return undefined;
	} catch (error) {
		return error;
	}
}

test("the registry directory follows each platform's data directory", async () => {
	const home = await scratchDir("agent");
	expect(registryRoot({ HOME: home }, "darwin")).toBe(
		join(home, "Library", "Application Support", "Zed", "external_agents", "registry"),
	);
	expect(registryRoot({ HOME: home }, "linux")).toBe(
		join(home, ".local", "share", "zed", "external_agents", "registry"),
	);
	const data = join(home, "data");
	expect(registryRoot({ HOME: home, XDG_DATA_HOME: data }, "linux")).toBe(
		join(data, "zed", "external_agents", "registry"),
	);
	expect(registryRoot({ LOCALAPPDATA: data }, "win32")).toBe(join(data, "Zed", "external_agents", "registry"));
});

test("with no agent installed, each choice says what is missing", async () => {
	const home = await scratchDir("agent");
	const env = { HOME: home, PATH: join(home, "bin") };
	expect(() => resolveAgent("auto", env, "darwin", "arm64")).toThrow(AcpError);
	expect(() => resolveAgent("registry", env, "darwin", "arm64")).toThrow(/Zed/);
	expect(() => resolveAgent("cli", env, "darwin", "arm64")).toThrow(/agy.*PATH/);
});

test("without agy on PATH, the newest registry copy runs as its listing says", async () => {
	const { root, newer, env } = await installCopies();
	expect(resolveAgent("auto", env, "darwin", "arm64")).toStrictEqual({
		command: newer,
		args: [],
	});
	await writeFile(
		join(root, "registry.json"),
		JSON.stringify({
			agents: [
				{ id: "other" },
				{
					id: "antigravity-acp",
					distribution: {
						binary: { "linux-x86_64": { cmd: "./agy_acp_server.par", args: ["--uid=", 7] } },
					},
				},
			],
		}),
	);
	expect(findRegistryAgent(root, "linux-x86_64")).toStrictEqual({
		command: newer,
		args: ["--uid="],
	});
	expect(findRegistryAgent(root, "darwin-aarch64")?.args).toStrictEqual([]);
});

test("auto prefers agy on PATH, and a registry copy must be executable", async () => {
	const { home, root, newer, env } = await installCopies();
	await program(join(home, "bin", "agy"));
	expect(resolveAgent("auto", env, "darwin", "arm64")).toStrictEqual({
		command: "agy",
		args: ["acp"],
	});
	expect(resolveAgent("registry", env, "darwin", "arm64").command).toBe(newer);
	const older = join(root, "antigravity-acp", "v_1.5.2_aaaa", "agy_acp_server.par");
	// Windows has no executable mode bit. A missing executable is not runnable on either platform.
	if (process.platform === "win32") await rm(newer);
	else await chmod(newer, 0o644);
	expect(findRegistryAgent(root, "darwin-aarch64")?.command, "fall back to the older copy").toBe(older);
	if (process.platform === "win32") await rm(older);
	else await chmod(older, 0o644);
	expect(findRegistryAgent(root, "darwin-aarch64"), "no copy can run").toBe(undefined);
});

test("the registry directory falls back to USERPROFILE and Windows' default", async () => {
	const home = await scratchDir("agent");
	expect(registryRoot({ USERPROFILE: home }, "darwin")).toBe(
		join(home, "Library", "Application Support", "Zed", "external_agents", "registry"),
	);
	expect(registryRoot({}, "linux")).toBe(join(".local", "share", "zed", "external_agents", "registry"));
	expect(registryRoot({ HOME: home }, "win32")).toBe(
		join(home, "AppData", "Local", "Zed", "external_agents", "registry"),
	);
});

test("a missing or malformed registry listing falls back to the default server binary", async () => {
	const root = await scratchDir("agent");
	expect(findRegistryAgent(root, "darwin-aarch64"), "nothing installed").toBeUndefined();
	await mkdir(join(root, "antigravity-acp", "unversioned"), { recursive: true });
	expect(findRegistryAgent(root, "darwin-aarch64"), "no version directory").toBeUndefined();

	const installed = join(root, "antigravity-acp", "v_1.0.0_a");
	await mkdir(installed);
	for (const name of ["agy_acp_server.par", "agy_acp_server.exe"])
		await writeFile(join(installed, name), "#!/bin/sh\n", { mode: 0o755 });
	const listings: unknown[] = [
		null,
		"not an object",
		{ agents: [null, { id: "antigravity-acp", distribution: null }] },
		{ agents: "not a list" },
		{ agents: [{ id: "antigravity-acp" }] },
		{ agents: [{ id: "antigravity-acp", distribution: { binary: { "windows-x86_64": {} } } }] },
	];
	for (const listing of listings) {
		await writeFile(join(root, "registry.json"), JSON.stringify(listing));
		expect(findRegistryAgent(root, "windows-x86_64")?.command).toBe(join(installed, "agy_acp_server.exe"));
	}
	await writeFile(
		join(root, "registry.json"),
		JSON.stringify({
			agents: [
				{
					id: "antigravity-acp",
					distribution: { binary: { "linux-x86_64": { cmd: "agy_acp_server.par", args: "x" } } },
				},
			],
		}),
	);
	expect(findRegistryAgent(root, "linux-x86_64")?.args, "args that are not a list").toStrictEqual([]);
});

test("stopping an agent that ignores SIGTERM kills it", async () => {
	const dir = await scratchDir("agent");
	const pidFile = join(dir, "pid");
	const script = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
	const agent = launch({ command: process.execPath, args: ["-e", script, pidFile] }, dir);
	onTestFinished(() => agent.stop());
	const pid = await vi.waitFor(async () => {
		const recorded = await readFile(pidFile, "utf8").catch(() => "");
		expect(recorded).toMatch(/\d/);
		return recorded;
	});
	agent.stop();
	await ended(agent.stream);
	// The output closes before the killed process is reaped; wait for it to be gone.
	await vi.waitFor(() => expect(alive(Number(pid))).toBe(false), { timeout: 3000 });
});

test("stopping an agent closes stdin so it can finish before forced termination", async () => {
	const dir = await scratchDir("agent");
	const script = `const { writeFileSync } = require('node:fs');
		process.on('SIGTERM', () => {});
		process.stdin.on('end', () => writeFileSync('finished', 'done')).resume();
		writeFileSync('ready', 'yes');`;
	const agent = launch({ command: process.execPath, args: ["-e", script] }, dir);
	onTestFinished(() => agent.stop());
	await vi.waitFor(async () => expect(await readFile(join(dir, "ready"), "utf8")).toBe("yes"));
	agent.stop();
	await ended(agent.stream);
	expect(await readFile(join(dir, "finished"), "utf8")).toBe("done");
});

test("stopping an agent that already exited, or never started, does nothing", async () => {
	const dir = await scratchDir("agent");
	const exited = launch(
		{ command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('pid', String(process.pid))"] },
		dir,
	);
	await ended(exited.stream);
	const pid = Number(await readFile(join(dir, "pid"), "utf8"));
	expect(pid).toBeGreaterThan(0);
	await vi.waitFor(() => expect(alive(pid)).toBe(false));
	expect(() => exited.stop()).not.toThrow();

	const missing = launch({ command: join(dir, "absent"), args: [] }, dir);
	expect(await ended(missing.stream), "a failed spawn ends the output").toBeUndefined();
	expect(() => missing.stop()).not.toThrow();
});

test("on Windows, agy.exe on PATH is the CLI", async () => {
	const home = await scratchDir("agent");
	await program(join(home, "bin", "agy.exe"));
	const env = { HOME: home, PATH: join(home, "bin") };
	expect(resolveAgent("cli", env, "win32", "x64").command).toBe("agy");
	expect(() => resolveAgent("cli", env, "darwin", "arm64"), "only Windows adds .exe").toThrow(AcpError);
});
