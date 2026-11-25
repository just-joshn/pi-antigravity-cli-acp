import type { PermissionOption } from "@agentclientprotocol/sdk/unstable";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type Model,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { expect, onTestFinished, test } from "vitest";

import { type Catalog, piModels, PROVIDER } from "../src/catalog.ts";
import { Conversation } from "../src/conversation.ts";
import { createStream } from "../src/stream.ts";
import { runMirror, TOOL_NAME } from "../src/tool.ts";
import { allow, defaultModels, type FakeAgentOptions, type Step } from "./support/fake-agent.ts";
import { connect, deferred } from "./support/harness.ts";

const catalog: Catalog = { models: defaultModels, modes: [], contextWindow: 1_000_000 };
function pick(id: string) {
  const found = piModels(catalog).find((entry) => entry.id === id);
  expect.assert(found, `no model ${id}`);
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

type Client = Awaited<ReturnType<typeof connect>>["client"];

/** What the extension does for the stream: one agent session at a time, recorded for the test. */
function scriptedHost(client: Client, options: ChatOptions) {
  const state = { conversation: undefined as Conversation | undefined };
  const notes: string[] = [];
  const abandoned = { count: 0 };
  const start = async () => new Conversation(await client.newSession("/work"), client.accepts);
  const stream = createStream({
    conversing: () => options.conversing ?? true,
    open: async () => (state.conversation ??= await start()),
    restart: async () => (state.conversation = await start()),
    abandon() {
      abandoned.count += 1;
      state.conversation = undefined;
    },
    noteTool: (tool) => notes.push(`${tool.kind}:${tool.title}`),
    ...(options.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs }),
  });
  const watch = (id: string, signal?: AbortSignal) =>
    runMirror(
      (stop, onChange) =>
        state.conversation
          ? state.conversation.watch(id, stop, onChange)
          : Promise.resolve(undefined),
      signal,
      undefined,
    );
  return { stream, watch, notes, abandoned };
}

