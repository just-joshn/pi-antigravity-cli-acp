import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

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

async function scratch(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-acp-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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

await test("the catalog learns every model's thinking levels from one session", async (t) => {
  const listed = await connect({ script: () => [] });
  t.after(listed.close);
  const first = learn(emptyCatalog, await listed.client.newSession("/work"));
  assert.deepEqual(first.models, [
    { id: "gemini-a", name: "Gemini A", efforts: ["low", "medium", "high"] },
    { id: "gemini-b", name: "Gemini B", efforts: ["low", "high", "xhigh"] },
  ]);
  assert.deepEqual(
    first.modes.map((mode) => mode.value),
    ["default", "auto"],
  );
  assert.equal(first.contextWindow, 1_000_000);

  const unlisted = await connect({ script: () => [], variants: false });
  t.after(unlisted.close);
  const session = await unlisted.client.newSession("/work");
  const guessed = learn(emptyCatalog, session);
  assert.deepEqual(guessed.models[1]?.efforts, ["low", "medium", "high"], "assumed until selected");
  await session.select("model", "gemini-b");
  assert.deepEqual(learn(guessed, session).models, [
    { id: "gemini-a", name: "Gemini A", efforts: ["low", "medium", "high"] },
    { id: "gemini-b", name: "Gemini B", efforts: ["low", "high", "xhigh"] },
  ]);
});

await test("Pi models mark thinking levels the agent lacks as unsupported", () => {
  const models = piModels({
    models: [
      { id: "g", name: "G", efforts: ["low", "high"] },
      { id: "fixed", name: "Fixed", efforts: [] },
    ],
    modes: [],
    contextWindow: 2000,
  });
  assert.deepEqual(
    models.map((model) => [model.id, model.reasoning, model.contextWindow]),
    [
      ["default", false, 2000],
      ["g", true, 2000],
      ["fixed", false, 2000],
    ],
  );
  const [, adjustable, fixed] = models;
  assert.ok(adjustable && fixed);
  assert.deepEqual(adjustable.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  });
  assert.equal(effortFor(adjustable, "high"), "high");
  assert.equal(effortFor(adjustable, "medium"), undefined);
  assert.equal(effortFor(adjustable, undefined), undefined);
  assert.equal(effortFor(fixed, "high"), undefined);
});

await test("a saved catalog round-trips; a missing or malformed one is ignored", async (t) => {
  const dir = await scratch(t);
  const file = join(dir, "nested", "catalog.json");
  assert.deepEqual(readCatalog(file), emptyCatalog);
  const catalog = {
    models: [{ id: "g", name: "G", efforts: ["low"] }],
    modes: [{ value: "default", name: "Default", description: "Ask first" }],
    contextWindow: 123,
  };
  writeCatalog(file, catalog);
  assert.deepEqual(readCatalog(file), catalog);
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
    assert.deepEqual(readCatalog(file), emptyCatalog, text);
  }
  await writeFile(file, '{"models":[],"modes":[{"value":"m","name":"M"}],"contextWindow":-5}');
  assert.deepEqual(readCatalog(file), {
    models: [],
    modes: [{ value: "m", name: "M", description: undefined }],
    contextWindow: emptyCatalog.contextWindow,
  });
});

