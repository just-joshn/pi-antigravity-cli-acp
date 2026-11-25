import { expect, test } from "vitest";

import { planTurn, renderHistory } from "../src/stream.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const result = (toolCallId: string) => ({
  role: "toolResult" as const,
  toolCallId,
  toolName: "antigravity_tool",
  content: [{ type: "text" as const, text: "out" }],
  isError: false,
  timestamp: 3,
});
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

test("a first message is the whole prompt, and a stamped reply with its results has nothing new", () => {
  expect(planTurn([], undefined)).toStrictEqual({ diverged: false, missed: [], prompt: [] });
  expect(planTurn([system, user("hi")], undefined)).toStrictEqual({
    diverged: false,
    missed: [],
    prompt: [user("hi")],
  });
  const continued = planTurn([system, user("hi"), reply("s/1.1"), result("call-1")], "s/1.1");
  expect(continued).toStrictEqual({ diverged: false, missed: [], prompt: [] });
});

test("messages typed after the stamped reply are sent; another model's turns are supplied as missed", () => {
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
});

test("a transcript whose last stamped reply is not the session's position has diverged", () => {
  const rewound = planTurn(
    [system, user("hi"), reply("s/1.1"), result("call-1"), user("x")],
    "s/2.1",
  );
  expect([rewound.diverged, rewound.missed.length]).toStrictEqual([true, 3]);
  expect(planTurn([user("hi")], "s/1.1").diverged).toBe(true);
});

test("history is rendered as text without thinking, and nothing is rendered for nothing said", () => {
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
});

test("long history keeps its most recent part", () => {
  const long = renderHistory([user("a".repeat(30_000)), user("END")]);
  expect(long.length).toBeLessThan(24_200);
  expect(long).toMatch(/\[earlier conversation omitted\][\s\S]*END$/);
});
