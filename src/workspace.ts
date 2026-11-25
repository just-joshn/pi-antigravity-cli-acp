import { statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

import type { Workspace } from "./client.ts";
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
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** The workspace for a new or reopened agent session, and anything from the flags left out. */
export function workspaceFor(pi: ExtensionAPI, cwd: string, projectTrusted: boolean) {
  const notes: string[] = [];
  const listed = pi.getFlag("agy-dir");
  const directories = (typeof listed === "string" ? listed.split(delimiter) : [])
    .filter((entry) => entry.trim() !== "")
    .map((entry) => resolve(cwd, entry));
  for (const missing of directories.filter((dir) => !isDirectory(dir)))
    notes.push(`--agy-dir ${missing} is not a directory, so the agent does not get it.`);
  const where: Workspace = { cwd, directories: directories.filter(isDirectory) };
  if (pi.getFlag("agy-mcp") !== true) return { where, notes };
  const mcp = readPiMcpServers({
    agentDir: getAgentDir(),
    cwd,
    projectTrusted,
    env: process.env,
  });
  for (const reason of mcp.skipped) notes.push(`MCP server ${reason}; the agent does not get it.`);
  return { where: { ...where, mcpServers: mcp.servers }, notes };
}
