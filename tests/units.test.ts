import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, onTestFinished, test } from "vitest";

import { findRegistryAgent, registryRoot, resolveAgent } from "../src/agent.ts";
import {
  effortFor,
  emptyCatalog,
  learn,
  piModels,
  readCatalog,
  writeCatalog,
} from "../src/catalog.ts";
import { AcpError } from "../src/client.ts";
import { callLine, changedLines, resultLines } from "../src/render.ts";
import type { ToolView } from "../src/session.ts";
import { AcpSession, type AgentPort } from "../src/session.ts";
import { haltTurn, planTurn, renderHistory } from "../src/stream.ts";
import { choiceLabels, toolArguments, toolResult } from "../src/tool.ts";
import { connect, resolvable } from "./support/harness.ts";

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "pi-acp-unit-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function program(file: string) {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "#!/bin/sh\n");
  await chmod(file, 0o755);
}

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const details = (patch: object) => ({ ...toolResult(view({}), "done").details, ...patch });
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const result = (toolCallId: string) => ({
  role: "toolResult" as const,
  toolCallId,
  toolName: "antigravity_tool",
  content: [{ type: "text" as const, text: "out" }],
  isError: false,
  timestamp: 3,
});
const option = (name: string, kind: "allow_once" | "reject_once", optionId: string) => ({
  name,
  kind,
  optionId,
});
function view(patch: Partial<ToolView>): ToolView {
  return {
    id: "t1",
    kind: "edit",
    title: "File a.txt",
    paths: [],
    status: "completed",
    content: [],
    rawOutput: undefined,
    decision: undefined,
    settled: true,
    ...patch,
  };
}

test("the catalog learns every model's thinking levels from one session", async () => {
  const listed = await connect({ script: () => [] });
  onTestFinished(listed.close);
  const first = learn(emptyCatalog, await listed.client.newSession("/work"));
  expect(first.models).toStrictEqual([
    { id: "gemini-a", name: "Gemini A", efforts: ["low", "medium", "high"] },
    { id: "gemini-b", name: "Gemini B", efforts: ["low", "high", "xhigh"] },
  ]);
  expect(first.modes.map((mode) => mode.value)).toStrictEqual(["default", "auto"]);
  expect(first.contextWindow).toBe(1_000_000);

  const unlisted = await connect({ script: () => [], variants: false });
  onTestFinished(unlisted.close);
  const session = await unlisted.client.newSession("/work");
  const guessed = learn(emptyCatalog, session);
  expect(guessed.models[1]?.efforts, "assumed until selected").toStrictEqual([
    "low",
    "medium",
    "high",
  ]);
  await session.select("model", "gemini-b");
  expect(learn(guessed, session).models).toStrictEqual([
    { id: "gemini-a", name: "Gemini A", efforts: ["low", "medium", "high"] },
    { id: "gemini-b", name: "Gemini B", efforts: ["low", "high", "xhigh"] },
  ]);
});

test("thinking levels are read off model ids that share a prefix with another model", async () => {
  const agent = await connect({
    script: () => [],
    models: [
      { id: "g", name: "G", efforts: ["low", "high"] },
      { id: "g-pro", name: "G Pro", efforts: ["low"] },
      { id: "g-lite", name: "G Lite", efforts: [] },
    ],
  });
  onTestFinished(agent.close);
  const session = await agent.client.newSession("/work");
  expect(session.variants).toStrictEqual(["g-low", "g-high", "g-pro-low", "g-lite"]);
  expect(learn(emptyCatalog, session).models.map((m) => [m.id, m.efforts])).toStrictEqual([
    ["g", ["low", "high"]],
    ["g-pro", ["low"]],
    ["g-lite", []],
  ]);
});

