import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { PermissionOption } from "@agentclientprotocol/sdk/unstable";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type Model,
  normalizeContext,
} from "@earendil-works/pi-ai";

import { type Catalog, piModels, PROVIDER } from "../src/acp/catalog.ts";
import {
  type Conversation,
  createStream,
  newConversation,
  watchMirror,
} from "../src/acp/stream.ts";
import { runMirror, TOOL_NAME } from "../src/acp/tool.ts";
import { allow, defaultModels, type FakeAgentOptions, type Step } from "./support/fake-agent.ts";
import { connect, deferred } from "./support/harness.ts";

const catalog: Catalog = { models: defaultModels, modes: [], contextWindow: 1_000_000 };
function pick(id: string) {
  const found = piModels(catalog).find((entry) => entry.id === id);
  assert.ok(found, `no model ${id}`);
  return found;
}
const agentDefault = pick("default");
const modelA = pick("gemini-a");
const modelB = pick("gemini-b");

interface ChatOptions {
  mirror?: boolean;
  conversing?: boolean;
  cancelGraceMs?: number;
  answers?: (PermissionOption | undefined)[];
}

/** Drives the provider the way Pi's agent loop does: stream, run the mirrored tools, stream again. */
async function chat(t: TestContext, agent: FakeAgentOptions, options: ChatOptions = {}) {
  const answers = [...(options.answers ?? [])];
  const { client, log, close } = await connect(agent, {
    askPermission(_tool, offered) {
      const answer = answers.shift();
      return Promise.resolve(offered.find((option) => option.optionId === answer?.optionId));
    },
  });
  t.after(close);
  let conversation: Conversation | undefined;
  const notes: string[] = [];
  const abandoned = { count: 0 };
  const start = async () => newConversation(await client.newSession("/work"), client.accepts);
  const stream = createStream({
    conversing: () => options.conversing ?? true,
    open: async () => (conversation ??= await start()),
    restart: async () => (conversation = await start()),
    abandon() {
      abandoned.count += 1;
      conversation = undefined;
    },
    noteTool: (tool) => notes.push(`${tool.kind}:${tool.title}`),
    ...(options.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs }),
  });
  const messages: Message[] = [];
  const tools =
    options.mirror === false ? [] : [{ name: TOOL_NAME, description: "", parameters: {} }];

  async function step(model: Model<string> = modelA, request: { signal?: AbortSignal } = {}) {
    const context = normalizeContext({
      systemPrompt: "PI-SYSTEM-PROMPT",
      tools,
      messages: [...messages],
    });
    const events: AssistantMessageEvent[] = [];
    const running = stream(model, context, request);
    for await (const event of running) events.push(event);
    const message = await running.result();
    messages.push(message);
    return { events, message };
  }

  const watch = (id: string, signal?: AbortSignal) =>
    runMirror(
      (stop, onChange) =>
        conversation ? watchMirror(conversation, id, stop, onChange) : Promise.resolve(undefined),
      signal,
      undefined,
    );

  async function mirror(message: AssistantMessage) {
    const calls = message.content.filter((block) => block.type === "toolCall");
    const results = await Promise.all(calls.map((call) => watch(call.id)));
    for (const [index, call] of calls.entries()) {
      const result = results[index];
      assert.ok(result);
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError,
        timestamp: Date.now(),
      });
    }
    return results;
  }

  async function turn(text: string, model: Model<string> = modelA, request = {}) {
    messages.push({ role: "user", content: text, timestamp: Date.now() });
    const replies: AssistantMessage[] = [];
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- each provider call depends on the previous one
      const { message } = await step(model, request);
      replies.push(message);
      if (message.stopReason !== "toolUse") return replies;
      // oxlint-disable-next-line no-await-in-loop -- tool results precede the next provider call
      await mirror(message);
    }
  }

  return { log, messages, step, turn, mirror, watch, notes, abandoned };
}

