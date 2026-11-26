import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, onTestFinished, test, vi } from "vitest";

import { collect, connect, identity, resolvable } from "./support/harness.ts";
import { allow, deny, readCall, type Step } from "./support/playback.ts";
import { answering, recorder } from "./support/record.ts";
import { scratchDir } from "./support/scratch.ts";

test("the client introduces itself as Pi and offers files, terminals, questions and nothing else", async () => {
  const { log, close } = await connect({ script: () => [] });
  onTestFinished(close);
  expect(log.initialize?.clientInfo).toStrictEqual(identity);
  expect(log.initialize?.clientCapabilities).toStrictEqual({
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    auth: { terminal: false },
    elicitation: { form: {}, url: {} },
    plan: {},
  });
});

test("a session reports the agent's choices, quota tier and early context usage", async () => {
  const { client, log, close } = await connect({ script: () => [], effortId: "thinking_level" });
  onTestFinished(close);
  const session = await client.newSession({ cwd: "/work" });
  expect(log.sessions[0]?.cwd).toBe("/work");
  expect(log.sessions[0]?.mcpServers).toStrictEqual([]);
  expect(session.choices("model").map((c) => c.value)).toStrictEqual(["gemini-a", "gemini-b"]);
  expect(session.current("thought_level")).toBe("high");
  expect(await session.select("thought_level", "low")).toBe("set");
  expect(log.config, "the effort is changed by the agent's own option id").toStrictEqual([
    ["thinking_level", "low"],
  ]);
  expect(session.choices("mode").map((c) => c.value)).toStrictEqual(["default", "auto"]);
  expect(session.tier).toBe("Test Tier");
  expect(session.usage).toStrictEqual({ used: 0, size: 1_000_000 });
});

test("choosing a model, effort or mode is confirmed by the agent; unknown values are refused", async () => {
  let changes = 0;
  const { client, log, close } = await connect({ script: () => [] }, { changed: () => changes++ });
  onTestFinished(close);
  const session = await client.newSession({ cwd: "/work" });
  const before = changes;
  expect(await session.select("model", "gemini-a")).toBe("unchanged");
  expect(await session.select("model", "gemini-b")).toBe("set");
  expect(await session.select("thought_level", "xhigh")).toBe("set");
  expect(await session.select("thought_level", "medium")).toBe("unavailable");
  expect(await session.select("mode", "auto")).toBe("set");
  expect(await session.select("mode", "yolo")).toBe("unavailable");
  expect(log.config).toStrictEqual([
    ["model", "gemini-b"],
    ["thought_level", "xhigh"],
    ["mode", "auto"],
  ]);
  expect(session.current("mode")).toBe("auto");
  expect(changes - before, "one change for each value the agent set").toBe(3);
});

test("a turn delivers thoughts, text, tool calls and the final usage in order", async () => {
  const steps: Step[] = [
    { think: "plan" },
    { say: "Reading. " },
    { tool: readCall },
    { usage: [1234, 1_000_000] },
    { update: { toolCallId: "t1", status: "completed", rawOutput: "alpha" } },
    { say: "Done." },
  ];
  const { client, log, close } = await connect({ script: () => steps });
  onTestFinished(close);
  const session = await client.newSession({ cwd: "/work" });
  const turn = session.startTurn([{ type: "text", text: "hello" }]);
  const events = await collect(turn);
  expect(log.prompts).toStrictEqual([[{ type: "text", text: "hello" }]]);
  expect(events.map((e) => e.type)).toStrictEqual(["thought", "text", "tool", "text", "end"]);
  const last = events.at(-1);
  expect.assert(last?.type === "end");
  expect(last.stopReason).toBe("end_turn");
  expect(last.usage?.inputTokens).toBe(60);
  expect(session.usage).toStrictEqual({ used: 1234, size: 1_000_000 });
  const tool = await session.watchTool("t1", undefined, () => {});
  expect({
    kind: tool?.kind,
    title: tool?.title,
    status: tool?.status,
    rawOutput: tool?.rawOutput,
    settled: tool?.settled,
  }).toStrictEqual({
    kind: "read",
    title: "File a.txt",
    status: "completed",
    rawOutput: "alpha",
    settled: true,
  });
  expect(session.turns).toBe(1);
});

