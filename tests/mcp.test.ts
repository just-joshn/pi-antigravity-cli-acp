import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { readPiMcpServers } from "../src/mcp.ts";
import { scratchDir } from "./support/scratch.ts";

const write = (file: string, servers: unknown) =>
  writeFile(file, JSON.stringify({ mcpServers: servers }));

async function scratch() {
  const dir = await scratchDir("mcp");
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "work");
  await Promise.all([mkdir(agentDir), mkdir(join(cwd, ".pi"), { recursive: true })]);
  return {
    agentDir,
    cwd,
    user: (servers: unknown) => write(join(agentDir, "mcp.json"), servers),
    project: (servers: unknown) => write(join(cwd, ".pi", "mcp.json"), servers),
  };
}

test("Pi's stdio and HTTP servers become ACP servers, with variables and ~ expanded", async () => {
  const s = await scratch();
  await s.user({
    files: { command: "~/bin/fs", args: ["~/notes", "x"], env: { TOKEN: "${FS_TOKEN}" } },
    docs: { url: "https://docs.example/mcp", headers: { Authorization: "Bearer ${DOCS}" } },
    off: { command: "off", enabled: false },
  });
  const env = { FS_TOKEN: "t1", DOCS: "d2" };
  const read = readPiMcpServers({ agentDir: s.agentDir, cwd: s.cwd, projectTrusted: false, env });
  expect(read.servers).toStrictEqual([
    {
      name: "files",
      command: join(homedir(), "bin/fs"),
      args: [join(homedir(), "notes"), "x"],
      env: [{ name: "TOKEN", value: "t1" }],
    },
    {
      type: "http",
      name: "docs",
      url: "https://docs.example/mcp",
      headers: [{ name: "Authorization", value: "Bearer d2" }],
    },
  ]);
  expect(read.skipped).toStrictEqual([]);
});

test("servers Pi alone can run are skipped with the reason", async () => {
  const s = await scratch();
  await s.user({
    shelled: { command: "x", env: { KEY: "!pass show key" } },
    unset: { command: "x", env: { KEY: "${NOT_SET_ANYWHERE}" } },
    placed: { command: "x", cwd: "sub" },
    signed: { url: "https://a.example/mcp", oauth: { clientId: "c" } },
    sse: { type: "sse", url: "https://b.example/sse" },
    "bad name": { command: "x" },
  });
  const read = readPiMcpServers({
    agentDir: s.agentDir,
    cwd: s.cwd,
    projectTrusted: false,
    env: {},
  });
  expect(read.servers).toStrictEqual([]);
  expect(read.skipped).toStrictEqual([
    "shelled: a value runs a command",
    "unset: NOT_SET_ANYWHERE is not set",
    "placed: ACP cannot pass a working directory",
    "signed: Pi signs in to it with OAuth",
    "sse: the SSE transport is not supported",
    "bad name: the name has characters Pi does not allow",
  ]);
});

test("a trusted project's servers replace or switch off the user's; an untrusted project is ignored", async () => {
  const s = await scratch();
  await s.user({ a: { command: "user-a" }, b: { command: "user-b" } });
  await s.project({
    a: { command: "project-a" },
    b: { enabled: false },
    c: { command: "project-c" },
  });
  const names = (projectTrusted: boolean) =>
    readPiMcpServers({ agentDir: s.agentDir, cwd: s.cwd, projectTrusted, env: {} }).servers.map(
      (server) => ("command" in server ? server.command : server.name),
    );
  expect(names(false)).toStrictEqual(["user-a", "user-b"]);
  expect(names(true)).toStrictEqual(["project-a", "project-c"]);
});

test("missing or malformed files give no servers", async () => {
  const s = await scratch();
  const read = () =>
    readPiMcpServers({ agentDir: s.agentDir, cwd: s.cwd, projectTrusted: true, env: {} });
  expect(read()).toStrictEqual({ servers: [], skipped: [] });
  await writeFile(join(s.agentDir, "mcp.json"), "{");
  expect(read().servers).toStrictEqual([]);
  await s.user(["not", "an", "object"]);
  expect(read().servers).toStrictEqual([]);
  await s.user({ odd: "not an object", nums: { command: "x", args: [1] } });
  expect(read().skipped).toStrictEqual(["odd: not a server entry", "nums: not a server entry"]);
  await s.user({ nulled: { command: "/bin/x", url: null } });
  expect(read().servers, "a url that is not text does not make a server HTTP").toStrictEqual([
    { name: "nulled", command: "/bin/x", args: [], env: [] },
  ]);
  await s.user({ blank: { command: "" }, nowhere: { url: "" } });
  expect(read()).toStrictEqual({
    servers: [],
    skipped: ["blank: not a server entry", "nowhere: not a server entry"],
  });
});
