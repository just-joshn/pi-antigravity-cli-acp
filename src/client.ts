import {
  client,
  type ClientConnection,
  type InitializeRequest,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type SessionConfigOption,
  type SessionUpdate,
  type Stream,
} from "@agentclientprotocol/sdk/unstable";

import { readTextFile, writeTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import { AcpSession, type AgentPort, type SessionHooks } from "./session.ts";

/** A failure the user can act on. Its message is shown as is. */
export class AcpError extends Error {}

/** The start of an error's message, to show the user why something failed. */
export function reasonOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.slice(0, 300) : fallback;
}

export interface ClientIdentity {
  name: string;
  title: string;
  version: string;
}

const AUTH_REQUIRED = -32000;
const RESOURCE_NOT_FOUND = -32002;
const EARLY_UPDATE_LIMIT = 64;

/** Prompt turns an agent replays while it loads a saved session; each starts with the user speaking. */
interface Replay {
  turns: number;
  userSpeaking: boolean;
}

/** Updates that arrive before their session exists: settings and usage are kept, a replay is counted. */
interface Inbox {
  early: Map<string, SessionUpdate[]>;
  replays: Map<string, Replay>;
}

function hold(inbox: Inbox, sessionId: string, update: SessionUpdate) {
  const replay = inbox.replays.get(sessionId);
  const kind = update.sessionUpdate;
  if (replay && kind === "user_message_chunk") {
    if (!replay.userSpeaking) replay.turns += 1;
    replay.userSpeaking = true;
    return;
  }
  if (replay && /^(agent_|tool_call|plan)/.test(kind)) {
    replay.userSpeaking = false;
    return;
  }
  const held = inbox.early.get(sessionId) ?? [];
  if (held.length < EARLY_UPDATE_LIMIT) inbox.early.set(sessionId, [...held, update]);
}

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
    throw new AcpError(`Antigravity could not ${action}: ${reasonOf(error, "the agent stopped")}`);
  };
}

/** Answers the agent's requests for the sessions in `sessions`. */
function serve(
  stream: Stream,
  identity: ClientIdentity,
  sessions: ReadonlyMap<string, AcpSession>,
  inbox: Inbox,
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
      // Agents report usage before session/new returns; keep it until the session exists.
      if (session) session.receive(params.update);
      else hold(inbox, params.sessionId, params.update);
    })
    .connect(stream);
}

/** One connection to an ACP agent process. */
export class AcpClient {
  readonly agent: { name: string; version: string };
  /** Prompt content the agent accepts besides text. */
  readonly accepts: { image: boolean; embeddedContext: boolean };
  /** Session lifecycle requests the agent offers besides session/new. */
  readonly offers: { load: boolean; close: boolean };
  #connection: ClientConnection;
  #sessions: Map<string, AcpSession>;
  #inbox: Inbox;
  #hooks: SessionHooks;

  private constructor(
    connection: ClientConnection,
    sessions: Map<string, AcpSession>,
    inbox: Inbox,
    hooks: SessionHooks,
    hello: Pick<AcpClient, "agent" | "accepts" | "offers">,
  ) {
    this.#connection = connection;
    this.#sessions = sessions;
    this.#inbox = inbox;
    this.#hooks = hooks;
    this.agent = hello.agent;
    this.accepts = hello.accepts;
    this.offers = hello.offers;
  }

  static async connect(
    stream: Stream,
    identity: ClientIdentity,
    hooks: SessionHooks,
  ): Promise<AcpClient> {
    const sessions = new Map<string, AcpSession>();
    const inbox: Inbox = { early: new Map(), replays: new Map() };
    const connection = serve(stream, identity, sessions, inbox);
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
    return new AcpClient(connection, sessions, inbox, hooks, {
      agent: {
        name: hello.agentInfo?.title ?? hello.agentInfo?.name ?? "ACP agent",
        version: hello.agentInfo?.version ?? "",
      },
      accepts: {
        image: prompts?.image === true,
        embeddedContext: prompts?.embeddedContext === true,
      },
      offers: {
        load: hello.agentCapabilities?.loadSession === true,
        close: Boolean(hello.agentCapabilities?.sessionCapabilities?.close),
      },
    });
  }

  /** Resolves when the connection ends, for whatever reason. */
  get closed(): Promise<void> {
    return this.#connection.closed;
  }

  async newSession(cwd: string): Promise<AcpSession> {
    const created = await this.#connection.agent
      .request(methods.agent.session.new, { cwd, mcpServers: [] })
      .catch(explain("start a session"));
    return this.#adopt(created.sessionId, created, cwd, 0);
  }

  /**
   * Reopens a saved agent session, with its prompt turns counted from the agent's replay.
   * Resolves with undefined when the agent cannot load sessions or no longer has this one.
   */
  async loadSession(sessionId: string, cwd: string): Promise<AcpSession | undefined> {
    if (!this.offers.load) return undefined;
    const replay = { turns: 0, userSpeaking: false };
    this.#inbox.replays.set(sessionId, replay);
    try {
      const loaded = await this.#connection.agent.request(methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers: [],
      });
      return this.#adopt(sessionId, loaded, cwd, replay.turns);
    } catch (error) {
      if (error instanceof RequestError && error.code === RESOURCE_NOT_FOUND) return undefined;
      return explain("reopen the saved session")(error);
    } finally {
      this.#inbox.replays.delete(sessionId);
    }
  }

  /** Lets the agent free a session this client no longer uses. */
  async closeSession(sessionId: string): Promise<void> {
    this.#sessions.delete(sessionId);
    if (!this.offers.close) return;
    await this.#connection.agent
      .request(methods.agent.session.close, { sessionId })
      .catch(explain("close a session"));
  }

  #adopt(
    sessionId: string,
    opened: { configOptions?: SessionConfigOption[] | null; _meta?: unknown },
    cwd: string,
    turns: number,
  ): AcpSession {
    const { agent } = this.#connection;
    const port: AgentPort = {
      prompt: (id, prompt) =>
        agent.request(methods.agent.session.prompt, { sessionId: id, prompt }),
      cancel: (id) => agent.notify(methods.agent.session.cancel, { sessionId: id }),
      setConfigOption: async (id, configId, value) => {
        const reply = await agent
          .request(methods.agent.session.setConfigOption, { sessionId: id, configId, value })
          .catch(explain(`change ${configId}`));
        return reply.configOptions;
      },
    };
    const session = new AcpSession(
      sessionId,
      {
        options: opened.configOptions ?? [],
        // oxlint-disable-next-line no-underscore-dangle -- ACP's name for protocol metadata
        tier: tierName(opened._meta),
        variants: modelVariants(opened),
        cwd,
        turns,
      },
      port,
      this.#hooks,
    );
    this.#sessions.set(session.id, session);
    for (const update of this.#inbox.early.get(session.id) ?? []) session.receive(update);
    this.#inbox.early.delete(session.id);
    return session;
  }

  close() {
    this.#connection.close();
  }
}