test("watching a running tool reports progress and resolves when it finishes or its turn ends", async () => {
  const gate = resolvable();
  const steps: Step[] = [
    { tool: readCall },
    { tool: { toolCallId: "t2", kind: "execute", title: "sleep 9" } },
    { hold: gate.promise },
    { update: { toolCallId: "t1", title: "File b.txt" } },
    {
      update: {
        toolCallId: "t1",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "no such file" } }],
      },
    },
  ];
  const { client, close } = await connect({ script: () => steps });
  onTestFinished(close);
  const session = await client.newSession({ cwd: "/work" });
  const turn = session.startTurn([{ type: "text", text: "go" }]);
  expect((await turn.next()).type).toBe("tool");
  const batched = await vi.waitFor(() => {
    const tool = turn.takeTool();
    expect.assert(tool);
    return tool;
  });
  expect(batched.id).toBe("t2");
  expect(turn.takeTool()).toBe(undefined);
  const titles = recorder<string>();
  const first = session.watchTool("t1", undefined, (tool) => titles.record(tool.title));
  const second = session.watchTool("t2", undefined, () => {});
  gate.resolve();
  expect((await first)?.status).toBe("failed");
  expect(titles.all()).toStrictEqual(["File b.txt"]);
  expect(await second.then((tool) => [tool?.status, tool?.settled])).toStrictEqual([
    "pending",
    true,
  ]);
  expect(await session.watchTool("missing", undefined, () => {})).toBe(undefined);
});

test("an update to a tool call of an earlier turn is not a new tool call in the current one", async () => {
  const late = { toolCallId: "t1", status: "completed" as const };
  const { client, close } = await connect({
    script: (_prompt, n) =>
      n === 0
        ? [{ tool: { toolCallId: "t1", kind: "read", title: "File a.txt", status: "pending" } }]
        : [{ update: late }, { say: "second" }],
  });
  onTestFinished(close);
  const session = await client.newSession({ cwd: "/work" });
  await collect(session.startTurn([{ type: "text", text: "one" }]));
  const events = await collect(session.startTurn([{ type: "text", text: "two" }]));
  expect(events.map((event) => event.type)).toStrictEqual(["text", "end"]);
});

test("permission: the user's choice is passed on; no decision means the agent's deny option, never allow", async () => {
  const asked = recorder<string>();
  const next = answering([allow, undefined, undefined]);
  const steps: Step[] = [
    { tool: { toolCallId: "t1", kind: "edit", title: "File a.txt", status: "pending" } },
    { ask: "t1", allowed: [{ update: { toolCallId: "t1", status: "completed" } }] },
    { ask: "t2", declined: [{ update: { toolCallId: "t2", status: "failed" } }] },
    { ask: "t3", options: [allow] },
  ];
  const { client, log, close } = await connect(
    { script: () => steps },
    {
      askPermission: (tool, options) => {
        asked.record(`${tool.id}:${options.map((o) => o.kind).join("+")}`);
        const answer = next();
        return Promise.resolve(options.find((option) => option.optionId === answer?.optionId));
      },
    },
  );
  onTestFinished(close);
  const session = await client.newSession({ cwd: "/work" });
  const events = await collect(session.startTurn([{ type: "text", text: "edit" }]));
  expect(asked.all()).toStrictEqual([
    "t1:allow_once+reject_once",
    "t2:allow_once+reject_once",
    "t3:allow_once",
  ]);
  expect(log.outcomes).toStrictEqual([
    { outcome: "selected", optionId: "allow" },
    { outcome: "selected", optionId: "deny" },
    { outcome: "cancelled" },
  ]);
  const last = events.at(-1);
  expect.assert(last?.type === "end");
  expect(last.stopReason).toBe("cancelled");
  const decisions = await Promise.all(
    ["t1", "t2", "t3"].map((id) => session.watchTool(id, undefined, () => {})),
  );
  expect(decisions.map((tool) => tool?.decision)).toStrictEqual([
    "allowed",
    "declined",
    "declined",
  ]);
});