const textOf = (message: AssistantMessage | undefined) =>
  (message?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
const promptText = (blocks: unknown) => JSON.stringify(blocks);
const readCall = {
  toolCallId: "t1",
  kind: "read" as const,
  title: "File a.txt",
  status: "in_progress" as const,
};

await test("a prompt reaches the agent as the user's words only and the reply streams back natively", async (t) => {
  const steps: Step[] = [
    { think: "consider" },
    { usage: [4321, 1_000_000] },
    { say: "Hel" },
    { say: "lo." },
  ];
  const c = await chat(t, { script: () => steps });
  c.messages.push({ role: "user", content: "hi there", timestamp: 1 });
  const { events, message } = await c.step();
  assert.deepEqual(c.log.prompts, [[{ type: "text", text: "hi there" }]]);
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ],
  );
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "consider" },
    { type: "text", text: "Hello." },
  ]);
  assert.equal(message.stopReason, "stop");
  assert.equal(message.provider, PROVIDER);
  assert.equal(message.model, "gemini-a");
  assert.deepEqual(
    {
      context: message.usage.totalTokens,
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      reasoning: message.usage.reasoning,
      cost: message.usage.cost.total,
    },
    { context: 4321, input: 60, output: 30, cacheRead: 10, reasoning: 10, cost: 0 },
  );
  assert.match(message.responseId ?? "", /^s1\/1\.1$/);
});

await test("follow-ups continue the same agent conversation with only the new message", async (t) => {
  const c = await chat(t, { script: (_prompt, n) => [{ say: `answer ${n + 1}` }] });
  assert.equal(textOf((await c.turn("first")).at(-1)), "answer 1");
  assert.equal(textOf((await c.turn("second")).at(-1)), "answer 2");
  assert.equal(c.log.sessions.length, 1);
  assert.deepEqual(c.log.prompts[1], [{ type: "text", text: "second" }]);
  assert.doesNotMatch(promptText(c.log.prompts), /PI-SYSTEM-PROMPT/);
});

await test("agent tool calls become mirrored Pi tool calls and the same turn resumes after them", async (t) => {
  const steps: Step[] = [
    { say: "Reading." },
    { tool: readCall },
    { tool: { toolCallId: "t2", kind: "execute", title: "ls", status: "in_progress" } },
    {
      update: {
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "alpha" } }],
      },
    },
    { update: { toolCallId: "t2", status: "completed", rawOutput: "a.txt\n" } },
    { say: "Both done." },
  ];
  const c = await chat(t, { script: () => steps });
  const [first, last] = await c.turn("look around");
  assert.equal(first?.stopReason, "toolUse");
  const calls = (first?.content ?? []).filter((block) => block.type === "toolCall");
  assert.deepEqual(
    calls.map((call) => [call.name, call.arguments]),
    [
      [TOOL_NAME, { kind: "read", title: "File a.txt" }],
      [TOOL_NAME, { kind: "execute", title: "ls" }],
    ],
  );
  assert.equal(new Set(calls.map((call) => call.id)).size, 2);
  const results = c.messages.filter((m) => m.role === "toolResult");
  assert.deepEqual(
    results.map((m) => [m.isError, m.content]),
    [
      [false, [{ type: "text", text: "alpha" }]],
      [false, [{ type: "text", text: "a.txt\n" }]],
    ],
  );
  assert.equal(textOf(last), "Both done.");
  assert.equal(last?.stopReason, "stop");
  assert.equal(c.log.prompts.length, 1);
  assert.notEqual(first?.responseId, last?.responseId);
});

await test("a declined permission is reported on the tool and the turn ends without invented text", async (t) => {
  const steps: Step[] = [
    { tool: { toolCallId: "t1", kind: "execute", title: "rm -rf build", status: "pending" } },
    {
      ask: "t1",
      allowed: [{ update: { toolCallId: "t1", status: "completed" } }],
      declined: [{ update: { toolCallId: "t1", status: "failed" } }],
    },
  ];
  const denied = await chat(t, { script: () => steps });
  const [call, end] = await denied.turn("clean up");
  assert.equal(call?.stopReason, "toolUse");
  const result = denied.messages.find((m) => m.role === "toolResult");
  assert.equal(result?.isError, true);
  assert.match(JSON.stringify(result?.content), /Permission declined: rm -rf build/);
  assert.deepEqual([end?.stopReason, end?.content], ["stop", []]);
  assert.deepEqual(denied.log.outcomes, [{ outcome: "selected", optionId: "deny" }]);

  const granted = await chat(t, { script: () => steps }, { answers: [allow] });
  await granted.turn("clean up");
  assert.equal(granted.messages.find((m) => m.role === "toolResult")?.isError, false);
  assert.deepEqual(granted.log.outcomes, [{ outcome: "selected", optionId: "allow" }]);
});

