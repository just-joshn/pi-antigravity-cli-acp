import type { PermissionOption } from "@agentclientprotocol/sdk/unstable";
import { expect, test } from "vitest";

import { noSuchMode } from "../src/antigravity.ts";
import { AcpSession, type AgentPort, Turn } from "../src/session.ts";
import { initialSession, quietHooks } from "./support/harness.ts";
import { allow, deny } from "./support/playback.ts";

const port: AgentPort = {
  prompt: () => new Promise(() => {}),
  cancel: () => Promise.resolve(),
  setConfigOption: () => Promise.resolve([]),
};

/** A session whose user answers every permission question with `answer`. */
function answeredWith(answer: PermissionOption | undefined | Error) {
  const askPermission = () =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  return new AcpSession("s", initialSession, port, { ...quietHooks, askPermission });
}

const ask = (session: AcpSession, options: PermissionOption[]) =>
  session.permission({ sessionId: "s", toolCall: { toolCallId: "t" }, options });

test("a permission answer must be one of the agent's options; otherwise its deny option is sent", async () => {
  expect(await ask(answeredWith(allow), [allow, deny])).toStrictEqual({
    outcome: { outcome: "selected", optionId: "allow" },
  });
  expect(
    await ask(answeredWith({ ...allow }), [allow, deny]),
    "matched by option id",
  ).toStrictEqual({
    outcome: { outcome: "selected", optionId: "allow" },
  });
  const stranger = { ...allow, optionId: "other" };
  expect(await ask(answeredWith(stranger), [allow, deny])).toStrictEqual({
    outcome: { outcome: "selected", optionId: "deny" },
  });
  expect(await ask(answeredWith(new Error("dialog failed")), [allow, deny])).toStrictEqual({
    outcome: { outcome: "selected", optionId: "deny" },
  });
});

test("a permission question with no options, or no deny option, is cancelled unless answered", async () => {
  expect(await ask(answeredWith(undefined), [])).toStrictEqual({
    outcome: { outcome: "cancelled" },
  });
  expect(await ask(answeredWith(undefined), [allow])).toStrictEqual({
    outcome: { outcome: "cancelled" },
  });
});

test("a permission request cannot finish its tool call before the user answers", async () => {
  const answer = Promise.withResolvers<PermissionOption | undefined>();
  const session = new AcpSession("s", initialSession, port, {
    ...quietHooks,
    askPermission: () => answer.promise,
  });
  session.receive({
    sessionUpdate: "tool_call",
    toolCallId: "t",
    title: "Edit",
    status: "pending",
  });
  let finished = false;
  void session
    .watchTool("t", undefined, () => {})
    .then(
      () => {
        finished = true;
      },
      () => {},
    );
  const asked = session.permission({
    sessionId: "s",
    toolCall: { toolCallId: "t", status: "completed" },
    options: [allow, deny],
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(finished, "the tool call is still open while the dialog is").toBe(false);
  answer.resolve(allow);
  expect(await asked).toStrictEqual({ outcome: { outcome: "selected", optionId: "allow" } });
});

test("an agent's plan, commands and title are capped", () => {
  const session = answeredWith(undefined);
  const long = "x".repeat(10_000);
  session.receive({
    sessionUpdate: "plan",
    entries: Array.from({ length: 500 }, () => ({
      content: long,
      priority: "low",
      status: "pending",
    })),
  });
  session.receive({
    sessionUpdate: "available_commands_update",
    availableCommands: Array.from({ length: 1000 }, (_, i) => ({
      name: `c${i}`,
      description: long,
    })),
  });
  session.receive({ sessionUpdate: "session_info_update", title: long });
  const plan = session.plan;
  expect.assert(plan && "steps" in plan);
  expect(plan.steps.length).toBe(100);
  expect(plan.steps[0]?.content.length).toBe(500);
  expect(session.commands?.length).toBe(200);
  expect(session.commands?.[0]?.description.length).toBe(500);
  expect(session.title?.length).toBe(200);
});

test("a turn wakes every reader waiting for its next event", async () => {
  const turn = new Turn();
  const both = Promise.all([turn.next(), turn.next()]);
  turn.push({ type: "text", text: "a" });
  turn.push({ type: "text", text: "b" });
  expect(await both).toStrictEqual([
    { type: "text", text: "a" },
    { type: "text", text: "b" },
  ]);
});

test("a mode the agent switches to itself becomes the current mode", () => {
  const mode = {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select" as const,
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
    ],
  };
  const session = new AcpSession("s", { ...initialSession, options: [mode] }, port, quietHooks);
  session.receive({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
  expect(session.current("mode")).toBe("plan");
});

test("a title the agent clears is cleared", () => {
  const session = answeredWith(undefined);
  session.receive({ sessionUpdate: "session_info_update", title: "Named" });
  session.receive({ sessionUpdate: "session_info_update", title: null });
  expect(session.title).toBeUndefined();
});

test("dropping a session finishes the tool rows still waiting on it", async () => {
  const session = answeredWith(undefined);
  session.receive({
    sessionUpdate: "tool_call",
    toolCallId: "t",
    title: "Run",
    status: "in_progress",
  });
  const watched = session.watchTool("t", undefined, () => {});
  session.dispose();
  expect((await watched)?.settled).toBe(true);
});

test("a late update after the turn ended does not reopen a finished tool call", async () => {
  const session = answeredWith(undefined);
  session.receive({ sessionUpdate: "tool_call", toolCallId: "t", title: "Run", status: "pending" });
  session.dispose();
  session.receive({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress" });
  const watched = await session.watchTool("t", undefined, () => {});
  expect(watched?.settled).toBe(true);
});

test("the notice for a missing mode lists the modes the agent has, or none", () => {
  const mode = {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select" as const,
    currentValue: "default",
    options: [{ value: "default", name: "Default" }],
  };
  const withModes = new AcpSession("s", { ...initialSession, options: [mode] }, port, quietHooks);
  expect(noSuchMode("yolo", withModes)).toBe('Antigravity has no "yolo" mode. Available: default.');
  expect(noSuchMode("", answeredWith(undefined))).toBe('Antigravity has no "" mode.');
});

test("a released terminal's output stays in its tool row after later updates", () => {
  const session = answeredWith(undefined);
  const content = [{ type: "terminal" as const, terminalId: "t" }];
  session.receive({
    sessionUpdate: "tool_call",
    toolCallId: "c",
    title: "Run",
    status: "in_progress",
    content,
  });
  session.terminalOutput("t", "hello");
  session.terminalOutput("t", undefined);
  session.receive({ sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed" });
  const shown = session.watchTool("c", undefined, () => {});
  return expect(shown.then((tool) => tool?.terminalOutput)).resolves.toBe("hello");
});

test("a released terminal's output stays when another terminal in the same row writes", async () => {
  const session = answeredWith(undefined);
  const content = [
    { type: "terminal" as const, terminalId: "a" },
    { type: "terminal" as const, terminalId: "b" },
  ];
  session.receive({
    sessionUpdate: "tool_call",
    toolCallId: "c",
    title: "Run",
    status: "in_progress",
    content,
  });
  session.terminalOutput("a", "first");
  session.terminalOutput("a", undefined);
  session.terminalOutput("b", "second");
  session.receive({ sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed" });
  const tool = await session.watchTool("c", undefined, () => {});
  expect(tool?.terminalOutput).toBe("first\nsecond");
});
