import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { expect, test } from "vitest";

import { fakeUi, start } from "./support/pi.ts";

/** Prepares a scratch HOME whose Pi configuration lists these MCP servers. */
const withMcp = (servers: unknown) => async (dir: string) => {
  await mkdir(join(dir, "pi"), { recursive: true });
  await writeFile(join(dir, "pi", "mcp.json"), JSON.stringify({ mcpServers: servers }));
};

test("--agy-dir passes extra directories, resolved from the workspace, and reports missing ones", async () => {
  const { ui, notes } = fakeUi();
  const flags = { "agy-dir": ["lib", "/no/such/dir", ""].join(delimiter) };
  const { session, stop, work } = await start({
    ui,
    flags,
    setup: async (dir) => {
      await mkdir(join(dir, "work", "lib"), { recursive: true });
    },
  });
  await session.prompt("hello");
  const log = await stop();
  expect(log.sessions[0]?.additionalDirectories).toStrictEqual([join(work, "lib")]);
  expect(notes()).toContain(
    "warning: --agy-dir /no/such/dir is not a directory, so the agent does not get it.",
  );
});

test("--agy-mcp gives the agent Pi's stdio MCP servers; without it the agent gets none", async () => {
  const setup = withMcp({ files: { command: "/bin/fs-mcp", args: ["."] } });
  const on = await start({ flags: { "agy-mcp": true }, setup });
  await on.session.prompt("hello");
  expect((await on.stop()).sessions[0]?.mcpServers).toStrictEqual([
    { name: "files", command: "/bin/fs-mcp", args: ["."], env: [] },
  ]);
  const off = await start({ setup });
  await off.session.prompt("hello");
  expect((await off.stop()).sessions[0]?.mcpServers).toStrictEqual([]);
});

test("--agy-mcp says which HTTP servers an agent without HTTP support does not get", async () => {
  const { ui, notes } = fakeUi();
  const setup = withMcp({ docs: { url: "https://docs.example/mcp" } });
  const { session, stop } = await start({ ui, flags: { "agy-mcp": true }, setup });
  await session.prompt("hello");
  expect(notes()).toContain(
    "warning: MCP server docs: this agent takes no HTTP servers; it does not get it.",
  );
  expect((await stop()).sessions[0]?.mcpServers).toStrictEqual([]);
});
