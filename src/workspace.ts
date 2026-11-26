import { statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

import type { Workspace } from "./client.ts";
import { readFlags } from "./flags.ts";
import { readPiMcpServers } from "./mcp.ts";

export function registerWorkspaceFlags(pi: ExtensionAPI) {
  pi.registerFlag("agy-dir", {
    type: "string",
    description: `More directories the Antigravity agent may work in, separated by "${delimiter}"`,
  });
  pi.registerFlag("agy-mcp", {
    type: "boolean",
    description: "Give the Antigravity agent Pi's configured MCP servers, besides its own",
  });
}

function isDirectory(path: string) {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    // A directory Pi may not look into is reported like a missing one.
    return false;
  }
}

/** The workspace for a new or reopened agent session, and anything from the flags left out. */
export function workspaceFor(pi: ExtensionAPI, cwd: string, projectTrusted: boolean) {
  const flags = readFlags(pi);
  const directories = flags.directories.map((entry) => resolve(cwd, entry));
  const found = directories.filter(isDirectory);
  const notes = directories
    .filter((dir) => !found.includes(dir))
    .map((missing) => `--agy-dir ${missing} is not a directory, so the agent does not get it.`);
  const where: Workspace = { cwd, directories: found };
  if (!flags.mcp) return { where, notes };
  const mcp = readPiMcpServers({
    agentDir: getAgentDir(),
    cwd,
    projectTrusted,
    env: process.env,
  });
  const skipped = mcp.skipped.map((reason) => `MCP server ${reason}; the agent does not get it.`);
  return { where: { ...where, mcpServers: mcp.servers }, notes: [...notes, ...skipped] };
}
