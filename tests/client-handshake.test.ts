import {
  agent,
  type AgentConnection,
  type AnyMessage,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk/unstable";
import { expect, onTestFinished, test } from "vitest";

import { AcpClient, AcpError } from "../src/client.ts";
import { identity } from "./support/harness.ts";

type Builder = ReturnType<typeof agent>;

/** Connects the client to a hand-written agent, for replies the scripted agent never sends. */
async function meet(build: (builder: Builder) => Builder) {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>();
  const toClient = new TransformStream<AnyMessage, AnyMessage>();
  const connection: AgentConnection = build(agent({ name: "bare" })).connect({
    readable: toAgent.readable,
    writable: toClient.writable,
  });
  onTestFinished(() => connection.close());
  const client = await AcpClient.connect(
    { readable: toClient.readable, writable: toAgent.writable },
    identity,
    { askPermission: () => Promise.resolve(undefined), changed: () => {} },
  );
  onTestFinished(() => client.close());
  return client;
}

const hello = { protocolVersion: PROTOCOL_VERSION };
const mode = {
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select" as const,
  currentValue: "default",
  options: [
    { value: "default", name: "Default" },
    { value: "auto", name: "Auto" },
  ],
};

test("an agent that needs sign-in, fails to start or speaks another ACP version is explained", async () => {
  await expect(
    meet((b) =>
      b.onRequest(methods.agent.initialize, () => {
        throw new RequestError(-32000, "Authentication required");
      }),
    ),
  ).rejects.toThrow(/sign in/);
  await expect(
    meet((b) =>
      b.onRequest(methods.agent.initialize, () => {
        throw new Error("boom");
      }),
    ),
  ).rejects.toThrow(/^Antigravity could not start: /);
  const refused = meet((b) =>
    b.onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION + 1 })),
  );
  await expect(refused).rejects.toThrow(AcpError);
  await expect(refused).rejects.toThrow(/ACP version/);
});

test("an agent that says little about itself still gets a working session", async () => {
  const asked: string[] = [];
  const client = await meet((b) =>
    b
      .onRequest(methods.agent.initialize, () => hello)
      .onRequest(methods.agent.session.new, async ({ client: pi }) => {
        // A permission request for a session that does not exist is cancelled.
        const { outcome } = await pi.request(methods.client.session.requestPermission, {
          sessionId: "unknown",
          toolCall: { toolCallId: "t" },
          options: [],
        });
        asked.push(outcome.outcome);
        return {
          sessionId: "s1",
          configOptions: [mode],
          _meta: { antigravity: "no tier here" },
          models: [],
        };
      })
      .onRequest(methods.agent.session.setConfigOption, () => {
        throw new Error("no such option");
      }),
  );
  expect(client.agent).toStrictEqual({ name: "ACP agent", version: "" });
  expect(client.accepts).toStrictEqual({ image: false, embeddedContext: false });
  const session = await client.newSession("/work");
  expect(asked).toStrictEqual(["cancelled"]);
  expect(session.tier).toBeUndefined();
  expect(session.choices("model")).toStrictEqual([]);
  await expect(session.select("mode", "auto")).rejects.toThrow(
    /^Antigravity could not change mode: /,
  );
});

test("a session the agent cannot create is explained", async () => {
  const client = await meet((b) =>
    b
      .onRequest(methods.agent.initialize, () => ({
        ...hello,
        agentInfo: { name: "bare", version: "1" },
      }))
      .onRequest(methods.agent.session.new, () => {
        throw new RequestError(-32000, "Authentication required");
      }),
  );
  expect(client.agent).toStrictEqual({ name: "bare", version: "1" });
  await expect(client.newSession("/work")).rejects.toThrow(/sign in/);
});