await test("Pi's model and thinking level are applied to the agent before the prompt", async (t) => {
  const c = await chat(t, { script: () => [{ say: "ok" }] });
  const [reply] = await c.turn("one", modelB, { reasoning: "xhigh" });
  assert.deepEqual(c.log.config, [
    ["model", "gemini-b"],
    ["thought_level", "xhigh"],
  ]);
  assert.deepEqual([reply?.model, reply?.providerThinkingLevel], ["gemini-b", "xhigh"]);
  await c.turn("two", modelB, { reasoning: "xhigh" });
  await c.turn("three", agentDefault, { reasoning: "low" });
  assert.equal(
    c.log.config.length,
    2,
    "unchanged settings and the agent-default model send nothing",
  );
  const gone = { ...modelA, id: "gemini-retired" };
  const [failed] = await c.turn("four", gone);
  assert.equal(failed?.stopReason, "error");
  assert.match(failed?.errorMessage ?? "", /gemini-retired/);
  assert.equal(c.log.prompts.length, 3);
});

await test("a message typed during a turn stops that turn and is sent next", async (t) => {
  const c = await chat(t, {
    script: (_prompt, n) =>
      n === 0
        ? [
            { tool: readCall },
            { update: { toolCallId: "t1", status: "completed" } },
            { hold: "cancel" },
          ]
        : [{ say: "switched" }],
  });
  c.messages.push({ role: "user", content: "long task", timestamp: 1 });
  const first = await c.step();
  assert.equal(first.message.stopReason, "toolUse");
  await c.mirror(first.message);
  c.messages.push({ role: "user", content: "do this instead", timestamp: 2 });
  const second = await c.step();
  assert.equal(c.log.cancels, 1);
  assert.deepEqual(c.log.prompts[1], [{ type: "text", text: "do this instead" }]);
  assert.equal(textOf(second.message), "switched");
  assert.equal(c.log.sessions.length, 1);
});

