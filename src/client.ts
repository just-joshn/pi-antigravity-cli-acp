import {
  client,
  type ClientConnection,
  type InitializeRequest,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type SessionUpdate,
  type Stream,
} from "@agentclientprotocol/sdk/unstable";

import { readTextFile, writeTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import { AcpSession, type AgentPort, type SessionHooks } from "./session.ts";

/** A failure the user can act on. Its message is shown as is. */
export class AcpError extends Error {}

export interface ClientIdentity {
  name: string;
  title: string;
  version: string;
}

const AUTH_REQUIRED = -32000;
const EARLY_UPDATE_LIMIT = 64;

function tierName(meta: unknown): string | undefined {
  const antigravity = isRecord(meta) ? meta["antigravity"] : undefined;
  const tier = isRecord(antigravity) ? antigravity["tier"] : undefined;
  return isRecord(tier) && typeof tier["name"] === "string" ? tier["name"] : undefined;
}

/** Both Antigravity servers also list each model once per thinking level, outside the typed schema. */
function modelVariants(created: unknown): string[] {
  const models = isRecord(created) ? created["models"] : undefined;
  const available =
    isRecord(models) && Array.isArray(models["availableModels"]) ? models["availableModels"] : [];
  return available.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry["modelId"] === "string" ? [entry["modelId"]] : [],
  );
}

function explain(action: string) {
  return (error: unknown): never => {
    if (error instanceof RequestError && error.code === AUTH_REQUIRED)
      throw new AcpError(
        "Antigravity needs you to sign in. Run `agy` in a terminal, sign in, then try again.",
      );
    const reason = error instanceof Error ? error.message.slice(0, 300) : "the agent stopped";
    throw new AcpError(`Antigravity could not ${action}: ${reason}`);
  };
}

/** Answers the agent's requests for the sessions in `sessions`. */
function serve(
  stream: Stream,
  identity: ClientIdentity,
  sessions: ReadonlyMap<string, AcpSession>,
  early: Map<string, SessionUpdate[]>,
): ClientConnection {
  return client({ name: identity.name })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      const session = sessions.get(params.sessionId);
      return session ? session.permission(params) : { outcome: { outcome: "cancelled" } };
    })
    .onRequest(methods.client.fs.readTextFile, ({ params }) => readTextFile(params))
    .onRequest(methods.client.fs.writeTextFile, ({ params }) =>
      writeTextFile(params, sessions.get(params.sessionId)?.cwd),
    )
    .onNotification(methods.client.session.update, ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (session) {
        session.receive(params.update);
        return;
      }
      // Agents report usage before session/new returns; keep it until the session exists.
      const held = early.get(params.sessionId) ?? [];
      if (held.length < EARLY_UPDATE_LIMIT) early.set(params.sessionId, [...held, params.update]);
    })
    .connect(stream);
}

/** One connection to an ACP agent process. */
export class AcpClient {
  readonly agent: { name: string; version: string };
  /** Prompt content the agent accepts besides text. */
  readonly accepts: { image: boolean; embeddedContext: boolean };
  #connection: ClientConnection;
  #sessions: Map<string, AcpSession>;
  #early: Map<string, SessionUpdate[]>;
  #hooks: SessionHooks;

  private constructor(
    connection: ClientConnection,
    sessions: Map<string, AcpSession>,
    early: Map<string, SessionUpdate[]>,
    hooks: SessionHooks,
    hello: { agent: AcpClient["agent"]; accepts: AcpClient["accepts"] },
  ) {
    this.#connection = connection;
    this.#sessions = sessions;
    this.#early = early;
    this.#hooks = hooks;
    this.agent = hello.agent;
    this.accepts = hello.accepts;
  }

  static async connect(
    stream: Stream,
    identity: ClientIdentity,
    hooks: SessionHooks,
  ): Promise<AcpClient> {
    const sessions = new Map<string, AcpSession>();
    const early = new Map<string, SessionUpdate[]>();
    const connection = serve(stream, identity, sessions, early);
    const introduction: InitializeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: identity,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    };
    const hello = await connection.agent
      .request(methods.agent.initialize, introduction)
      .catch(explain("start"));
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      connection.close();
      throw new AcpError("This Antigravity agent speaks an ACP version this extension does not.");
    }
    const prompts = hello.agentCapabilities?.promptCapabilities;
    return new AcpClient(connection, sessions, early, hooks, {
      agent: {
        name: hello.agentInfo?.title ?? hello.agentInfo?.name ?? "ACP agent",
        version: hello.agentInfo?.version ?? "",
      },
      accepts: {
        image: prompts?.image === true,
        embeddedContext: prompts?.embeddedContext === true,
      },
    });
  }

  /** Resolves when the connection ends, for whatever reason. */
  get closed(): Promise<void> {
    return this.#connection.closed;
  }

  async newSession(cwd: string): Promise<AcpSession> {
    const { agent } = this.#connection;
    const created = await agent
      .request(methods.agent.session.new, { cwd, mcpServers: [] })
      .catch(explain("start a session"));
    const port: AgentPort = {
      prompt: (sessionId, prompt) =>
        agent.request(methods.agent.session.prompt, { sessionId, prompt }),
      cancel: (sessionId) => agent.notify(methods.agent.session.cancel, { sessionId }),
      setConfigOption: async (sessionId, configId, value) => {
        const reply = await agent
          .request(methods.agent.session.setConfigOption, { sessionId, configId, value })
          .catch(explain(`change ${configId}`));
        return reply.configOptions;
      },
    };
    const session = new AcpSession(
      created.sessionId,
      {
        options: created.configOptions ?? [],
        // oxlint-disable-next-line no-underscore-dangle -- ACP's name for protocol metadata
        tier: tierName(created._meta),
        variants: modelVariants(created),
        cwd,
      },
      port,
      this.#hooks,
    );
    this.#sessions.set(session.id, session);
    for (const update of this.#early.get(session.id) ?? []) session.receive(update);
    this.#early.delete(session.id);
    return session;
  }

  close() {
    this.#connection.close();
  }
}
