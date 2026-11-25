import {
  client,
  type ClientConnection,
  type InitializeRequest,
  type InitializeResponse,
  type McpServer,
  methods,
  type NewSessionRequest,
  PROTOCOL_VERSION,
  RequestError,
  type SessionConfigOption,
  type SessionInfo,
  type Stream,
} from "@agentclientprotocol/sdk/unstable";

import { readTextFile, writeTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import { Registry } from "./immutable.ts";
import { type Exchange, Inbox } from "./inbox.ts";
import { AcpSession, type AgentPort, type SessionHooks } from "./session.ts";
import { Terminals } from "./terminal.ts";

/** A failure the user can act on. Its message is shown as is. */
export class AcpError extends Error {}

/** The agent needs the user to sign in before it can start a session. */
export class SignInRequired extends AcpError {}

/** A way the agent offers to sign in. */
export interface SignInMethod {
  id: string;
  name: string;
  description: string | undefined;
}

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
/** A conversation the agent keeps, as session/list reports it. */
export interface SavedSession {
  id: string;
  title: string | undefined;
  updatedAt: string | undefined;
}

const LIST_PAGES = 5;

function savedSession(info: SessionInfo): SavedSession {
  return {
    id: info.sessionId,
    title: info.title ?? undefined,
    updatedAt: info.updatedAt ?? undefined,
  };
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
      throw new SignInRequired(
        "Antigravity needs you to sign in. Run `agy` in a terminal, sign in, then try again.",
      );
    throw new AcpError(`Antigravity could not ${action}: ${reasonOf(error, "the agent stopped")}`);
  };
}

/** Runs the agent's commands for the sessions in `sessions`. */
function terminalsFor(sessions: Registry<AcpSession>) {
  return new Terminals((sessionId, terminalId, output) =>
    sessions.get(sessionId)?.terminalOutput(terminalId, output),
  );
}

function sessionCwd(sessions: Registry<AcpSession>, sessionId: string): string {
  const session = sessions.get(sessionId);
  if (!session) throw RequestError.invalidParams(undefined, `no session ${sessionId}`);
  return session.cwd;
}

type ClientBuilder = ReturnType<typeof client>;

/** Answers the agent's terminal requests; each names its session and terminal. */
function serveTerminals(
  builder: ClientBuilder,
  sessions: Registry<AcpSession>,
  terminals: Terminals,
): ClientBuilder {
  return builder
    .onRequest(methods.client.terminal.create, ({ params }) =>
      terminals.create(params, sessionCwd(sessions, params.sessionId)),
    )
    .onRequest(methods.client.terminal.output, ({ params }) =>
      terminals.output(params.sessionId, params.terminalId),
    )
    .onRequest(methods.client.terminal.waitForExit, ({ params }) =>
      terminals.waitForExit(params.sessionId, params.terminalId),
    )
    .onRequest(methods.client.terminal.kill, ({ params }) =>
      terminals.kill(params.sessionId, params.terminalId),
    )
    .onRequest(methods.client.terminal.release, ({ params }) =>
      terminals.release(params.sessionId, params.terminalId),
    );
}

/** Answers the agent's requests for the sessions in `sessions`. */
function serve(
  stream: Stream,
  identity: ClientIdentity,
  sessions: Registry<AcpSession>,
  inbox: Inbox,
  hooks: SessionHooks,
  terminals: Terminals,
): ClientConnection {
  return serveTerminals(client({ name: identity.name }), sessions, terminals)
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      const session = sessions.get(params.sessionId);
      return session ? session.permission(params) : { outcome: { outcome: "cancelled" } };
    })
    .onRequest(methods.client.elicitation.create, ({ params }) => {
      if ("sessionId" in params) {
        const session = sessions.get(String(params.sessionId));
        return session ? session.elicit(params) : { action: "cancel" };
      }
      // A question outside any session, such as during sign-in; it cannot be interrupted.
      return hooks.elicit(params, new AbortController().signal);
    })
    .onNotification(methods.client.elicitation.complete, () => {
      // Only says the agent finished with a link it showed; nothing in Pi waits for that.
    })
    .onRequest(methods.client.fs.readTextFile, ({ params }) => readTextFile(params))
    .onRequest(methods.client.fs.writeTextFile, ({ params }) =>
      writeTextFile(params, sessions.get(params.sessionId)?.workspaces ?? []),
    )
    .onNotification(methods.client.session.update, ({ params }) => {
      const session = sessions.get(params.sessionId);
      // Agents report usage before session/new returns; keep it until the session exists.
      if (session) session.receive(params.update);
      else inbox.hold(params.sessionId, params.update);
    })
    .connect(stream);
}

