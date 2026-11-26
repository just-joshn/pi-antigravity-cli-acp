import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { expect, onTestFinished, test, vi } from "vitest";

import { Terminals } from "../src/terminal.ts";
import { said, start } from "./support/pi.ts";
import { recorder } from "./support/record.ts";
import { alive, scratchDir } from "./support/scratch.ts";

function terminals() {
  const updates = recorder<[string, string, string | undefined]>();
  const all = new Terminals((sessionId, terminalId, output) =>
    updates.record([sessionId, terminalId, output]),
  );
  onTestFinished(() => all.releaseAll());
  return { all, updates: updates.all };
}

/** Waits for a terminal's output with real timers; vi.waitFor would run a faked setImmediate. */
async function outputIs(all: Terminals, terminalId: string, expected: string): Promise<void> {
  if (all.output("s", terminalId).output === expected) return;
  await new Promise((resolve) => setTimeout(resolve, 10));
  return outputIs(all, terminalId, expected);
}

const node = (code: string) => ({ command: process.execPath, args: ["-e", code] });
const forever = node("setInterval(() => {}, 1000)");

test("a command runs without a shell, and its output and exit status are reported", async () => {
  const { all, updates } = terminals();
  const { terminalId } = all.create(
    {
      sessionId: "s",
      ...node("process.stdout.write(process.env.GREETING + ' $HOME'); process.exit(3)"),
      env: [{ name: "GREETING", value: "hi" }],
    },
    "/",
  );
  expect(await all.waitForExit("s", terminalId)).toStrictEqual({ exitCode: 3, signal: null });
  expect(all.output("s", terminalId)).toStrictEqual({
    output: "hi $HOME",
    truncated: false,
    exitStatus: { exitCode: 3, signal: null },
  });
  expect(updates().at(-1)).toStrictEqual(["s", terminalId, "hi $HOME"]);
});

test("output past the byte limit keeps its end", async () => {
  const { all } = terminals();
  const { terminalId } = all.create(
    { sessionId: "s", ...node("process.stdout.write('abcdefgh')"), outputByteLimit: 4 },
    "/",
  );
  await all.waitForExit("s", terminalId);
  expect(all.output("s", terminalId)).toMatchObject({ output: "efgh", truncated: true });
  for (const outputByteLimit of [0, -5]) {
    const none = all.create(
      { sessionId: "s", ...node("process.stdout.write('ab')"), outputByteLimit },
      "/",
    );
    // oxlint-disable-next-line no-await-in-loop -- one command at a time
    await all.waitForExit("s", none.terminalId);
    expect(all.output("s", none.terminalId), `limit ${outputByteLimit}`).toMatchObject({
      output: "",
      truncated: true,
    });
  }
});

test("kill stops a running command; release stops it and forgets it", async () => {
  const { all } = terminals();
  const killed = all.create({ sessionId: "s", ...forever }, "/").terminalId;
  all.kill("s", killed);
  expect(await all.waitForExit("s", killed)).toStrictEqual({ exitCode: null, signal: "SIGTERM" });
  const released = all.create({ sessionId: "s", ...forever }, "/").terminalId;
  const exited = all.waitForExit("s", released);
  all.release("s", released);
  expect((await exited).signal).toBe("SIGTERM");
  expect(() => all.output("s", released)).toThrow(RequestError);
  const other = all.create({ sessionId: "s", ...forever }, "/").terminalId;
  expect(() => all.output("t", other), "another session's terminal").toThrow(RequestError);
});

test("a command that cannot start ends at once with the reason as output", async () => {
  const { all } = terminals();
  const { terminalId } = all.create({ sessionId: "s", command: "/no/such/program" }, "/");
  expect(await all.waitForExit("s", terminalId)).toStrictEqual({ exitCode: null, signal: null });
  expect(all.output("s", terminalId).output).toMatch(/ENOENT/);
});

test("a relative working directory is refused; ending a session releases its terminals", async () => {
  const { all } = terminals();
  expect(() => all.create({ sessionId: "s", command: "true", cwd: "relative" }, "/")).toThrow(
    RequestError,
  );
  const a = all.create({ sessionId: "a", ...forever }, "/").terminalId;
  const b = all.create({ sessionId: "b", ...forever }, "/").terminalId;
  const exited = all.waitForExit("a", a);
  all.releaseSession("a");
  expect((await exited).signal).toBe("SIGTERM");
  expect(all.output("b", b).exitStatus).toBeUndefined();
});