await test("agent choice: the CLI by default, an editor's newest registry copy on request or as fallback", async (t) => {
  const home = await scratch(t);
  const bin = join(home, "bin");
  const root = registryRoot({ HOME: home }, "darwin");
  assert.equal(
    root,
    join(home, "Library", "Application Support", "Zed", "external_agents", "registry"),
  );
  assert.match(registryRoot({ HOME: "/h" }, "linux"), /^\/h\/\.local\/share\/zed\//);
  assert.match(registryRoot({ HOME: "/h", XDG_DATA_HOME: "/x" }, "linux"), /^\/x\/zed\//);
  assert.match(registryRoot({ LOCALAPPDATA: "/l" }, "win32"), /^\/l\/Zed\//);

  const env = { HOME: home, PATH: bin };
  assert.throws(() => resolveAgent("auto", env, "darwin", "arm64"), AcpError);
  assert.throws(() => resolveAgent("registry", env, "darwin", "arm64"), /Zed/);
  assert.throws(() => resolveAgent("cli", env, "darwin", "arm64"), /agy.*PATH/);

  const older = join(root, "antigravity-acp", "v_1.5.2_aaaa", "agy_acp_server.par");
  const newer = join(root, "antigravity-acp", "v_1.10.0_bbbb", "agy_acp_server.par");
  await Promise.all([program(older), program(newer)]);
  await mkdir(join(root, "antigravity-acp", "not-a-version"));
  assert.deepEqual(resolveAgent("auto", env, "darwin", "arm64"), {
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
  assert.deepEqual(findRegistryAgent(root, "linux-x86_64"), {
    kind: "registry",
    command: newer,
    args: ["--uid="],
  });
  assert.deepEqual(findRegistryAgent(root, "darwin-aarch64")?.args, []);

  await program(join(bin, "agy"));
  assert.deepEqual(resolveAgent("auto", env, "darwin", "arm64"), {
    kind: "cli",
    command: "agy",
    args: ["acp"],
  });
  assert.equal(resolveAgent("registry", env, "darwin", "arm64").kind, "registry");
  await chmod(newer, 0o644);
  assert.equal(findRegistryAgent(root, "darwin-aarch64"), undefined, "not executable");
});

await test("a mirrored call records what the agent did: output, edits, refusals and failures", () => {
  assert.deepEqual(
    toolArguments(view({ title: "Running client_view_file", paths: ["/w/a.txt"] })),
    {
      kind: "edit",
      title: "Running client_view_file /w/a.txt",
    },
  );
  assert.equal(
    toolArguments(view({ title: "File a.txt", paths: ["/w/a.txt"] })).title,
    "File a.txt",
  );
  assert.equal(toolArguments(view({ title: "", kind: "think" })).title, "think");

  const edited = toolResult(
    view({ content: [{ type: "diff", path: "/w/a.txt", oldText: null, newText: "x\n" }] }),
    "done",
  );
  assert.deepEqual(
    [edited.isError, edited.content[0]?.text, edited.details.diffs],
    [false, "Edited /w/a.txt", [{ path: "/w/a.txt", oldText: "", newText: "x\n" }]],
  );
  const raw = (rawOutput: unknown) =>
    toolResult(view({ kind: "execute", rawOutput }), "done").content[0]?.text;
  assert.equal(raw({ combinedOutput: "hi\r\nthere\r\n", exitCode: 0 }), "hi\nthere\n");
  assert.equal(raw({ output: "plain", exit_code: 0 }), "plain");
  assert.equal(raw("text"), "text");
  assert.equal(raw({}), "File a.txt: completed", "an output-less result is not dumped as JSON");
  const long = toolResult(view({ rawOutput: "x".repeat(30_000) }), "done");
  assert.ok((long.content[0]?.text.length ?? 0) < 21_000);
  assert.match(long.content[0]?.text ?? "", /\[output truncated\]$/);
  const silent = toolResult(view({}), "done");
  assert.deepEqual([silent.isError, silent.content[0]?.text], [false, "File a.txt: completed"]);
  const failed = toolResult(view({ status: "failed" }), "done");
  assert.deepEqual([failed.isError, failed.content[0]?.text], [true, "File a.txt: failed"]);
  const waiting = toolResult(view({ status: "pending", settled: false }), "running");
  assert.deepEqual([waiting.isError, waiting.content[0]?.text], [false, "File a.txt: pending"]);
});

await test("permission choices with the same name stay distinguishable", () => {
  assert.deepEqual(
    choiceLabels([option("Allow", "allow_once", "a"), option("Deny", "reject_once", "d")]),
    ["Allow", "Deny"],
  );
  const twins = choiceLabels([
    option("Yes", "allow_once", "a"),
    option("Yes", "reject_once", "b"),
    option("Yes", "reject_once", "c"),
  ]);
  assert.equal(new Set(twins).size, 3);
  assert.deepEqual(twins, ["Yes [allow once]", "Yes [reject once]", "Yes [reject once] #3"]);
});

await test("stopping a turn: one cancel for concurrent callers, no throw when the agent is gone, open dialogs withdrawn", async () => {
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
  assert.deepEqual(await Promise.all([haltTurn(session, 1000), haltTurn(session, 1000)]), [
    true,
    true,
  ]);
  assert.equal(cancels, 1);
  assert.equal(session.turn, undefined);
  assert.equal(await haltTurn(session, 1000), true, "nothing to stop");

  const gone: AgentPort = {
    prompt: () => new Promise(() => {}),
    cancel: () => Promise.reject(new Error("connection closed")),
    setConfigOption: () => Promise.resolve([]),
  };
  const dead = new AcpSession("d", initial, gone, hooks);
  dead.startTurn([]);
  assert.equal(await haltTurn(dead, 20), false);

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
  assert.equal((await turn.next()).type, "tool");
  assert.equal((await turn.next()).type, "end");
  assert.ok(withdrawn, "the dialog is dismissed when its turn ends");
  answer.resolve(undefined);
  assert.deepEqual(await decision, { outcome: { outcome: "cancelled" } });
});

await test("mirrored calls render as a tool row with progress, diff and output", () => {
  assert.equal(callLine({ kind: "execute", title: "ls -la" }, plain), "$ ls -la");
  assert.equal(callLine({ kind: "read", title: "File a.txt" }, plain), "read File a.txt");
  assert.deepEqual(changedLines("a\nb\nc\n", "a\nB\nB2\nc\n"), {
    removed: ["b"],
    added: ["B", "B2"],
  });
  assert.deepEqual(changedLines("", "x\n"), { removed: [], added: ["x"] });
  assert.deepEqual(changedLines("same\n", "same\n"), { removed: [], added: [] });

  const closed = { expanded: false, isPartial: false };
  assert.deepEqual(
    resultLines(details({ status: "pending" }), { ...closed, isPartial: true }, plain),
    ["waiting for approval…"],
  );
  assert.deepEqual(
    resultLines(details({ status: "in_progress" }), { ...closed, isPartial: true }, plain),
    ["running…"],
  );
  assert.deepEqual(resultLines(details({ declined: true }), closed, plain), ["declined"]);
  assert.deepEqual(resultLines(details({}), closed, plain), ["done"]);
  assert.deepEqual(resultLines(details({ status: "failed" }), closed, plain), ["failed"]);
  assert.deepEqual(resultLines(details({ status: "in_progress" }), closed, plain), ["stopped"]);
  const diff = details({ diffs: [{ path: "a.txt", oldText: "a\nb\n", newText: "a\nc\n" }] });
  assert.deepEqual(resultLines(diff, closed, plain), ["a.txt +1 -1"]);
  assert.deepEqual(resultLines(diff, { ...closed, expanded: true }, plain), [
    "a.txt +1 -1",
    "- b",
    "+ c",
  ]);
  const output = details({ output: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") });
  const collapsed = resultLines(output, closed, plain);
  assert.equal(collapsed.length, 9);
  assert.equal(collapsed.at(-1), "… 4 more lines");
  assert.equal(resultLines(output, { ...closed, expanded: true }, plain).length, 12);
});

await test("the transcript is compared with the agent session by its last stamped reply", () => {
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

  assert.deepEqual(planTurn([system, user("hi")], undefined), {
    diverged: false,
    missed: [],
    prompt: [user("hi")],
  });
  const continued = planTurn([system, user("hi"), reply("s/1.1"), result("call-1")], "s/1.1");
  assert.deepEqual(continued, { diverged: false, missed: [], prompt: [] });
  const steered = planTurn(
    [user("hi"), reply("s/1.1"), result("call-1"), user("a"), user("b")],
    "s/1.1",
  );
  assert.deepEqual(steered.prompt, [user("a"), user("b")]);
  assert.deepEqual(steered.missed, []);
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
  assert.deepEqual(
    [foreign.diverged, foreign.missed.length, foreign.prompt],
    [false, 2, [user("now")]],
  );
  const rewound = planTurn(
    [system, user("hi"), reply("s/1.1"), result("call-1"), user("x")],
    "s/2.1",
  );
  assert.deepEqual([rewound.diverged, rewound.missed.length], [true, 3]);
  assert.equal(planTurn([user("hi")], "s/1.1").diverged, true);

  assert.equal(renderHistory([]), "");
  assert.equal(renderHistory([{ ...reply("s"), content: [] }]), "");
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
  assert.match(
    history,
    /^Conversation so far, supplied by the client as context:\n\nUser: question\n\nAssistant: answer\n\nAssistant: \[tool antigravity_tool: \{\}\]\n\nTool result \(antigravity_tool\): out\n\nUser: \[image\]$/,
  );
  assert.doesNotMatch(history, /secret/);
  const long = renderHistory([user("a".repeat(30_000)), user("END")]);
  assert.ok(long.length < 24_200);
  assert.match(long, /\[earlier conversation omitted\][\s\S]*END$/);
});