await test("aborting from Pi cancels the agent's turn and the conversation stays usable", async (t) => {
  const c = await chat(t, {
    script: (_prompt, n) =>
      n === 0 ? [{ say: "working" }, { hold: "cancel" }] : [{ say: "fresh" }],
  });
  const abort = new AbortController();
  c.messages.push({ role: "user", content: "start", timestamp: 1 });
  const running = c.step(modelA, { signal: abort.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  abort.abort();
  const { message, events } = await running;
  assert.equal(message.stopReason, "aborted");
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(textOf(message), "working");
  assert.equal(c.log.cancels, 1);
  assert.equal(textOf((await c.turn("again")).at(-1)), "fresh");
  assert.equal(c.log.sessions.length, 1);
});

await test("history the agent has not seen is supplied as context; a rewound transcript starts a new agent session", async (t) => {
  const c = await chat(t, { script: (_prompt, n) => [{ say: `reply ${n + 1}` }] });
  c.messages.push(
    { role: "user", content: "earlier question", timestamp: 1 },
    {
      role: "assistant",
      api: "other",
      provider: "other",
      model: "x",
      content: [{ type: "text", text: "earlier answer" }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    },
  );
  await c.turn("now you");
  const [context, prompt] = c.log.prompts[0] ?? [];
  assert.ok(context?.type === "resource" && "text" in context.resource);
  assert.match(context.resource.text, /User: earlier question[\s\S]*Assistant: earlier answer/);
  assert.doesNotMatch(context.resource.text, /now you|PI-SYSTEM-PROMPT/);
  assert.deepEqual(prompt, { type: "text", text: "now you" });

  await c.turn("second");
  assert.deepEqual(c.log.prompts[1], [{ type: "text", text: "second" }]);
  c.messages.splice(-2);
  await c.turn("alternate second");
  assert.equal(c.log.sessions.length, 2, "the agent session held a turn this branch no longer has");
  const replay = c.log.prompts[2]?.[0];
  assert.ok(replay?.type === "resource" && "text" in replay.resource);
  assert.match(replay.resource.text, /now you[\s\S]*reply 1/);
  assert.doesNotMatch(replay.resource.text, /reply 2|alternate/);
});

await test("an agent that ignores cancellation is abandoned, not prompted again while it works", async (t) => {
  const never = deferred();
  t.after(never.resolve);
  const c = await chat(
    t,
    {
      script: (_prompt, n) =>
        n === 0 ? [{ say: "busy" }, { hold: never.promise }] : [{ say: "new" }],
    },
    { cancelGraceMs: 30 },
  );
  const abort = new AbortController();
  c.messages.push({ role: "user", content: "start", timestamp: 1 });
  const running = c.step(modelA, { signal: abort.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  abort.abort();
  const { message, events } = await running;
  assert.deepEqual([message.stopReason, events.at(-1)?.type], ["aborted", "error"]);
  assert.deepEqual([c.log.cancels, c.abandoned.count], [1, 1]);
  assert.equal(textOf((await c.turn("again")).at(-1)), "new");
  assert.equal(c.log.sessions.length, 2, "the unresponsive session is not reused");
  const context = c.log.prompts[1]?.[0];
  assert.ok(context?.type === "resource" && "text" in context.resource);
  assert.match(context.resource.text, /User: start[\s\S]*Assistant: busy/);
});

await test("a request with nothing new to send ends quietly without touching the agent session", async (t) => {
  const c = await chat(t, { script: () => [{ say: "one" }] });
  await c.turn("first");
  const { message } = await c.step();
  assert.deepEqual([message.stopReason, message.content], ["stop", []]);
  assert.equal(c.log.sessions.length, 1);
  assert.equal(c.log.prompts.length, 1);
});

await test("requests outside the conversation are refused without contacting the agent", async (t) => {
  const c = await chat(t, { script: () => [{ say: "never" }] }, { conversing: false });
  const [reply] = await c.turn("Summarize the conversation above.");
  assert.equal(reply?.stopReason, "error");
  assert.match(reply?.errorMessage ?? "", /keeps its own context/);
  assert.equal(c.log.sessions.length, 0);
});

await test("without the mirror tool, tool activity is noted and the reply still arrives in one message", async (t) => {
  const steps: Step[] = [
    { say: "Reading. " },
    { tool: readCall },
    { update: { toolCallId: "t1", status: "completed" } },
    { say: "Done." },
  ];
  const c = await chat(t, { script: () => steps }, { mirror: false });
  const replies = await c.turn("read it");
  assert.equal(replies.length, 1);
  assert.equal(textOf(replies[0]), "Reading. Done.");
  assert.deepEqual(c.notes, ["read:File a.txt"]);
});

await test("agent failures, refusals, truncation and unsupported images surface as Pi stop reasons", async (t) => {
  const failing = await chat(t, {
    script: () => [{ say: "partial" }, { fail: "quota exhausted" }],
  });
  const [failed] = await failing.turn("go");
  assert.equal(failed?.stopReason, "error");
  assert.match(failed?.errorMessage ?? "", /quota exhausted/);
  assert.equal(textOf(failed), "partial");

  const stops = await chat(t, {
    script: (_prompt, n) => [{ say: "x" }, { stop: n === 0 ? "max_tokens" : "refusal" }],
  });
  assert.equal((await stops.turn("one")).at(-1)?.stopReason, "length");
  const refused = (await stops.turn("two")).at(-1);
  assert.deepEqual(
    [refused?.stopReason, /refused/.test(refused?.errorMessage ?? "")],
    ["error", true],
  );

  const blind = await chat(t, { script: () => [{ say: "never" }], image: false });
  blind.messages.push({
    role: "user",
    content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
    timestamp: 1,
  });
  const { message } = await blind.step();
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /image/i);
  assert.equal(blind.log.prompts.length, 0);

  const seeing = await chat(t, { script: () => [{ say: "a cat" }] });
  seeing.messages.push({
    role: "user",
    content: [
      { type: "text", text: "what is this?" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ],
    timestamp: 1,
  });
  await seeing.step();
  assert.deepEqual(seeing.log.prompts[0], [
    { type: "text", text: "what is this?" },
    { type: "image", data: "aGk=", mimeType: "image/png" },
  ]);
});

await test("a mirrored call that Pi aborts, or that the agent never made, is reported as such", async (t) => {
  const gate = deferred();
  const c = await chat(t, { script: () => [{ tool: readCall }, { hold: gate.promise }] });
  c.messages.push({ role: "user", content: "go", timestamp: 1 });
  const { message } = await c.step();
  const call = message.content.find((block) => block.type === "toolCall");
  assert.ok(call);
  const abort = new AbortController();
  const pending = c.watch(call.id, abort.signal);
  abort.abort();
  const stopped = await pending;
  assert.deepEqual([stopped.isError, stopped.details.status], [true, "in_progress"]);
  assert.match(JSON.stringify(stopped.content), /File a\.txt.*stopped/);
  const unknown = await c.watch("not-a-call");
  assert.equal(unknown.isError, true);
  assert.match(JSON.stringify(unknown.content), /No Antigravity tool call matches/);
  gate.resolve();
});
