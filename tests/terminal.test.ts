import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { expect, onTestFinished, test } from "vitest";

import { Terminals } from "../src/terminal.ts";
import { said, start } from "./support/pi.ts";

function terminals() {
  const updates: [string, string, string][] = [];
  const all = new Terminals((sessionId, terminalId, output) =>
    updates.push([sessionId, terminalId, output]),
  );
  onTestFinished(() => all.releaseAll());
  return { all, updates };
}

const node = (code: string) => ({ command: process.execPath, args: ["-e", code] });

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
  expect(updates.at(-1)).toStrictEqual(["s", terminalId, "hi $HOME"]);
});

test("output past the byte limit keeps its end", async () => {
  const { all } = terminals();
  const { terminalId } = all.create(
    { sessionId: "s", ...node("process.stdout.write('abcdefgh')"), outputByteLimit: 4 },
    "/",
  );
  await all.waitForExit("s", terminalId);
  expect(all.output("s", terminalId)).toMatchObject({ output: "efgh", truncated: true });
});

test("kill stops a running command; release stops it and forgets it", async () => {
  const { all } = terminals();
  const forever = node("setInterval(() => {}, 1000)");
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
  const forever = node("setInterval(() => {}, 1000)");
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
  expect((await stop()).initialize?.clientCapabilities?.terminal).toBe(true);
});
