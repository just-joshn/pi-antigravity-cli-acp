import type { PermissionOption } from "@agentclientprotocol/sdk/unstable";
import { expect, test } from "vitest";

import { AcpSession, type AgentPort } from "../src/session.ts";
import { quietHooks, resolvable } from "./support/harness.ts";

const port: AgentPort = {
  prompt: () => new Promise(() => {}),
  cancel: () => Promise.resolve(),
  setConfigOption: () => Promise.resolve([]),
};
const initial = { options: [], tier: undefined, variants: [], cwd: "/work", turns: 0 };
const allow: PermissionOption = { kind: "allow_once", optionId: "allow", name: "Allow" };
const deny: PermissionOption = { kind: "reject_once", optionId: "deny", name: "Deny" };

/** A session whose user answers every permission question with `answer`. */
function answering(answer: PermissionOption | undefined | Error) {
  const askPermission = () =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  return new AcpSession("s", initial, port, { ...quietHooks, askPermission });
}

const ask = (session: AcpSession, options: PermissionOption[]) =>
  session.permission({ sessionId: "s", toolCall: { toolCallId: "t" }, options });

test("a permission answer must be one of the agent's options; otherwise its deny option is sent", async () => {
  expect(await ask(answering(allow), [allow, deny])).toStrictEqual({
    outcome: { outcome: "selected", optionId: "allow" },
  });
  const stranger = { ...allow, optionId: "other" };
  expect(await ask(answering(stranger), [allow, deny])).toStrictEqual({
    outcome: { outcome: "selected", optionId: "deny" },
  });
  expect(await ask(answering(new Error("dialog failed")), [allow, deny])).toStrictEqual({
    outcome: { outcome: "selected", optionId: "deny" },
  });
});

test("a permission question with no options, or no deny option, is cancelled unless answered", async () => {
  expect(await ask(answering(undefined), [])).toStrictEqual({ outcome: { outcome: "cancelled" } });
  expect(await ask(answering(undefined), [allow])).toStrictEqual({
    outcome: { outcome: "cancelled" },
  });
});

test("a permission request cannot finish its tool call before the user answers", async () => {
  const answer = resolvable<PermissionOption | undefined>();
  const session = new AcpSession("s", initial, port, {
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
  const session = answering(undefined);
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
  expect(session.plan.length).toBe(100);
  expect(session.plan[0]?.content.length).toBe(500);
  expect(session.commands?.length).toBe(200);
  expect(session.commands?.[0]?.description.length).toBe(500);
  expect(session.title?.length).toBe(200);
});
