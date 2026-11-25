import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { TurnEvent } from "../src/session.ts";
import { allow, deny, type Step } from "./support/fake-agent.ts";
import { connect, deferred, identity } from "./support/harness.ts";

const readCall = {
  toolCallId: "t1",
  kind: "read" as const,
  title: "File a.txt",
  status: "in_progress" as const,
};

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    // oxlint-disable-next-line no-await-in-loop -- polling for an event that arrives asynchronously
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("value never arrived");
}

async function collect(turn: { next(): Promise<TurnEvent> }) {
  const events: TurnEvent[] = [];
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- events are read in order until the turn ends
    const event = await turn.next();
    events.push(event);
    if (event.type === "end" || event.type === "failed") return events;
  }
}

await test("the client introduces itself as Pi and offers file access but no terminal", async (t) => {
  const { log, close } = await connect({ script: () => [] });
  t.after(close);
  assert.deepEqual(log.initialize?.clientInfo, identity);
  assert.deepEqual(log.initialize?.clientCapabilities?.fs, {
    readTextFile: true,
    writeTextFile: true,
  });
  assert.equal(log.initialize?.clientCapabilities?.terminal, false);
});

await test("a session reports the agent's choices, quota tier and early context usage", async (t) => {
  const { client, log, close } = await connect({ script: () => [], effortId: "thinking_level" });
  t.after(close);
  const session = await client.newSession("/work");
  assert.equal(log.sessions[0]?.cwd, "/work");
  assert.deepEqual(log.sessions[0]?.mcpServers, []);
  assert.deepEqual(
    session.choices("model").map((c) => c.value),
    ["gemini-a", "gemini-b"],
  );
  assert.equal(session.current("thought_level"), "high");
  assert.deepEqual(
    session.choices("mode").map((c) => c.value),
    ["default", "auto"],
  );
  assert.equal(session.tier, "Test Tier");
  assert.deepEqual(session.usage, { used: 0, size: 1_000_000 });
});

await test("choosing a model, effort or mode is confirmed by the agent; unknown values are refused", async (t) => {
  let changes = 0;
  const { client, log, close } = await connect({ script: () => [] }, { changed: () => changes++ });
  t.after(close);
  const session = await client.newSession("/work");
  assert.equal(await session.select("model", "gemini-a"), "unchanged");
  assert.equal(await session.select("model", "gemini-b"), "set");
  assert.equal(await session.select("thought_level", "xhigh"), "set");
  assert.equal(await session.select("thought_level", "medium"), "unavailable");
  assert.equal(await session.select("mode", "auto"), "set");
  assert.equal(await session.select("mode", "yolo"), "unavailable");
  assert.deepEqual(log.config, [
    ["model", "gemini-b"],
    ["thought_level", "xhigh"],
    ["mode", "auto"],
  ]);
  assert.equal(session.current("mode"), "auto");
  assert.ok(changes >= 3);
});

await test("a turn delivers thoughts, text, tool calls and the final usage in order", async (t) => {
  const steps: Step[] = [
    { think: "plan" },
    { say: "Reading. " },
    { tool: readCall },
    { usage: [1234, 1_000_000] },
    { update: { toolCallId: "t1", status: "completed", rawOutput: "alpha" } },
    { say: "Done." },
  ];
  const { client, log, close } = await connect({ script: () => steps });
  t.after(close);
  const session = await client.newSession("/work");
  const turn = session.startTurn([{ type: "text", text: "hello" }]);
  const events = await collect(turn);
  assert.deepEqual(log.prompts, [[{ type: "text", text: "hello" }]]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["thought", "text", "tool", "text", "end"],
  );
  const last = events.at(-1);
  assert.ok(last?.type === "end");
  assert.equal(last.stopReason, "end_turn");
  assert.equal(last.usage?.inputTokens, 60);
  assert.deepEqual(session.usage, { used: 1234, size: 1_000_000 });
  const tool = await session.watchTool("t1", undefined, () => {});
  assert.deepEqual(
    {
      kind: tool?.kind,
      title: tool?.title,
      status: tool?.status,
      rawOutput: tool?.rawOutput,
      settled: tool?.settled,
    },
    { kind: "read", title: "File a.txt", status: "completed", rawOutput: "alpha", settled: true },
  );
  assert.equal(session.turns, 1);
});

await test("watching a running tool reports progress and resolves when it finishes or its turn ends", async (t) => {
  const gate = deferred();
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
  t.after(close);
  const session = await client.newSession("/work");
  const turn = session.startTurn([{ type: "text", text: "go" }]);
  assert.equal((await turn.next()).type, "tool");
  assert.equal((await eventually(() => turn.takeTool())).id, "t2");
  assert.equal(turn.takeTool(), undefined);
  const titles: string[] = [];
  const first = session.watchTool("t1", undefined, (tool) => titles.push(tool.title));
  const second = session.watchTool("t2", undefined, () => {});
  gate.resolve();
  assert.equal((await first)?.status, "failed");
  assert.deepEqual(titles, ["File b.txt"]);
  assert.deepEqual(await second.then((tool) => [tool?.status, tool?.settled]), ["pending", true]);
  assert.equal(await session.watchTool("missing", undefined, () => {}), undefined);
});

