import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";

import { noUsage } from "../src/draft.ts";
import { AcpSession, type AgentPort, type SessionHooks } from "../src/session.ts";
import { haltTurn, NOT_RESENT } from "../src/stream.ts";
import { initialSession, quietHooks, resolvable } from "./support/harness.ts";

const hooks: SessionHooks = quietHooks;
const initial = initialSession;
/** An agent that never answers a prompt and whose connection is gone. */
const gone: AgentPort = {
  prompt: () => new Promise(() => {}),
  cancel: () => Promise.reject(new Error("connection closed")),
  setConfigOption: () => Promise.resolve([]),
};

test("stopping a turn sends one cancel for concurrent callers and clears the turn", async () => {
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
});

test("stopping a turn of an agent that is gone reports it unconfirmed without throwing", async () => {
  const dead = new AcpSession("d", initial, gone, hooks);
  dead.startTurn([]);
  expect(await haltTurn(dead, 20)).toBe(false);
});

test("an open permission dialog is withdrawn when its turn ends", async () => {
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

test("the message shown instead of a repeat is one Pi does not retry on its own", () => {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "antigravity-acp",
    provider: "antigravity",
    model: "default",
    usage: noUsage(),
    stopReason: "error",
    timestamp: 1,
  };
  expect(isRetryableAssistantError({ ...message, errorMessage: NOT_RESENT })).toBe(false);
  expect(
    isRetryableAssistantError({ ...message, errorMessage: "stopped (ACP connection closed)" }),
    "the classifier this guards against",
  ).toBe(true);
});
