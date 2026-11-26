import {
  agent,
  type AgentConnection,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk/unstable";
import { expect, onTestFinished, test } from "vitest";

import { AcpClient, AcpError, reasonOf } from "../src/client.ts";
import { connect, identity, pair, quietHooks } from "./support/harness.ts";
import { answering, recorder } from "./support/record.ts";

type Builder = ReturnType<typeof agent>;

/** Connects the client to a hand-written agent, for replies the scripted agent never sends. */
async function meet(build: (builder: Builder) => Builder) {
  const { agentSide, clientSide } = pair();
  const connection: AgentConnection = build(agent({ name: "bare" })).connect(agentSide);
  onTestFinished(() => connection.close());
  const client = await AcpClient.connect(clientSide, identity, quietHooks);
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
  await expect(refused).rejects.toThrow(
    `This Antigravity agent speaks ACP version ${PROTOCOL_VERSION + 1}; this extension speaks version ${PROTOCOL_VERSION}.`,
  );
});

test("an agent that says little about itself still gets a working session", async () => {
  const asked = recorder<string>();
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
        asked.record(outcome.outcome);
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
  const session = await client.newSession({ cwd: "/work" });
  expect(asked.all()).toStrictEqual(["cancelled"]);
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
  await expect(client.newSession({ cwd: "/work" })).rejects.toThrow(/sign in/);
});

test("a failed prompt reports the agent's message with any details it attached", async () => {
  const reply = answering([{ details: "quota exhausted" }, { details: 7 }, null]);
  const client = await meet((b) =>
    b
      .onRequest(methods.agent.initialize, () => hello)
      .onRequest(methods.agent.session.new, () => ({ sessionId: "s1" }))
      .onRequest(methods.agent.session.prompt, () => {
        throw new RequestError(-32603, "Internal error", reply());
      }),
  );
  const session = await client.newSession({ cwd: "/work" });
  const failure = async () => {
    const turn = session.startTurn([{ type: "text", text: "hi" }]);
    const event = await turn.next();
    session.endTurn(turn);
    return event;
  };
  expect(await failure()).toStrictEqual({
    type: "failed",
    message: "Internal error: quota exhausted",
  });
  expect(await failure(), "details that are not text").toStrictEqual({
    type: "failed",
    message: "Internal error",
  });
  expect(await failure(), "no data").toStrictEqual({ type: "failed", message: "Internal error" });
});

test("a tier or per-level model list of the wrong shape is ignored", async () => {
  const replies = [
    { _meta: { antigravity: { tier: { name: 5 } } }, models: { availableModels: "none" } },
    {
      _meta: { antigravity: { tier: "Pro" } },
      models: { availableModels: [null, { modelId: 3 }] },
    },
    { _meta: { antigravity: null }, models: { availableModels: [{ modelId: "g-high" }] } },
  ];
  let count = 0;
  const client = await meet((b) =>
    b
      .onRequest(methods.agent.initialize, () => hello)
      .onRequest(methods.agent.session.new, () => ({
        sessionId: `s${++count}`,
        ...replies[count - 1],
      })),
  );
  const sessions = await Promise.all(replies.map(() => client.newSession({ cwd: "/work" })));
  expect(sessions.map((session) => [session.tier, session.variants])).toStrictEqual([
    [undefined, []],
    [undefined, []],
    [undefined, ["g-high"]],
  ]);
});

test("a loaded session counts the prompt turns the agent replays, however many blocks each had", async () => {
  const history = {
    saved: [
      [
        { type: "resource_link" as const, uri: "file:///a", name: "a" },
        { type: "text" as const, text: "one" },
      ],
      [{ type: "text" as const, text: "two" }],
    ],
  };
  const { client, log, close } = await connect({ script: () => [], history });
  onTestFinished(close);
  const session = await client.loadSession("saved", { cwd: "/work" });
  expect.assert(session);
  expect([session.id, session.turns, session.usage]).toStrictEqual([
    "saved",
    2,
    { used: 0, size: 1_000_000 },
  ]);
  expect(await client.loadSession("missing", { cwd: "/work" })).toBeUndefined();
  await client.closeSession("saved");
  expect([log.loads, log.closes]).toStrictEqual([["saved", "missing"], ["saved"]]);
});

