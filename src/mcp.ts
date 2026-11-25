import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@agentclientprotocol/sdk/unstable";

import { isRecord } from "./guards.ts";

/**
 * Pi's configured MCP servers as ACP servers, read from the files and in the format documented in
 * Pi's docs/mcp.md: `<agent dir>/mcp.json`, then `.pi/mcp.json` of a trusted project. Pi does not
 * export its own loader. Servers that only Pi can run are skipped, each with the reason.
 */
export function readPiMcpServers(options: {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  env: Record<string, string | undefined>;
}): { servers: McpServer[]; skipped: string[] } {
  const merged = new Map(Object.entries(entries(join(options.agentDir, "mcp.json"))));
  if (options.projectTrusted)
    for (const [name, entry] of Object.entries(entries(join(options.cwd, ".pi", "mcp.json")))) {
      const base = merged.get(name);
      const overridesOnly =
        isRecord(entry) && !("command" in entry || "url" in entry || "type" in entry);
      merged.set(name, overridesOnly && isRecord(base) ? { ...base, ...entry } : entry);
    }
  const servers: McpServer[] = [];
  const skipped: string[] = [];
  for (const [name, entry] of merged) {
    const result = convert(name, entry, options.env);
    if (typeof result === "string") skipped.push(`${name}: ${result}`);
    else if (result) servers.push(result);
  }
  return { servers, skipped };
}

function entries(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const servers = isRecord(parsed) ? parsed["mcpServers"] : undefined;
    return isRecord(servers) ? servers : {};
  } catch {
    // A missing file has no servers; a malformed one is reported by Pi itself.
    return {};
  }
}

const NAME = /^[A-Za-z0-9_-]+$/;

/** An ACP server for one entry, undefined when it is switched off, or why it cannot be passed. */
function convert(
  name: string,
  entry: unknown,
  env: Record<string, string | undefined>,
): McpServer | string | undefined {
  if (!NAME.test(name)) return "the name has characters Pi does not allow";
  if (!isRecord(entry)) return "not a server entry";
  if (entry["enabled"] === false) return undefined;
  if (entry["type"] === "sse") return "the SSE transport is not supported";
  const pairs = typeof entry["url"] === "string" ? entry["headers"] : entry["env"];
  const values = expandAll(pairs ?? {}, env);
  if (typeof values === "string") return values;
  if (typeof entry["url"] === "string") {
    if (entry["oauth"] !== undefined || entry["auth"] !== undefined)
      return "Pi signs in to it with OAuth";
    return { type: "http", name, url: entry["url"], headers: values };
  }
  const { command, args = [] } = entry;
  if (typeof command !== "string" || !strings(args)) return "not a server entry";
  if (entry["cwd"] !== undefined) return "ACP cannot pass a working directory";
  return { name, command: home(command), args: args.map(home), env: values };
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function home(value: string): string {
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

/** `${VAR}` values from the environment. Pi also runs `!command` values; this cannot. */
function expandAll(pairs: unknown, env: Record<string, string | undefined>) {
  if (!isRecord(pairs)) return "not a server entry";
  const expanded: { name: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(pairs)) {
    if (typeof raw !== "string") return "not a server entry";
    if (raw.startsWith("!")) return "a value runs a command";
    const missing = [...raw.matchAll(/\$\{(\w+)\}/g)].find(
      ([, variable = ""]) => env[variable] === undefined,
    );
    if (missing) return `${missing[1]} is not set`;
    expanded.push({
      name: key,
      value: raw.replaceAll(/\$\{(\w+)\}/g, (_, variable: string) => env[variable] ?? ""),
    });
  }
  return expanded;
}
