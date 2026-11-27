import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk/unstable";
import { z } from "zod";

import { AcpError } from "./client.ts";

type AgentChoice = "auto" | "cli" | "registry";

interface AgentLaunch {
	command: string;
	args: string[];
}

type Env = Record<string, string | undefined>;

const REGISTRY_ID = "antigravity-acp";
const STOP_GRACE_MS = 1000;

function executable(file: string): boolean {
	try {
		accessSync(file, constants.X_OK);
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

/** Where Zed keeps agents installed from the ACP registry. */
export function registryRoot(env: Env, platform: string): string {
	const { HOME, USERPROFILE, XDG_DATA_HOME, LOCALAPPDATA } = env;
	const home = HOME ?? USERPROFILE ?? "";
	let data = XDG_DATA_HOME ?? join(home, ".local", "share");
	if (platform === "darwin") data = join(home, "Library", "Application Support");
	else if (platform === "win32") data = LOCALAPPDATA ?? join(home, "AppData", "Local");
	return join(data, platform === "linux" ? "zed" : "Zed", "external_agents", "registry");
}

function platformKey(platform: string, arch: string): string {
	const os = platform === "win32" ? "windows" : platform;
	return `${os}-${arch === "arm64" ? "aarch64" : "x86_64"}`;
}

const listingSchema = z.object({ agents: z.array(z.unknown()) });
const listedAgentSchema = z.object({
	id: z.literal(REGISTRY_ID),
	distribution: z.object({ binary: z.record(z.string(), z.unknown()) }),
});
const binarySchema = z.object({
	cmd: z.string(),
	args: z
		.array(z.unknown())
		.catch([])
		.transform((args) => args.filter((arg) => typeof arg === "string")),
});

/** The launch command the registry lists for this platform, as cached next to the installed agents. */
function registryCommand(root: string, platform: string): { cmd: string; args: string[] } | undefined {
	try {
		const listing = listingSchema.safeParse(JSON.parse(readFileSync(join(root, "registry.json"), "utf8")));
		const agents = listing.success ? listing.data.agents : [];
		const entry = agents.map((agent) => listedAgentSchema.safeParse(agent)).find((r) => r.success);
		const binaries = entry?.data?.distribution.binary ?? {};
		const binary = binarySchema.safeParse(Object.hasOwn(binaries, platform) ? binaries[platform] : undefined);
		return binary.success ? binary.data : undefined;
	} catch {
		// No readable listing: the caller falls back to the binary's usual name.
		return undefined;
	}
}

type Version = readonly [number, number, number];

function versionOf(directory: string): Version | undefined {
	const match = /^v_(\d+)\.(\d+)\.(\d+)/.exec(directory);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

interface Installed {
	readonly directory: string;
	readonly version: Version;
}

function newer(a: Installed, b: Installed): Installed {
	const [x, y] = [a.version, b.version];
	return (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) > 0 ? a : b;
}

export function findRegistryAgent(root: string, platform: string): AgentLaunch | undefined {
	let installed: string[];
	try {
		installed = readdirSync(join(root, REGISTRY_ID));
	} catch {
		return undefined;
	}
	const listed = registryCommand(root, platform);
	const fallback = platform.startsWith("windows") ? "agy_acp_server.exe" : "agy_acp_server.par";
	const commandIn = (directory: string) => resolve(join(root, REGISTRY_ID, directory, listed?.cmd ?? fallback));
	// A copy that cannot run, such as one still installing, leaves the next newest.
	const [first, ...rest] = installed.flatMap((directory): Installed[] => {
		const version = versionOf(directory);
		return version && executable(commandIn(directory)) ? [{ directory, version }] : [];
	});
	if (first === undefined) return undefined;
	const command = commandIn(rest.reduce(newer, first).directory);
	return { command, args: listed?.args ?? [] };
}

/** Find the exact executable on PATH; on Windows, also try `name.exe`. */
function onPath(name: string, env: Env, platform: string): string | undefined {
	const names = platform === "win32" ? [name, `${name}.exe`] : [name];
	const { PATH = "" } = env;
	for (const dir of PATH.split(delimiter)) {
		if (dir === "") continue;
		for (const file of names) {
			const candidate = resolve(dir, file);
			if (executable(candidate)) return candidate;
		}
	}
	return undefined;
}

/** Picks the agent to run. `auto` prefers the installed CLI over an editor's registry copy. */
export function resolveAgent(
	choice: AgentChoice,
	env: Env = process.env,
	platform: string = process.platform,
	arch: string = process.arch,
): AgentLaunch {
	const cli = (): AgentLaunch | undefined => {
		const command = onPath("agy", env, platform);
		return command ? { command, args: ["acp"] } : undefined;
	};
	const registry = () => findRegistryAgent(registryRoot(env, platform), platformKey(platform, arch));
	let agent: AgentLaunch | undefined;
	if (choice === "cli") agent = cli();
	else if (choice === "registry") agent = registry();
	else agent = cli() ?? registry();
	if (agent) return agent;
	throw new AcpError(
		choice === "registry"
			? "No Antigravity agent installed from Zed's ACP registry was found. Install it in Zed, or use --agy-agent cli."
			: "Antigravity CLI (`agy`) was not found on PATH. Install it, sign in by running `agy`, then try again.",
	);
}

export interface RunningAgent {
	stream: Stream;
	stop(): void;
}

export function launch(agent: AgentLaunch, cwd: string, env: Env = process.env): RunningAgent {
	const child = spawn(agent.command, agent.args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
	// A failed spawn also closes the pipes, which ends the ACP connection with an error.
	child.once("error", () => {});
	let stopping = false;
	return {
		stream: ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
		stop() {
			if (stopping) return;
			stopping = true;
			child.stdin.end();
			if (child.exitCode !== null || child.signalCode !== null) return;
			// Windows terminates the child immediately on SIGTERM. Give it time to handle stdin EOF.
			if (process.platform !== "win32") child.kill();
			const force = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS).unref();
			child.once("close", () => clearTimeout(force));
		},
	};
}