test("an agent without session/load or session/close is not asked for either", async () => {
  const { client, log, close } = await connect({
    script: () => [],
    restore: false,
    history: { a: [] },
  });
  onTestFinished(close);
  expect(client.offers).toStrictEqual({
    load: false,
    close: false,
    directories: true,
    mcpHttp: false,
    logout: true,
    list: false,
  });
  expect(await client.loadSession("a", { cwd: "/work" })).toBeUndefined();
  await client.closeSession("a");
  expect([log.loads, log.closes]).toStrictEqual([[], []]);
});

test("a load that fails for another reason says so", async () => {
  const client = await meet((b) =>
    b
      .onRequest(methods.agent.initialize, () => ({
        ...hello,
        agentCapabilities: { loadSession: true },
      }))
      .onRequest(methods.agent.session.load, () => {
        throw RequestError.internalError(undefined, "disk full");
      }),
  );
  await expect(client.loadSession("a", { cwd: "/work" })).rejects.toThrow(
    "Antigravity could not reopen the saved session: Internal error",
  );
});

test("updates held for a session that failed to load do not reach it when it loads later", async () => {
  let loads = 0;
  const client = await meet((b) =>
    b
      .onRequest(methods.agent.initialize, () => ({
        ...hello,
        agentCapabilities: { loadSession: true },
      }))
      .onRequest(methods.agent.session.load, async ({ params, client: agentSide }) => {
        loads += 1;
        if (loads > 1) return {};
        await agentSide.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "session_info_update", title: "Stale" },
        });
        throw RequestError.resourceNotFound(params.sessionId);
      }),
  );
  expect(await client.loadSession("a", { cwd: "/work" })).toBeUndefined();
  const session = await client.loadSession("a", { cwd: "/work" });
  expect(session?.title).toBeUndefined();
});

test("updates for many unknown sessions cannot crowd out a new session's own", async () => {
  const client = await meet((b) =>
    b
      .onRequest(methods.agent.initialize, () => hello)
      .onRequest(methods.agent.session.new, async ({ client: agentSide }) => {
        const flood = Array.from({ length: 100 }, (_, i) =>
          agentSide.notify(methods.client.session.update, {
            sessionId: `junk${i}`,
            update: { sessionUpdate: "usage_update", used: 1, size: 2 },
          }),
        );
        await Promise.all(flood);
        await agentSide.notify(methods.client.session.update, {
          sessionId: "real",
          update: { sessionUpdate: "usage_update", used: 5, size: 10 },
        });
        return { sessionId: "real" };
      }),
  );
  const session = await client.newSession({ cwd: "/work" });
  expect(session.usage).toStrictEqual({ used: 5, size: 10 });
});

test("extra directories and MCP servers reach the agent only as far as it accepts them", async () => {
  const stdio = { name: "files", command: "/bin/fs-mcp", args: ["."], env: [] };
  const http = {
    type: "http" as const,
    name: "docs",
    url: "https://docs.example/mcp",
    headers: [],
  };
  const where = { cwd: "/work", directories: ["/lib"], mcpServers: [stdio, http] };
  const both = await connect({ script: () => [], mcpHttp: true, history: { old: [] } });
  onTestFinished(both.close);
  await both.client.newSession(where);
  await both.client.loadSession("old", where);
  expect(both.log.sessions[0]).toMatchObject({
    additionalDirectories: ["/lib"],
    mcpServers: [stdio, http],
  });
  expect(both.log.loadRequests[0]).toMatchObject({
    additionalDirectories: ["/lib"],
    mcpServers: [stdio, http],
  });

  const plain = await connect({ script: () => [], directories: false });
  onTestFinished(plain.close);
  await plain.client.newSession(where);
  expect(plain.log.sessions[0]?.additionalDirectories).toBeUndefined();
  expect(plain.log.sessions[0]?.mcpServers).toStrictEqual([stdio]);
});

test("an error's reason is its message, cut to 300 characters; anything else gives the fallback", () => {
  expect(reasonOf(new Error("boom"), "none")).toBe("boom");
  expect(reasonOf(new Error(""), "none")).toBe("");
  expect(reasonOf(new Error("x".repeat(300)), "none")).toHaveLength(300);
  expect(reasonOf(new Error("x".repeat(301)), "none")).toHaveLength(300);
  for (const thrown of [null, undefined, "text", 42, { message: "not an Error" }])
    expect(reasonOf(thrown, "none"), JSON.stringify(thrown)).toBe("none");
});