test("Pi models mark thinking levels the agent lacks as unsupported", () => {
  const models = piModels({
    models: [
      { id: "g", name: "G", efforts: ["low", "high"] },
      { id: "fixed", name: "Fixed", efforts: [] },
    ],
    modes: [],
    contextWindow: 2000,
  });
  expect(models.map((model) => [model.id, model.reasoning, model.contextWindow])).toStrictEqual([
    ["default", false, 2000],
    ["g", true, 2000],
    ["fixed", false, 2000],
  ]);
  const [, adjustable, fixed] = models;
  expect.assert(adjustable && fixed);
  expect(adjustable.thinkingLevelMap).toStrictEqual({
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  });
  expect(effortFor(adjustable, "high")).toBe("high");
  expect(effortFor(adjustable, "medium")).toBe(undefined);
  expect(effortFor(adjustable, undefined)).toBe(undefined);
  expect(effortFor(fixed, "high")).toBe(undefined);
});

test("a saved catalog round-trips; a missing or malformed one is ignored", async () => {
  const dir = await scratch();
  const file = join(dir, "nested", "catalog.json");
  expect(readCatalog(file)).toStrictEqual(emptyCatalog);
  const catalog = {
    models: [{ id: "g", name: "G", efforts: ["low"] }],
    modes: [{ value: "default", name: "Default", description: "Ask first" }],
    contextWindow: 123,
  };
  writeCatalog(file, catalog);
  expect(readCatalog(file)).toStrictEqual(catalog);
  const bad = [
    "{",
    "[]",
    '{"models":[{"id":1,"name":"x","efforts":[]}],"modes":[]}',
    '{"models":[{"id":"x","name":"x","efforts":[1]}],"modes":[]}',
    '{"models":[],"modes":[{"value":1}]}',
    '{"models":[]}',
  ];
  for (const text of bad) {
    // oxlint-disable-next-line no-await-in-loop -- each case overwrites the same file
    await writeFile(file, text);
    expect(readCatalog(file), text).toStrictEqual(emptyCatalog);
  }
  await writeFile(file, '{"models":[],"modes":[{"value":"m","name":"M"}],"contextWindow":-5}');
  expect(readCatalog(file)).toStrictEqual({
    models: [],
    modes: [{ value: "m", name: "M", description: undefined }],
    contextWindow: emptyCatalog.contextWindow,
  });
});

