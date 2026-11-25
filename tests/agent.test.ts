import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Stream } from "@agentclientprotocol/sdk/unstable";
import { expect, onTestFinished, test } from "vitest";

import { findRegistryAgent, launch, registryRoot } from "../src/agent.ts";

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "pi-acp-agent-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Resolves when the agent's output ends, whether it exited cleanly or not. */
async function ended(stream: Stream) {
  const reader = stream.readable.getReader();
  try {
    // oxlint-disable-next-line no-await-in-loop -- drains the output until it ends
    while (!(await reader.read()).done);
  } catch {
    // A failed spawn ends the stream with an error.
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the registry directory falls back to USERPROFILE and Windows' default", () => {
  expect(registryRoot({ USERPROFILE: "/u" }, "darwin")).toMatch(/^\/u\/Library\//);
  expect(registryRoot({}, "linux")).toMatch(/^\.local\/share\/zed\//);
  expect(registryRoot({ HOME: "/h" }, "win32")).toMatch(/^\/h\/AppData\/Local\/Zed\//);
});

test("a missing or malformed registry listing falls back to the default server binary", async () => {
  const root = await scratch();
  expect(findRegistryAgent(root, "darwin-aarch64"), "nothing installed").toBeUndefined();
  await mkdir(join(root, "antigravity-acp", "unversioned"), { recursive: true });
  expect(findRegistryAgent(root, "darwin-aarch64"), "no version directory").toBeUndefined();

  const installed = join(root, "antigravity-acp", "v_1.0.0_a");
  await mkdir(installed);
  for (const name of ["agy_acp_server.par", "agy_acp_server.exe"])
    // oxlint-disable-next-line no-await-in-loop -- two small fixture files
    await writeFile(join(installed, name), "#!/bin/sh\n", { mode: 0o755 });
  const listings: unknown[] = [
    "not an object",
    { agents: "not a list" },
    { agents: [{ id: "antigravity-acp" }] },
    { agents: [{ id: "antigravity-acp", distribution: { binary: { "windows-x86_64": {} } } }] },
  ];
  for (const listing of listings) {
    // oxlint-disable-next-line no-await-in-loop -- each listing is checked in turn
    await writeFile(join(root, "registry.json"), JSON.stringify(listing));
    expect(findRegistryAgent(root, "windows-x86_64")?.command).toBe(
      join(installed, "agy_acp_server.exe"),
    );
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
  expect(findRegistryAgent(root, "linux-x86_64")?.args, "args that are not a list").toStrictEqual(
    [],
  );
});

test("stopping an agent that ignores SIGTERM kills it", async () => {
  const dir = await scratch();
  const pidFile = join(dir, "pid");
  const script = `trap "" TERM; echo $$ > "${pidFile}"; while :; do sleep 0.05; done`;
  const agent = launch({ kind: "cli", command: "sh", args: ["-c", script] }, dir);
  let pid = "";
  // oxlint-disable-next-line no-await-in-loop -- waits for the script to record its pid
  while (!pid) pid = await readFile(pidFile, "utf8").catch(() => "");
  agent.stop();
  await ended(agent.stream);
  expect(alive(Number(pid))).toBe(false);
});

test("stopping an agent that already exited, or never started, does nothing", async () => {
  const dir = await scratch();
  const exited = launch({ kind: "cli", command: "true", args: [] }, dir);
  await ended(exited.stream);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(() => exited.stop()).not.toThrow();

  const missing = launch({ kind: "cli", command: join(dir, "absent"), args: [] }, dir);
  await ended(missing.stream);
  expect(() => missing.stop()).not.toThrow();
});