test("a command the agent runs through Pi shows its output in the tool row", async () => {
  const { session, stop, work } = await start();
  await session.prompt("run it");
  const result = session.messages.find((message) => message.role === "toolResult");
  expect(result?.content).toStrictEqual([{ type: "text", text: `ran in ${work}` }]);
  expect(said(session.messages.findLast((m) => m.role === "assistant"))).toBe(
    `exit 0: ran in ${work}`,
  );
  await stop();
});

test("the agent cannot raise the output kept past 1 MiB", async () => {
  const { all } = terminals();
  const code = "process.stdout.write('x'.repeat(3 * 1024 * 1024))";
  const { terminalId } = all.create({ sessionId: "s", ...node(code), outputByteLimit: 1e9 }, "/");
  await all.waitForExit("s", terminalId);
  const { output, truncated } = all.output("s", terminalId);
  expect([output.length, truncated]).toStrictEqual([1024 * 1024, true]);
});

test("stopping a command stops what it started, and a child left behind does not hold up its exit", async () => {
  const { all } = terminals();
  const dir = await scratchDir("term");
  const pidFile = join(dir, "child");
  const parent = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
  const { terminalId } = all.create({ sessionId: "s", ...node(parent) }, "/");
  await vi.waitFor(async () => expect(await readFile(pidFile, "utf8")).toMatch(/\d/));
  const child = Number(await readFile(pidFile, "utf8"));
  all.release("s", terminalId);
  await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 3000 });

  const daemon = `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "inherit", detached: true }).unref();`;
  const quick = all.create({ sessionId: "s", ...node(daemon) }, "/").terminalId;
  const started = Date.now();
  expect(await all.waitForExit("s", quick)).toStrictEqual({ exitCode: 0, signal: null });
  expect(
    Date.now() - started,
    "the exit is reported though the daemon keeps the output open",
  ).toBeLessThan(3000);
});

test("a command still running when the agent process dies is stopped", async () => {
  const { session, work } = await start();
  await session.prompt("runaway command");
  const pid = Number(await readFile(join(work, "runaway.pid"), "utf8"));
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
});

test("releasing a command that has exited still stops what it left running", async () => {
  const { all } = terminals();
  const dir = await scratchDir("term");
  const pidFile = join(dir, "child");
  const code = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); c.unref(); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`;
  const { terminalId } = all.create({ sessionId: "s", ...node(code) }, "/");
  await all.waitForExit("s", terminalId);
  const child = Number(await readFile(pidFile, "utf8"));
  onTestFinished(() => {
    if (alive(child)) process.kill(child, "SIGKILL");
  });
  all.release("s", terminalId);
  await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 3000 });
});

test("a child that ignores SIGTERM is killed even after the command itself exits", async () => {
  const { all } = terminals();
  const dir = await scratchDir("term");
  const pidFile = join(dir, "child");
  const stubborn = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const code = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(stubborn)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
  const { terminalId } = all.create({ sessionId: "s", ...node(code) }, "/");
  await vi.waitFor(async () => expect(await readFile(pidFile, "utf8")).toMatch(/\d/));
  const child = Number(await readFile(pidFile, "utf8"));
  onTestFinished(() => {
    if (alive(child)) process.kill(child, "SIGKILL");
  });
  all.release("s", terminalId);
  await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 4000 });
});

test("a character split across two writes is kept whole", async () => {
  const { all } = terminals();
  const code =
    "process.stdout.write(Buffer.from([0xe2, 0x82])); setTimeout(() => process.stdout.write(Buffer.from([0xac])), 50);";
  const { terminalId } = all.create({ sessionId: "s", ...node(code) }, "/");
  await all.waitForExit("s", terminalId);
  expect(all.output("s", terminalId).output).toBe("€");
});

test("output that arrives just before release is still reported", async () => {
  vi.useFakeTimers({ toFake: ["setImmediate"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const { all, updates } = terminals();
  const { terminalId } = all.create(
    { sessionId: "s", ...node("process.stdout.write('last'); setInterval(() => {}, 1000)") },
    "/",
  );
  await outputIs(all, terminalId, "last");
  all.release("s", terminalId);
  expect(updates()).toStrictEqual([
    ["s", terminalId, "last"],
    ["s", terminalId, undefined],
  ]);
});

test("output the agent reads is reported at once, so a tool finished just after shows it", async () => {
  vi.useFakeTimers({ toFake: ["setImmediate"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const { all, updates } = terminals();
  const { terminalId } = all.create(
    { sessionId: "s", ...node("process.stdout.write('done'); setInterval(() => {}, 1000)") },
    "/",
  );
  await outputIs(all, terminalId, "done");
  expect(updates()).toStrictEqual([["s", terminalId, "done"]]);
});