await test("permission: the user's choice is passed on; no decision means the agent's deny option, never allow", async (t) => {
  const asked: string[] = [];
  const answers = [allow, undefined, undefined];
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
        asked.push(`${tool.id}:${options.map((o) => o.kind).join("+")}`);
        const answer = answers.shift();
        return Promise.resolve(options.find((option) => option.optionId === answer?.optionId));
      },
    },
  );
  t.after(close);
  const session = await client.newSession("/work");
  const events = await collect(session.startTurn([{ type: "text", text: "edit" }]));
  assert.deepEqual(asked, [
    "t1:allow_once+reject_once",
    "t2:allow_once+reject_once",
    "t3:allow_once",
  ]);
  assert.deepEqual(log.outcomes, [
    { outcome: "selected", optionId: "allow" },
    { outcome: "selected", optionId: "deny" },
    { outcome: "cancelled" },
  ]);
  const last = events.at(-1);
  assert.ok(last?.type === "end");
  assert.equal(last.stopReason, "cancelled");
  const decisions = await Promise.all(
    ["t1", "t2", "t3"].map((id) => session.watchTool(id, undefined, () => {})),
  );
  assert.deepEqual(
    decisions.map((tool) => tool?.decision),
    ["allowed", "declined", "declined"],
  );
});

await test("cancelling a turn tells the agent and withdraws an open permission question", async (t) => {
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
  t.after(close);
  const session = await client.newSession("/work");
  const first = session.startTurn([{ type: "text", text: "one" }]);
  assert.equal((await first.next()).type, "tool");
  await session.cancelTurn();
  const end = await first.next();
  assert.equal(end.type === "end" && end.stopReason, "cancelled");
  assert.ok(dismissed);
  assert.deepEqual(log.outcomes, [{ outcome: "cancelled" }]);
  session.endTurn(first);
  const second = session.startTurn([{ type: "text", text: "two" }]);
  await session.cancelTurn();
  assert.equal((await second.next()).type, "end");
  assert.equal(log.cancels, 2);
});

await test("an agent error ends the turn with its message", async (t) => {
  const { client, close } = await connect({
    script: () => [{ say: "partial" }, { fail: "quota exhausted" }],
  });
  t.after(close);
  const session = await client.newSession("/work");
  const events = await collect(session.startTurn([{ type: "text", text: "hi" }]));
  const last = events.at(-1);
  assert.ok(last?.type === "failed");
  assert.match(last.message, /quota exhausted/);
});

await test("the agent reads and writes text files through the client", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-acp-fs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "notes.txt"), "alpha\nbravo\n");
  const created = join(dir, "new", "made.txt");
  const { client, close } = await connect({
    script: (_prompt, n) =>
      n === 0
        ? [{ read: join(dir, "notes.txt") }, { write: [created, "charlie\n"] }]
        : [{ read: join(dir, "absent.txt") }],
  });
  t.after(close);
  const session = await client.newSession(dir);
  const events = await collect(session.startTurn([{ type: "text", text: "files" }]));
  assert.deepEqual(events[0], { type: "text", text: "alpha\nbravo\n" });
  assert.equal(await readFile(created, "utf8"), "charlie\n");
  session.endTurn(session.turn);
  const failed = await collect(session.startTurn([{ type: "text", text: "missing" }]));
  assert.equal(failed.at(-1)?.type, "failed");
});

await test("Pi writes files for the agent only inside the session's workspace", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-acp-fs-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const work = join(dir, "work");
  await mkdir(work);
  const outside = join(dir, "outside.txt");
  const { client, close } = await connect({
    script: (_prompt, n) =>
      n === 0
        ? [{ write: [join(work, "..", "outside.txt"), "x"] }]
        : [{ write: [join(work, "deep", "inside.txt"), "y"] }, { say: "written" }],
  });
  t.after(close);
  const session = await client.newSession(work);
  const refused = await collect(session.startTurn([{ type: "text", text: "escape" }]));
  const last = refused.at(-1);
  assert.ok(last?.type === "failed");
  assert.match(last.message, /workspace/);
  await assert.rejects(readFile(outside, "utf8"));
  session.endTurn(session.turn);
  const allowed = await collect(session.startTurn([{ type: "text", text: "inside" }]));
  assert.equal(allowed.at(-1)?.type, "end");
  assert.equal(await readFile(join(work, "deep", "inside.txt"), "utf8"), "y");
});
