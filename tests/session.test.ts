import type { PermissionOption } from "@agentclientprotocol/sdk/unstable";
import { expect, test } from "vitest";

import { AcpSession, type AgentPort } from "../src/session.ts";

const port: AgentPort = {
  prompt: () => new Promise(() => {}),
  cancel: () => Promise.resolve(),
  setConfigOption: () => Promise.resolve([]),
};
const initial = { options: [], tier: undefined, variants: [], cwd: "/work" };
const allow: PermissionOption = { kind: "allow_once", optionId: "allow", name: "Allow" };
const deny: PermissionOption = { kind: "reject_once", optionId: "deny", name: "Deny" };

/** A session whose user answers every permission question with `answer`. */
function answering(answer: PermissionOption | undefined | Error) {
  const askPermission = () =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  return new AcpSession("s", initial, port, { askPermission, changed: () => {} });
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
