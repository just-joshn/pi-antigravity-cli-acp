import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { Readable, Writable } from "node:stream";

import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk/unstable";

import { AcpError } from "./client.ts";
import { isRecord } from "./guards.ts";

/** Which Antigravity ACP server to run. */
export type AgentChoice = "auto" | "cli" | "registry";

export interface AgentCommand {
  /** `cli`: the Antigravity CLI's `agy acp`. `registry`: the ACP registry agent an editor installed. */
  kind: "cli" | "registry";
  command: string;
  args: string[];
}

type Env = Record<string, string | undefined>;

const REGISTRY_ID = "antigravity-acp";

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where Zed keeps agents installed from the ACP registry. */
export function registryRoot(env: Env, platform: string): string {
  const home = env["HOME"] ?? env["USERPROFILE"] ?? "";
  let data = env["XDG_DATA_HOME"] ?? join(home, ".local", "share");
  if (platform === "darwin") data = join(home, "Library", "Application Support");
  else if (platform === "win32") data = env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
  return join(data, platform === "linux" ? "zed" : "Zed", "external_agents", "registry");
}

function platformKey(platform: string, arch: string): string {
  const os = platform === "win32" ? "windows" : platform;
  return `${os}-${arch === "arm64" ? "aarch64" : "x86_64"}`;
}

/** The launch command the registry lists for this platform, as cached next to the installed agents. */
function registryCommand(
  root: string,
  platform: string,
): { cmd: string; args: string[] } | undefined {
  try {
    const registry: unknown = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
    const agents =
      isRecord(registry) && Array.isArray(registry["agents"]) ? registry["agents"] : [];
    const entry: unknown = agents.find((agent) => isRecord(agent) && agent["id"] === REGISTRY_ID);
    const distribution = isRecord(entry) ? entry["distribution"] : undefined;
    const binaries = isRecord(distribution) ? distribution["binary"] : undefined;
    const binary = isRecord(binaries) ? binaries[platform] : undefined;
    if (!isRecord(binary) || typeof binary["cmd"] !== "string") return undefined;
    const args = Array.isArray(binary["args"]) ? binary["args"] : [];
    return { cmd: binary["cmd"], args: args.filter((arg) => typeof arg === "string") };
  } catch {
    return undefined;
  }
}

function newer(a: string, b: string): string {
  const [x, y] = [versionOf(a), versionOf(b)];
  const order = (x[0] ?? 0) - (y[0] ?? 0) || (x[1] ?? 0) - (y[1] ?? 0) || (x[2] ?? 0) - (y[2] ?? 0);
  return order > 0 ? a : b;
}

function versionOf(directory: string): number[] {
  return (/^v_(\d+)\.(\d+)\.(\d+)/.exec(directory) ?? []).slice(1).map(Number);
}

/** The newest registry-installed Antigravity agent under `root`, if any. */
export function findRegistryAgent(root: string, platform: string): AgentCommand | undefined {
  let installed: string[];
  try {
    installed = readdirSync(join(root, REGISTRY_ID));
  } catch {
    return undefined;
  }
  const [first, ...rest] = installed.filter((name) => versionOf(name).length === 3);
  if (first === undefined) return undefined;
  const newest = rest.reduce(newer, first);
  const listed = registryCommand(root, platform);
  const fallback = platform.startsWith("windows") ? "agy_acp_server.exe" : "agy_acp_server.par";
  const command = join(root, REGISTRY_ID, newest, listed?.cmd ?? fallback);
  return executable(command) ? { kind: "registry", command, args: listed?.args ?? [] } : undefined;
}

function onPath(name: string, env: Env): boolean {
  return (env["PATH"] ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && executable(join(dir, name)));
}

/** Picks the agent to run. `auto` prefers the installed CLI over an editor's registry copy. */
export function resolveAgent(
  choice: AgentChoice,
  env: Env = process.env,
  platform: string = process.platform,
  arch: string = process.arch,
): AgentCommand {
  const cli = (): AgentCommand | undefined =>
    onPath("agy", env) ? { kind: "cli", command: "agy", args: ["acp"] } : undefined;
  const registry = () =>
    findRegistryAgent(registryRoot(env, platform), platformKey(platform, arch));
  let agent: AgentCommand | undefined;
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

/** Starts the agent process and exposes its stdio as an ACP stream. */
export function launch(agent: AgentCommand, cwd: string, env: Env = process.env): RunningAgent {
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
      child.kill();
      const force = setTimeout(() => child.kill("SIGKILL"), 1000).unref();
      child.once("close", () => clearTimeout(force));
    },
  };
}