test("cancelling a turn tells the agent and withdraws an open permission question", async () => {
  let dismissed = false;
  const { client, log, close } = await connect(
    {
      script: (_prompt, n) =>
        n === 0 ? [{ ask: "t1" }, { say: "unreachable" }] : [{ hold: "cancel" }],
    },
    {
      askPermission: (_tool, _options, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            dismissed = true;
            resolve(deny);
          });
        }),
    },
  );
  onTestFinished(close);
  const session = await client.newSession({ cwd: "/work" });
  const first = session.startTurn([{ type: "text", text: "one" }]);
  expect((await first.next()).type).toBe("tool");
  await session.cancelTurn();
  const end = await first.next();
  expect(end.type === "end" && end.stopReason).toBe("cancelled");
  expect(dismissed).toBe(true);
  expect(log.outcomes).toStrictEqual([{ outcome: "cancelled" }]);
  session.endTurn(first);
  const second = session.startTurn([{ type: "text", text: "two" }]);
  await session.cancelTurn();
  expect((await second.next()).type).toBe("end");
  expect(log.cancels).toBe(2);
});

test("an agent error ends the turn with its message", async () => {
  const { client, close } = await connect({
    script: () => [{ say: "partial" }, { fail: "quota exhausted" }],
  });
  onTestFinished(close);
  const session = await client.newSession({ cwd: "/work" });
  const events = await collect(session.startTurn([{ type: "text", text: "hi" }]));
  const last = events.at(-1);
  expect.assert(last?.type === "failed");
  expect(last.message).toMatch(/quota exhausted/);
});

test("the agent reads and writes text files through the client", async () => {
  const dir = await scratchDir("fs");
  await writeFile(join(dir, "notes.txt"), "alpha\nbravo\n");
  const created = join(dir, "new", "made.txt");
  const { client, close } = await connect({
    script: (_prompt, n) =>
      n === 0
        ? [{ read: join(dir, "notes.txt") }, { write: [created, "charlie\n"] }]
        : [{ read: join(dir, "absent.txt") }],
  });
  onTestFinished(close);
  const session = await client.newSession({ cwd: dir });
  const events = await collect(session.startTurn([{ type: "text", text: "files" }]));
  expect(events[0]).toStrictEqual({ type: "text", text: "alpha\nbravo\n" });
  expect(await readFile(created, "utf8")).toBe("charlie\n");
  session.endTurn(session.turn);
  const failed = await collect(session.startTurn([{ type: "text", text: "missing" }]));
  expect(failed.at(-1)?.type).toBe("failed");
});

test("Pi writes files for the agent only inside the session's workspace", async () => {
  const dir = await scratchDir("fs");
  const work = join(dir, "work");
  await mkdir(work);
  const outside = join(dir, "outside.txt");
  const { client, close } = await connect({
    script: (_prompt, n) =>
      n === 0
        ? [{ write: [join(work, "..", "outside.txt"), "x"] }]
        : [{ write: [join(work, "deep", "inside.txt"), "y"] }, { say: "written" }],
  });
  onTestFinished(close);
  const session = await client.newSession({ cwd: work });
  const refused = await collect(session.startTurn([{ type: "text", text: "escape" }]));
  const last = refused.at(-1);
  expect.assert(last?.type === "failed");
  expect(last.message).toMatch(/workspace/);
  await expect(readFile(outside, "utf8")).rejects.toThrow();
  session.endTurn(session.turn);
  const allowed = await collect(session.startTurn([{ type: "text", text: "inside" }]));
  expect(allowed.at(-1)?.type).toBe("end");
  expect(await readFile(join(work, "deep", "inside.txt"), "utf8")).toBe("y");
});

test("Pi also writes for the agent inside the extra directories its session was given", async () => {
  const dir = await scratchDir("fs");
  const [work, extra] = [join(dir, "work"), join(dir, "extra")];
  await Promise.all([mkdir(work), mkdir(extra)]);
  const { client, close } = await connect({
    script: () => [{ write: [join(extra, "x.txt"), "z"] }],
  });
  onTestFinished(close);
  const session = await client.newSession({ cwd: work, directories: [extra] });
  const events = await collect(session.startTurn([{ type: "text", text: "write" }]));
  expect(events.at(-1)?.type).toBe("end");
  expect(await readFile(join(extra, "x.txt"), "utf8")).toBe("z");
});

test("a signed-out agent asks for sign-in before it reopens a saved session too", async () => {
  const saved = { s: [[{ type: "text" as const, text: "hello" }]] };
  const { client, close } = await connect({ script: () => [], signedOut: true, history: saved });
  onTestFinished(close);
  await expect(client.loadSession("s", { cwd: "/work" })).rejects.toThrow(/sign in/);
});