/** Where a session works: its directory, extra directories and the MCP servers it may use. */
export interface Workspace {
  cwd: string;
  directories?: readonly string[];
  mcpServers?: readonly McpServer[];
}

type Introduced = Pick<AcpClient, "agent" | "accepts" | "offers" | "signInMethods">;

/** What the agent said about itself in `initialize`, in the terms this client uses. */
function introduced(hello: InitializeResponse): Introduced {
  const capabilities = hello.agentCapabilities;
  const sessionCapabilities = capabilities?.sessionCapabilities;
  const prompts = capabilities?.promptCapabilities;
  return {
    agent: {
      name: hello.agentInfo?.title ?? hello.agentInfo?.name ?? "ACP agent",
      version: hello.agentInfo?.version ?? "",
    },
    accepts: {
      image: prompts?.image === true,
      embeddedContext: prompts?.embeddedContext === true,
    },
    offers: {
      load: capabilities?.loadSession === true,
      close: Boolean(sessionCapabilities?.close),
      directories: Boolean(sessionCapabilities?.additionalDirectories),
      mcpHttp: capabilities?.mcpCapabilities?.http === true,
      logout: Boolean(capabilities?.auth?.logout),
      list: Boolean(sessionCapabilities?.list),
    },
    signInMethods: (hello.authMethods ?? []).flatMap((method) =>
      "type" in method
        ? []
        : [{ id: method.id, name: method.name, description: method.description ?? undefined }],
    ),
  };
}

/** One connection to an ACP agent process. */
export class AcpClient {
  readonly agent: { name: string; version: string };
  /** Prompt content the agent accepts besides text. */
  readonly accepts: { image: boolean; embeddedContext: boolean };
  /** Session lifecycle requests the agent offers besides session/new. */
  readonly offers: {
    load: boolean;
    close: boolean;
    directories: boolean;
    mcpHttp: boolean;
    logout: boolean;
    list: boolean;
  };
  /** Sign-in methods the agent runs itself; terminal methods need a capability Pi does not offer. */
  readonly signInMethods: readonly SignInMethod[];
  #connection: ClientConnection;
  #terminals: Terminals;
  #sessions: Registry<AcpSession>;
  #inbox: Inbox;
  #hooks: SessionHooks;

  private constructor(
    connection: ClientConnection,
    sessions: Registry<AcpSession>,
    inbox: Inbox,
    hooks: SessionHooks,
    terminals: Terminals,
    hello: Introduced,
  ) {
    this.#terminals = terminals;
    this.#connection = connection;
    this.#sessions = sessions;
    this.#inbox = inbox;
    this.#hooks = hooks;
    this.agent = hello.agent;
    this.accepts = hello.accepts;
    this.offers = hello.offers;
    this.signInMethods = hello.signInMethods;
  }

