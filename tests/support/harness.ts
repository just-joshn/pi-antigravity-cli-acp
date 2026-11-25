import type { AnyMessage } from "@agentclientprotocol/sdk/unstable";

import { AcpClient } from "../../src/client.ts";
import type { SessionHooks } from "../../src/session.ts";
import { type FakeAgentOptions, serveAgent } from "./fake-agent.ts";

export const identity = { name: "pi", title: "Pi", version: "9.9.9" };

/** Hooks for a session nobody answers: permissions and questions are left undecided. */
export const quietHooks: SessionHooks = {
  askPermission: () => Promise.resolve(undefined),
  elicit: () => Promise.resolve({ action: "cancel" }),
  changed: () => {},
};

/** A promise the test settles by hand. */
export function deferred() {
  const settle: { resolve?: () => void } = {};
  const promise = new Promise<void>((done) => {
    settle.resolve = done;
  });
  return { promise, resolve: () => settle.resolve?.() };
}

/** A promise of a value the test supplies by hand. */
export function resolvable<T>() {
  const settle: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>((done) => {
    settle.resolve = done;
  });
  return { promise, resolve: (value: T) => settle.resolve?.(value) };
}

/** Connects a real ACP client to a scripted in-memory agent. */
export async function connect(options: FakeAgentOptions, hooks: Partial<SessionHooks> = {}) {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>();
  const toClient = new TransformStream<AnyMessage, AnyMessage>();
  const fake = serveAgent({ readable: toAgent.readable, writable: toClient.writable }, options);
  const client = await AcpClient.connect(
    { readable: toClient.readable, writable: toAgent.writable },
    identity,
    { ...quietHooks, ...hooks },
  );
  return {
    client,
    log: fake.log,
    close: () => {
      client.close();
      fake.close();
    },
  };
}