/** Runs a message's mirrored tool calls and appends their results, as Pi does. */
async function runTools(
  host: ReturnType<typeof scriptedHost>,
  messages: Message[],
  message: AssistantMessage,
) {
  const calls = message.content.filter((block) => block.type === "toolCall");
  const results = await Promise.all(calls.map((call) => host.watch(call.id)));
  for (const [index, call] of calls.entries()) {
    const result = results[index];
    expect.assert(result);
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

/** Drives the provider the way Pi's agent loop does: stream, run the mirrored tools, stream again. */
function piLoop(host: ReturnType<typeof scriptedHost>, mirrorTool: boolean) {
  const messages: Message[] = [];
  const tools = mirrorTool ? [{ name: TOOL_NAME, description: "", parameters: {} }] : [];

  async function step(model: Model<string> = modelA, request: { signal?: AbortSignal } = {}) {
    const context = normalizeContext({
      systemPrompt: "PI-SYSTEM-PROMPT",
      tools,
      messages: [...messages],
    });
    const events: AssistantMessageEvent[] = [];
    const running = host.stream(model, context, request);
    for await (const event of running) events.push(event);
    const message = await running.result();
    messages.push(message);
    return { events, message };
  }

  const mirror = (message: AssistantMessage) => runTools(host, messages, message);

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

  return { messages, step, mirror, turn };
}

/** A scripted agent behind the provider, driven by Pi's loop. */
async function chat(agent: FakeAgentOptions, options: ChatOptions = {}) {
  const answers = [...(options.answers ?? [])];
  const { client, log, close } = await connect(agent, {
    askPermission(_tool, offered) {
      const answer = answers.shift();
      return Promise.resolve(offered.find((option) => option.optionId === answer?.optionId));
    },
  });
  onTestFinished(close);
  const host = scriptedHost(client, options);
  const { notes, abandoned, watch } = host;
  return { log, notes, abandoned, watch, ...piLoop(host, options.mirror !== false) };
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

test("a prompt reaches the agent as the user's words only and the reply streams back natively", async () => {
  const steps: Step[] = [
    { think: "consider" },
    { usage: [4321, 1_000_000] },
    { say: "Hel" },
    { say: "lo." },
  ];
  const c = await chat({ script: () => steps });
  c.messages.push({ role: "user", content: "hi there", timestamp: 1 });
  const { events, message } = await c.step();
  expect(c.log.prompts).toStrictEqual([[{ type: "text", text: "hi there" }]]);
  expect(events.map((e) => e.type)).toStrictEqual([
    "start",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "text_start",
    "text_delta",
    "text_delta",
    "text_end",
    "done",
  ]);
  expect(message.content).toStrictEqual([
    { type: "thinking", thinking: "consider" },
    { type: "text", text: "Hello." },
  ]);
  expect(message.stopReason).toBe("stop");
  expect(message.provider).toBe(PROVIDER);
  expect(message.model).toBe("gemini-a");
  expect({
    context: message.usage.totalTokens,
    input: message.usage.input,
    output: message.usage.output,
    cacheRead: message.usage.cacheRead,
    reasoning: message.usage.reasoning,
    cost: message.usage.cost.total,
  }).toStrictEqual({ context: 4321, input: 60, output: 30, cacheRead: 10, reasoning: 10, cost: 0 });
  expect(message.responseId ?? "").toMatch(/^s1\/1\.1$/);
});

test("follow-ups continue the same agent conversation with only the new message", async () => {
  const c = await chat({ script: (_prompt, n) => [{ say: `answer ${n + 1}` }] });
  expect(textOf((await c.turn("first")).at(-1))).toBe("answer 1");
  expect(textOf((await c.turn("second")).at(-1))).toBe("answer 2");
  expect(c.log.sessions.length).toBe(1);
  expect(c.log.prompts[1]).toStrictEqual([{ type: "text", text: "second" }]);
  expect(promptText(c.log.prompts)).not.toMatch(/PI-SYSTEM-PROMPT/);
});

test("agent tool calls become mirrored Pi tool calls and the same turn resumes after them", async () => {
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
  const c = await chat({ script: () => steps });
  const [first, last] = await c.turn("look around");
  expect(first?.stopReason).toBe("toolUse");
  const calls = (first?.content ?? []).filter((block) => block.type === "toolCall");
  expect(calls.map((call) => [call.name, call.arguments])).toStrictEqual([
    [TOOL_NAME, { kind: "read", title: "File a.txt" }],
    [TOOL_NAME, { kind: "execute", title: "ls" }],
  ]);
  expect(new Set(calls.map((call) => call.id)).size).toBe(2);
  const results = c.messages.filter((m) => m.role === "toolResult");
  expect(results.map((m) => [m.isError, m.content])).toStrictEqual([
    [false, [{ type: "text", text: "alpha" }]],
    [false, [{ type: "text", text: "a.txt\n" }]],
  ]);
  expect(textOf(last)).toBe("Both done.");
  expect(last?.stopReason).toBe("stop");
  expect(c.log.prompts.length).toBe(1);
  expect(first?.responseId).not.toBe(last?.responseId);
});

test("a declined permission is reported on the tool and the turn ends without invented text", async () => {
  const steps: Step[] = [
    { tool: { toolCallId: "t1", kind: "execute", title: "rm -rf build", status: "pending" } },
    {
      ask: "t1",
      allowed: [{ update: { toolCallId: "t1", status: "completed" } }],
      declined: [{ update: { toolCallId: "t1", status: "failed" } }],
    },
  ];
  const denied = await chat({ script: () => steps });
  const [call, end] = await denied.turn("clean up");
  expect(call?.stopReason).toBe("toolUse");
  const result = denied.messages.find((m) => m.role === "toolResult");
  expect(result?.isError).toBe(true);
  expect(JSON.stringify(result?.content)).toMatch(/Permission declined: rm -rf build/);
  expect([end?.stopReason, end?.content]).toStrictEqual(["stop", []]);
  expect(denied.log.outcomes).toStrictEqual([{ outcome: "selected", optionId: "deny" }]);

  const granted = await chat({ script: () => steps }, { answers: [allow] });
  await granted.turn("clean up");
  expect(granted.messages.find((m) => m.role === "toolResult")?.isError).toBe(false);
  expect(granted.log.outcomes).toStrictEqual([{ outcome: "selected", optionId: "allow" }]);
});

test("Pi's model and thinking level are applied to the agent before the prompt", async () => {
  const c = await chat({ script: () => [{ say: "ok" }] });
  const [reply] = await c.turn("one", modelB, { reasoning: "xhigh" });
  expect(c.log.config).toStrictEqual([
    ["model", "gemini-b"],
    ["thought_level", "xhigh"],
  ]);
  expect([reply?.model, reply?.providerThinkingLevel]).toStrictEqual(["gemini-b", "xhigh"]);
  await c.turn("two", modelB, { reasoning: "xhigh" });
  await c.turn("three", agentDefault, { reasoning: "low" });
  expect(c.log.config.length, "unchanged settings and the agent-default model send nothing").toBe(
    2,
  );
  const gone = { ...modelA, id: "gemini-retired" };
  const [failed] = await c.turn("four", gone);
  expect(failed?.stopReason).toBe("error");
  expect(failed?.errorMessage ?? "").toMatch(/gemini-retired/);
  expect(c.log.prompts.length).toBe(3);
});

test("a message typed during a turn stops that turn and is sent next", async () => {
  const c = await chat({
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
  expect(first.message.stopReason).toBe("toolUse");
  await c.mirror(first.message);
  c.messages.push({ role: "user", content: "do this instead", timestamp: 2 });
  const second = await c.step();
  expect(c.log.cancels).toBe(1);
  expect(c.log.prompts[1]).toStrictEqual([{ type: "text", text: "do this instead" }]);
  expect(textOf(second.message)).toBe("switched");
  expect(c.log.sessions.length).toBe(1);
});

test("aborting from Pi cancels the agent's turn and the conversation stays usable", async () => {
  const c = await chat({
    script: (_prompt, n) =>
      n === 0 ? [{ say: "working" }, { hold: "cancel" }] : [{ say: "fresh" }],
  });
  const abort = new AbortController();
  c.messages.push({ role: "user", content: "start", timestamp: 1 });
  const running = c.step(modelA, { signal: abort.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  abort.abort();
  const { message, events } = await running;
  expect(message.stopReason).toBe("aborted");
  expect(events.at(-1)?.type).toBe("error");
  expect(textOf(message)).toBe("working");
  expect(c.log.cancels).toBe(1);
  expect(textOf((await c.turn("again")).at(-1))).toBe("fresh");
  expect(c.log.sessions.length).toBe(1);
});

test("history the agent has not seen is supplied as context; a rewound transcript starts a new agent session", async () => {
  const c = await chat({ script: (_prompt, n) => [{ say: `reply ${n + 1}` }] });
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
  expect.assert(context?.type === "resource" && "text" in context.resource);
  expect(context.resource.text).toMatch(/User: earlier question[\s\S]*Assistant: earlier answer/);
  expect(context.resource.text).not.toMatch(/now you|PI-SYSTEM-PROMPT/);
  expect(prompt).toStrictEqual({ type: "text", text: "now you" });

  await c.turn("second");
  expect(c.log.prompts[1]).toStrictEqual([{ type: "text", text: "second" }]);
  c.messages.splice(-2);
  await c.turn("alternate second");
  expect(c.log.sessions.length, "the agent session held a turn this branch no longer has").toBe(2);
  const replay = c.log.prompts[2]?.[0];
  expect.assert(replay?.type === "resource" && "text" in replay.resource);
  expect(replay.resource.text).toMatch(/now you[\s\S]*reply 1/);
  expect(replay.resource.text).not.toMatch(/reply 2|alternate/);
});

test("an agent that ignores cancellation is abandoned, not prompted again while it works", async () => {
  const never = deferred();
  onTestFinished(never.resolve);
  const c = await chat(
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
  expect([message.stopReason, events.at(-1)?.type]).toStrictEqual(["aborted", "error"]);
  expect([c.log.cancels, c.abandoned.count]).toStrictEqual([1, 1]);
  expect(textOf((await c.turn("again")).at(-1))).toBe("new");
  expect(c.log.sessions.length, "the unresponsive session is not reused").toBe(2);
  const context = c.log.prompts[1]?.[0];
  expect.assert(context?.type === "resource" && "text" in context.resource);
  expect(context.resource.text).toMatch(/User: start[\s\S]*Assistant: busy/);
});

test("a request with nothing new to send ends quietly without touching the agent session", async () => {
  const c = await chat({ script: () => [{ say: "one" }] });
  await c.turn("first");
  const { message } = await c.step();
  expect([message.stopReason, message.content]).toStrictEqual(["stop", []]);
  expect(c.log.sessions.length).toBe(1);
  expect(c.log.prompts.length).toBe(1);
});

test("requests outside the conversation are refused without contacting the agent", async () => {
  const c = await chat({ script: () => [{ say: "never" }] }, { conversing: false });
  const [reply] = await c.turn("Summarize the conversation above.");
  expect(reply?.stopReason).toBe("error");
  expect(reply?.errorMessage ?? "").toMatch(/keeps its own context/);
  expect(c.log.sessions.length).toBe(0);
});

test("without the mirror tool, tool activity is noted and the reply still arrives in one message", async () => {
  const steps: Step[] = [
    { say: "Reading. " },
    { tool: readCall },
    { update: { toolCallId: "t1", status: "completed" } },
    { say: "Done." },
  ];
  const c = await chat({ script: () => steps }, { mirror: false });
  const replies = await c.turn("read it");
  expect(replies.length).toBe(1);
  expect(textOf(replies[0])).toBe("Reading. Done.");
  expect(c.notes).toStrictEqual(["read:File a.txt"]);
});

test("agent failures, refusals, truncation and unsupported images surface as Pi stop reasons", async () => {
  const failing = await chat({
    script: () => [{ say: "partial" }, { fail: "quota exhausted" }],
  });
  const [failed] = await failing.turn("go");
  expect(failed?.stopReason).toBe("error");
  expect(failed?.errorMessage ?? "").toMatch(/quota exhausted/);
  expect(textOf(failed)).toBe("partial");

  const stops = await chat({
    script: (_prompt, n) => [{ say: "x" }, { stop: n === 0 ? "max_tokens" : "refusal" }],
  });
  expect((await stops.turn("one")).at(-1)?.stopReason).toBe("length");
  const refused = (await stops.turn("two")).at(-1);
  expect([refused?.stopReason, /refused/.test(refused?.errorMessage ?? "")]).toStrictEqual([
    "error",
    true,
  ]);

  const blind = await chat({ script: () => [{ say: "never" }], image: false });
  blind.messages.push({
    role: "user",
    content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
    timestamp: 1,
  });
  const { message } = await blind.step();
  expect(message.stopReason).toBe("error");
  expect(message.errorMessage ?? "").toMatch(/image/i);
  expect(blind.log.prompts.length).toBe(0);

  const seeing = await chat({ script: () => [{ say: "a cat" }] });
  seeing.messages.push({
    role: "user",
    content: [
      { type: "text", text: "what is this?" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ],
    timestamp: 1,
  });
  await seeing.step();
  expect(seeing.log.prompts[0]).toStrictEqual([
    { type: "text", text: "what is this?" },
    { type: "image", data: "aGk=", mimeType: "image/png" },
  ]);
});

test("a mirrored call that Pi aborts, or that the agent never made, is reported as such", async () => {
  const gate = deferred();
  const c = await chat({ script: () => [{ tool: readCall }, { hold: gate.promise }] });
  c.messages.push({ role: "user", content: "go", timestamp: 1 });
  const { message } = await c.step();
  const call = message.content.find((block) => block.type === "toolCall");
  expect.assert(call);
  const abort = new AbortController();
  const pending = c.watch(call.id, abort.signal);
  abort.abort();
  const stopped = await pending;
  expect([stopped.isError, stopped.details.status]).toStrictEqual([true, "in_progress"]);
  expect(JSON.stringify(stopped.content)).toMatch(/File a\.txt.*stopped/);
  const unknown = await c.watch("not-a-call");
  expect(unknown.isError).toBe(true);
  expect(JSON.stringify(unknown.content)).toMatch(/No Antigravity tool call matches/);
  gate.resolve();
});

test("an unexpected failure is reported with its reason", async () => {
  const stream = createStream({
    conversing: () => true,
    open: () => Promise.reject(new Error("socket hang up")),
    restart: () => Promise.reject(new Error("unused")),
    abandon: () => {},
    noteTool: () => {},
  });
  const context = normalizeContext({
    systemPrompt: "",
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
  });
  const message = await stream(modelA, context).result();
  expect(message.stopReason).toBe("error");
  expect(message.errorMessage).toBe(
    "The Antigravity agent stopped unexpectedly (socket hang up). Check that `agy` works in a terminal.",
  );
});