test("agent choice: the CLI by default, an editor's newest registry copy on request or as fallback", async () => {
  const home = await scratch();
  const bin = join(home, "bin");
  const root = registryRoot({ HOME: home }, "darwin");
  expect(root).toBe(
    join(home, "Library", "Application Support", "Zed", "external_agents", "registry"),
  );
  expect(registryRoot({ HOME: "/h" }, "linux")).toMatch(/^\/h\/\.local\/share\/zed\//);
  expect(registryRoot({ HOME: "/h", XDG_DATA_HOME: "/x" }, "linux")).toMatch(/^\/x\/zed\//);
  expect(registryRoot({ LOCALAPPDATA: "/l" }, "win32")).toMatch(/^\/l\/Zed\//);

  const env = { HOME: home, PATH: bin };
  expect(() => resolveAgent("auto", env, "darwin", "arm64")).toThrow(AcpError);
  expect(() => resolveAgent("registry", env, "darwin", "arm64")).toThrow(/Zed/);
  expect(() => resolveAgent("cli", env, "darwin", "arm64")).toThrow(/agy.*PATH/);

  const older = join(root, "antigravity-acp", "v_1.5.2_aaaa", "agy_acp_server.par");
  const newer = join(root, "antigravity-acp", "v_1.10.0_bbbb", "agy_acp_server.par");
  await Promise.all([program(older), program(newer)]);
  await mkdir(join(root, "antigravity-acp", "not-a-version"));
  expect(resolveAgent("auto", env, "darwin", "arm64")).toStrictEqual({
    kind: "registry",
    command: newer,
    args: [],
  });

  await writeFile(
    join(root, "registry.json"),
    JSON.stringify({
      agents: [
        { id: "other" },
        {
          id: "antigravity-acp",
          distribution: {
            binary: { "linux-x86_64": { cmd: "./agy_acp_server.par", args: ["--uid=", 7] } },
          },
        },
      ],
    }),
  );
  expect(findRegistryAgent(root, "linux-x86_64")).toStrictEqual({
    kind: "registry",
    command: newer,
    args: ["--uid="],
  });
  expect(findRegistryAgent(root, "darwin-aarch64")?.args).toStrictEqual([]);

  await program(join(bin, "agy"));
  expect(resolveAgent("auto", env, "darwin", "arm64")).toStrictEqual({
    kind: "cli",
    command: "agy",
    args: ["acp"],
  });
  expect(resolveAgent("registry", env, "darwin", "arm64").kind).toBe("registry");
  await chmod(newer, 0o644);
  expect(findRegistryAgent(root, "darwin-aarch64"), "not executable").toBe(undefined);
});

test("a mirrored call records what the agent did: output, edits, refusals and failures", () => {
  expect(
    toolArguments(view({ title: "Running client_view_file", paths: ["/w/a.txt"] })),
  ).toStrictEqual({
    kind: "edit",
    title: "Running client_view_file /w/a.txt",
  });
  expect(toolArguments(view({ title: "File a.txt", paths: ["/w/a.txt"] })).title).toBe(
    "File a.txt",
  );
  expect(toolArguments(view({ title: "", kind: "think" })).title).toBe("think");

  const edited = toolResult(
    view({ content: [{ type: "diff", path: "/w/a.txt", oldText: null, newText: "x\n" }] }),
    "done",
  );
  expect([edited.isError, edited.content[0]?.text, edited.details.diffs]).toStrictEqual([
    false,
    "Edited /w/a.txt",
    [{ path: "/w/a.txt", oldText: "", newText: "x\n" }],
  ]);
  const raw = (rawOutput: unknown) =>
    toolResult(view({ kind: "execute", rawOutput }), "done").content[0]?.text;
  expect(raw({ combinedOutput: "hi\r\nthere\r\n", exitCode: 0 })).toBe("hi\nthere\n");
  expect(raw({ output: "plain", exit_code: 0 })).toBe("plain");
  expect(raw("text")).toBe("text");
  expect(raw({}), "an output-less result is not dumped as JSON").toBe("File a.txt: completed");
  const long = toolResult(view({ rawOutput: "x".repeat(30_000) }), "done");
  expect(long.content[0]?.text.length ?? 0).toBeLessThan(21_000);
  expect(long.content[0]?.text ?? "").toMatch(/\[output truncated\]$/);
  const silent = toolResult(view({}), "done");
  expect([silent.isError, silent.content[0]?.text]).toStrictEqual([false, "File a.txt: completed"]);
  const failed = toolResult(view({ status: "failed" }), "done");
  expect([failed.isError, failed.content[0]?.text]).toStrictEqual([true, "File a.txt: failed"]);
  const waiting = toolResult(view({ status: "pending", settled: false }), "running");
  expect([waiting.isError, waiting.content[0]?.text]).toStrictEqual([false, "File a.txt: pending"]);
});

test("permission choices with the same name stay distinguishable", () => {
  expect(
    choiceLabels([option("Allow", "allow_once", "a"), option("Deny", "reject_once", "d")]),
  ).toStrictEqual(["Allow", "Deny"]);
  const twins = choiceLabels([
    option("Yes", "allow_once", "a"),
    option("Yes", "reject_once", "b"),
    option("Yes", "reject_once", "c"),
  ]);
  expect(new Set(twins).size).toBe(3);
  expect(twins).toStrictEqual(["Yes [allow once]", "Yes [reject once]", "Yes [reject once] #3"]);
  expect(choiceLabels([])).toStrictEqual([]);
  expect(
    choiceLabels([
      option("A", "allow_once", "1"),
      option("No", "reject_once", "2"),
      option("A", "allow_once", "3"),
      option("No", "reject_once", "4"),
    ]),
  ).toStrictEqual([
    "A [allow once]",
    "No [reject once]",
    "A [allow once] #3",
    "No [reject once] #4",
  ]);
});

test("stopping a turn: one cancel for concurrent callers, no throw when the agent is gone, open dialogs withdrawn", async () => {
  const hooks = { askPermission: () => Promise.resolve(undefined), changed: () => {} };
  const initial = { options: [], tier: undefined, variants: [], cwd: "/work" };
  const prompt = resolvable<{ stopReason: "cancelled" }>();
  let cancels = 0;
  const responsive: AgentPort = {
    prompt: () => prompt.promise,
    cancel() {
      cancels += 1;
      prompt.resolve({ stopReason: "cancelled" });
      return Promise.resolve();
    },
    setConfigOption: () => Promise.resolve([]),
  };
  const session = new AcpSession("s", initial, responsive, hooks);
  session.startTurn([]);
  expect(await Promise.all([haltTurn(session, 1000), haltTurn(session, 1000)])).toStrictEqual([
    true,
    true,
  ]);
  expect(cancels).toBe(1);
  expect(session.turn).toBe(undefined);
  expect(await haltTurn(session, 1000), "nothing to stop").toBe(true);

  const gone: AgentPort = {
    prompt: () => new Promise(() => {}),
    cancel: () => Promise.reject(new Error("connection closed")),
    setConfigOption: () => Promise.resolve([]),
  };
  const dead = new AcpSession("d", initial, gone, hooks);
  dead.startTurn([]);
  expect(await haltTurn(dead, 20)).toBe(false);

  const reply = resolvable<{ stopReason: "end_turn" }>();
  const answer = resolvable<undefined>();
  let withdrawn = false;
  const asking = new AcpSession(
    "a",
    initial,
    { ...gone, prompt: () => reply.promise },
    {
      ...hooks,
      askPermission(_tool, _options, signal) {
        signal.addEventListener("abort", () => {
          withdrawn = true;
        });
        return answer.promise;
      },
    },
  );
  const turn = asking.startTurn([]);
  const allowOnce = { kind: "allow_once" as const, optionId: "allow", name: "Allow" };
  const decision = asking.permission({
    sessionId: "a",
    toolCall: { toolCallId: "t" },
    options: [allowOnce],
  });
  reply.resolve({ stopReason: "end_turn" });
  expect((await turn.next()).type).toBe("tool");
  expect((await turn.next()).type).toBe("end");
  expect(withdrawn, "the dialog is dismissed when its turn ends").toBe(true);
  answer.resolve(undefined);
  expect(await decision).toStrictEqual({ outcome: { outcome: "cancelled" } });
});

test("mirrored calls render as a tool row with progress, diff and output", () => {
  expect(callLine({ kind: "execute", title: "ls -la" }, plain)).toBe("$ ls -la");
  expect(callLine({ kind: "read", title: "File a.txt" }, plain)).toBe("read File a.txt");
  expect(changedLines("a\nb\nc\n", "a\nB\nB2\nc\n")).toStrictEqual({
    removed: ["b"],
    added: ["B", "B2"],
  });
  expect(changedLines("", "x\n")).toStrictEqual({ removed: [], added: ["x"] });
  expect(changedLines("same\n", "same\n")).toStrictEqual({ removed: [], added: [] });

  const closed = { expanded: false, isPartial: false };
  expect(
    resultLines(details({ status: "pending" }), { ...closed, isPartial: true }, plain),
  ).toStrictEqual(["waiting for approval…"]);
  expect(
    resultLines(details({ status: "in_progress" }), { ...closed, isPartial: true }, plain),
  ).toStrictEqual(["running…"]);
  expect(resultLines(details({ declined: true }), closed, plain)).toStrictEqual(["declined"]);
  expect(resultLines(details({}), closed, plain)).toStrictEqual(["done"]);
  expect(resultLines(details({ status: "failed" }), closed, plain)).toStrictEqual(["failed"]);
  expect(resultLines(details({ status: "in_progress" }), closed, plain)).toStrictEqual(["stopped"]);
  const diff = details({ diffs: [{ path: "a.txt", oldText: "a\nb\n", newText: "a\nc\n" }] });
  expect(resultLines(diff, closed, plain)).toStrictEqual(["a.txt +1 -1"]);
  expect(resultLines(diff, { ...closed, expanded: true }, plain)).toStrictEqual([
    "a.txt +1 -1",
    "- b",
    "+ c",
  ]);
  const output = details({ output: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") });
  const collapsed = resultLines(output, closed, plain);
  expect(collapsed.length).toBe(9);
  expect(collapsed.at(-1)).toBe("… 4 more lines");
  expect(resultLines(output, { ...closed, expanded: true }, plain).length).toBe(12);
});

test("the transcript is compared with the agent session by its last stamped reply", () => {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const reply = (responseId: string | undefined, provider = "antigravity") => ({
    role: "assistant" as const,
    api: "x",
    provider,
    model: "m",
    content: [{ type: "toolCall" as const, id: "call-1", name: "antigravity_tool", arguments: {} }],
    usage,
    stopReason: "toolUse" as const,
    timestamp: 2,
    ...(responseId === undefined ? {} : { responseId }),
  });
  const system = { role: "system" as const, content: "rules", timestamp: 0 };

  expect(planTurn([system, user("hi")], undefined)).toStrictEqual({
    diverged: false,
    missed: [],
    prompt: [user("hi")],
  });
  const continued = planTurn([system, user("hi"), reply("s/1.1"), result("call-1")], "s/1.1");
  expect(continued).toStrictEqual({ diverged: false, missed: [], prompt: [] });
  const steered = planTurn(
    [user("hi"), reply("s/1.1"), result("call-1"), user("a"), user("b")],
    "s/1.1",
  );
  expect(steered.prompt).toStrictEqual([user("a"), user("b")]);
  expect(steered.missed).toStrictEqual([]);
  const foreign = planTurn(
    [
      user("hi"),
      reply("s/1.1"),
      result("call-1"),
      user("q"),
      reply(undefined, "other"),
      user("now"),
    ],
    "s/1.1",
  );
  expect([foreign.diverged, foreign.missed.length, foreign.prompt]).toStrictEqual([
    false,
    2,
    [user("now")],
  ]);
  const rewound = planTurn(
    [system, user("hi"), reply("s/1.1"), result("call-1"), user("x")],
    "s/2.1",
  );
  expect([rewound.diverged, rewound.missed.length]).toStrictEqual([true, 3]);
  expect(planTurn([user("hi")], "s/1.1").diverged).toBe(true);

  expect(renderHistory([])).toBe("");
  expect(renderHistory([{ ...reply("s"), content: [] }])).toBe("");
  const history = renderHistory([
    user("question"),
    {
      ...reply("s"),
      content: [
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "secret" },
      ],
    },
    reply("s"),
    result("call-1"),
    {
      role: "user",
      content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
      timestamp: 4,
    },
  ]);
  expect(history).toMatch(
    /^Conversation so far, supplied by the client as context:\n\nUser: question\n\nAssistant: answer\n\nAssistant: \[tool antigravity_tool: \{\}\]\n\nTool result \(antigravity_tool\): out\n\nUser: \[image\]$/,
  );
  expect(history).not.toMatch(/secret/);
  const long = renderHistory([user("a".repeat(30_000)), user("END")]);
  expect(long.length).toBeLessThan(24_200);
  expect(long).toMatch(/\[earlier conversation omitted\][\s\S]*END$/);
});