  static async connect(
    stream: Stream,
    identity: ClientIdentity,
    hooks: SessionHooks,
  ): Promise<AcpClient> {
    const sessions = new Registry<AcpSession>();
    const inbox = new Inbox();
    const terminals = terminalsFor(sessions);
    const connection = serve(stream, identity, sessions, inbox, hooks, terminals);
    const introduction: InitializeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: identity,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        elicitation: { form: {}, url: {} },
        plan: {},
      },
    };
    const hello = await connection.agent
      .request(methods.agent.initialize, introduction)
      .catch((error: unknown) => {
        connection.close();
        return explain("start")(error);
      });
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      connection.close();
      throw new AcpError(
        `This Antigravity agent speaks ACP version ${hello.protocolVersion}; this extension speaks version ${PROTOCOL_VERSION}.`,
      );
    }
    return new AcpClient(connection, sessions, inbox, hooks, terminals, introduced(hello));
  }

  /** Resolves when the connection ends, for whatever reason. */
  get closed(): Promise<void> {
    return this.#connection.closed;
  }

  /** The session/new and session/load fields for `where`, limited to what the agent accepts. */
  #place(where: Workspace): NewSessionRequest {
    const mcpServers = (where.mcpServers ?? []).filter(
      (server) => this.offers.mcpHttp || !("type" in server),
    );
    const directories = where.directories ?? [];
    return {
      cwd: where.cwd,
      mcpServers,
      ...(this.offers.directories && directories.length
        ? { additionalDirectories: [...directories] }
        : {}),
    };
  }

  async newSession(where: Workspace): Promise<AcpSession> {
    const created = await this.#connection.agent
      .request(methods.agent.session.new, this.#place(where))
      .catch(explain("start a session"));
    return this.#adopt(created.sessionId, created, this.#place(where), 0);
  }

  /**
   * Reopens a saved agent session, with its prompt turns counted from the agent's replay.
   * Resolves with undefined when the agent cannot load sessions or no longer has this one.
   */
  async loadSession(sessionId: string, where: Workspace): Promise<AcpSession | undefined> {
    return (await this.#load(sessionId, where, false))?.session;
  }

  /** A saved conversation's text, read by loading it and closing it again. */
  async readTranscript(
    sessionId: string,
    where: Workspace,
  ): Promise<readonly Exchange[] | undefined> {
    const loaded = await this.#load(sessionId, where, true);
    if (!loaded) return undefined;
    // Closing frees the agent's memory; a session left open costs nothing visible.
    await this.closeSession(sessionId).catch(() => undefined);
    return loaded.exchanges;
  }

  /** The agent's saved conversations for `cwd`, newest first as the agent lists them. */
  async listSessions(cwd: string): Promise<SavedSession[]> {
    if (!this.offers.list) return [];
    const found: SavedSession[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < LIST_PAGES; page++) {
      // oxlint-disable-next-line no-await-in-loop -- each page names the next
      const listed = await this.#connection.agent
        .request(methods.agent.session.list, { cwd, ...(cursor ? { cursor } : {}) })
        .catch(explain("list its sessions"));
      found.push(...listed.sessions.map(savedSession));
      cursor = listed.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return found;
  }

  async #load(sessionId: string, where: Workspace, keepText: boolean) {
    if (!this.offers.load) return undefined;
    this.#inbox.startReplay(sessionId, keepText);
    const loaded = await this.#connection.agent
      .request(methods.agent.session.load, { sessionId, ...this.#place(where) })
      .catch((error: unknown) => {
        this.#inbox.endReplay(sessionId);
        this.#inbox.take(sessionId);
        if (error instanceof RequestError && error.code === RESOURCE_NOT_FOUND) return undefined;
        return explain("reopen the saved session")(error);
      });
    if (!loaded) return undefined;
    const replay = this.#inbox.endReplay(sessionId);
    const session = this.#adopt(sessionId, loaded, this.#place(where), replay?.turns ?? 0);
    return { session, exchanges: replay?.exchanges ?? [] };
  }

  async signIn(methodId: string): Promise<void> {
    await this.#connection.agent
      .request(methods.agent.authenticate, { methodId })
      .catch(explain("sign in"));
  }

  async logOut(): Promise<void> {
    await this.#connection.agent.request(methods.agent.logout, {}).catch(explain("sign out"));
  }

  /** Lets the agent free a session this client no longer uses. */
  async closeSession(sessionId: string): Promise<void> {
    this.#terminals.releaseSession(sessionId);
    this.#sessions.remove(sessionId);
    this.#inbox.take(sessionId);
    if (!this.offers.close) return;
    await this.#connection.agent
      .request(methods.agent.session.close, { sessionId })
      .catch(explain("close a session"));
  }

  #adopt(
    sessionId: string,
    opened: { configOptions?: SessionConfigOption[] | null; _meta?: unknown },
    placed: NewSessionRequest,
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
        cwd: placed.cwd,
        directories: placed.additionalDirectories ?? [],
        turns,
      },
      port,
      this.#hooks,
    );
    this.#sessions.put(session.id, session);
    for (const update of this.#inbox.take(session.id)) session.receive(update);
    return session;
  }

  close() {
    this.#terminals.releaseAll();
    this.#connection.close();
  }
}
