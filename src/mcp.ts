import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@agentclientprotocol/sdk/unstable";
import { z } from "zod";

import { isRecord } from "./guards.ts";

type Env = Record<string, string | undefined>;

/**
 * Pi's configured MCP servers as ACP servers, read from the files and in the format documented in
 * Pi's docs/mcp.md: `<agent dir>/mcp.json`, then `.pi/mcp.json` of a trusted project. Pi does not
 * export its own loader. Servers that only Pi can run are skipped, each with the reason.
 */
export function readPiMcpServers(options: {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  env: Env;
}): { servers: McpServer[]; skipped: string[] } {
  const user = entries(join(options.agentDir, "mcp.json"));
  const project = options.projectTrusted ? entries(join(options.cwd, ".pi", "mcp.json")) : {};
  const overlaid = Object.entries(project).map(([name, entry]): [string, unknown] => [
    name,
    overlay(Object.hasOwn(user, name) ? user[name] : undefined, entry),
  ]);
  const merged = { ...user, ...Object.fromEntries(overlaid) };
  const results = Object.entries(merged).map(([name, entry]) => ({
    name,
    result: convert(name, entry, options.env),
  }));
  return {
    servers: results.flatMap(({ result }) =>
      result && typeof result !== "string" ? [result] : [],
    ),
    skipped: results.flatMap(({ name, result }) =>
      typeof result === "string" ? [`${name}: ${result}`] : [],
    ),
  };
}

/** A project entry that only switches a user server off or on, or changes its settings, overlays it. */
function overlay(base: unknown, entry: unknown): unknown {
  const overridesOnly =
    isRecord(entry) && !("command" in entry || "url" in entry || "type" in entry);
  return overridesOnly && isRecord(base) ? { ...base, ...entry } : entry;
}

const fileSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()) });

function entries(file: string): Record<string, unknown> {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data.mcpServers : {};
  } catch {
    // A missing file has no servers; a malformed one is reported by Pi itself.
    return {};
  }
}

const NAME = /^[A-Za-z0-9_-]+$/;
const NOT_AN_ENTRY = "not a server entry";

const entrySchema = z.looseObject({
  enabled: z.unknown().optional(),
  type: z.unknown().optional(),
  url: z.unknown().optional(),
});
const pairsSchema = z.record(z.string(), z.string()).default({});
const httpSchema = z.object({
  url: z.string().min(1),
  headers: pairsSchema,
  oauth: z.unknown().optional(),
  auth: z.unknown().optional(),
});
const stdioSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: pairsSchema,
  cwd: z.unknown().optional(),
});

/** An ACP server for one entry, undefined when it is switched off, or why it cannot be passed. */
function convert(name: string, raw: unknown, env: Env): McpServer | string | undefined {
  if (!NAME.test(name)) return "the name has characters Pi does not allow";
  const entry = entrySchema.safeParse(raw);
  if (!entry.success) return NOT_AN_ENTRY;
  if (entry.data.enabled === false) return undefined;
  if (entry.data.type === "sse") return "the SSE transport is not supported";
  return typeof entry.data.url === "string"
    ? httpServer(name, raw, env)
    : stdioServer(name, raw, env);
}

function httpServer(name: string, raw: unknown, env: Env): McpServer | string {
  const entry = httpSchema.safeParse(raw);
  if (!entry.success) return NOT_AN_ENTRY;
  const headers = expandAll(entry.data.headers, env);
  if (typeof headers === "string") return headers;
  if (entry.data.oauth !== undefined || entry.data.auth !== undefined)
    return "Pi signs in to it with OAuth";
  return { type: "http", name, url: entry.data.url, headers };
}

function stdioServer(name: string, raw: unknown, env: Env): McpServer | string {
  const entry = stdioSchema.safeParse(raw);
  if (!entry.success) return NOT_AN_ENTRY;
  const values = expandAll(entry.data.env, env);
  if (typeof values === "string") return values;
  if (entry.data.cwd !== undefined) return "ACP cannot pass a working directory";
  const { command, args } = entry.data;
  return { name, command: home(command), args: args.map(home), env: values };
}

function home(value: string): string {
  const prefix = "~/";
  return value.startsWith(prefix) ? join(homedir(), value.slice(prefix.length)) : value;
}

const VARIABLE = /\$\{(\w+)\}/g;

/** Why a value cannot be passed: it runs a command, which Pi alone can, or needs an unset variable. */
function problemOf(raw: string, env: Env): string | undefined {
  if (raw.startsWith("!")) return "a value runs a command";
  const missing = [...raw.matchAll(VARIABLE)].find(
    ([, variable = ""]) => env[variable] === undefined,
  );
  return missing ? `${missing[1]} is not set` : undefined;
}

/** `${VAR}` values from the environment, or why one cannot be passed. */
function expandAll(pairs: Record<string, string>, env: Env) {
  const listed = Object.entries(pairs);
  const problem = listed.map(([, raw]) => problemOf(raw, env)).find((reason) => reason);
  if (problem) return problem;
  return listed.map(([name, raw]) => ({
    name,
    value: raw.replaceAll(VARIABLE, (_, variable: string) => env[variable] ?? ""),
  }));
}
