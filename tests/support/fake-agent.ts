/* oxlint-disable no-await-in-loop -- scripted steps run strictly in order */
import {
  agent,
  type AgentContext,
  type AvailableCommand,
  type ContentBlock,
  type CreateElicitationResponse,
  type InitializeRequest,
  type LoadSessionRequest,
  methods,
  type NewSessionRequest,
  type NewSessionResponse,
  RequestError,
  type RequestPermissionOutcome,
  type SessionConfigOption,
  type Stream,
} from "@agentclientprotocol/sdk/unstable";

import { play, type Step } from "./playback.ts";

type Script = (prompt: ContentBlock[], turn: number) => Step[];

interface FakeModel {
  id: string;
  name: string;
  efforts: string[];
}

export interface FakeAgentOptions {
  script: Script;
  models?: FakeModel[];
  /** Config option id for the effort selector; the two Antigravity servers name it differently. */
  effortId?: string;
  /** Set false to leave out the per-level model list. */
  variants?: boolean;
  image?: boolean;
  /** Report no quota tier, no settings and no context usage when a session starts. */
  plain?: boolean;
  commands?: AvailableCommand[];
  /** Extra sessions session/list reports that the agent cannot load. */
  ghosts?: string[];
  /** Start signed out: session/new and session/load need authenticate first. */
  signedOut?: boolean;
  /** Accept additional workspace directories, as `agy` does. */
  directories?: boolean;
  /** Accept MCP servers over HTTP; `agy` 1.5.17 does not. */
  mcpHttp?: boolean;
  /** Offer session/load and session/close, as `agy` does. */
  restore?: boolean;
  /** Saved conversations by session id, each a list of prompts; kept across agent processes. */
  history?: Readonly<Record<string, readonly ContentBlock[][]>>;
  /** Prefix for new session ids, so ids from different agent processes do not collide. */
  idPrefix?: string;
}

export interface AgentLog {
  readonly initialize?: InitializeRequest | undefined;
  readonly sessions: readonly NewSessionRequest[];
  readonly prompts: readonly ContentBlock[][];
  readonly config: readonly [configId: string, value: string][];
  readonly cancels: number;
  readonly outcomes: readonly RequestPermissionOutcome[];
  readonly loads: readonly string[];
  /** What the client answered to each question the agent asked. */
  readonly answers: readonly CreateElicitationResponse[];
  /** Auth method ids the client signed in with, and how often it logged out. */
  readonly signIns: readonly string[];
  readonly logouts: number;
  /** The full session/load requests, in order. */
  readonly loadRequests: readonly LoadSessionRequest[];
  readonly closes: readonly string[];
}

export const defaultCommands: AvailableCommand[] = [
  { name: "goal", description: "Run until the goal is done.", input: { hint: "the goal" } },
  { name: "compact", description: "Compact the conversation now." },
];
export const defaultModels: FakeModel[] = [
  { id: "gemini-a", name: "Gemini A", efforts: ["low", "medium", "high"] },
  { id: "gemini-b", name: "Gemini B", efforts: ["low", "high", "xhigh"] },
];

interface SessionState {
  model: string;
  effort: string;
  mode: string;
}

/** The fake agent's settings, with the defaults filled in. */
interface Offer {
  models: FakeModel[];
  modes: string[];
  effortId: string;
  names: Map<string, string>;
}

function offerOf(options: FakeAgentOptions): Offer {
  const models = options.models ?? defaultModels;
  return {
    models,
    modes: ["default", "auto"],
    effortId: options.effortId ?? "thought_level",
    names: new Map(models.map((m) => [m.id, m.name])),
  };
}

function configOptions(offer: Offer, current: SessionState): SessionConfigOption[] {
  const efforts = offer.models.find((m) => m.id === current.model)?.efforts ?? [];
  const select = (id: string, category: string, value: string, values: string[]) => ({
    id,
    name: id,
    category,
    type: "select" as const,
    currentValue: value,
    options: values.map((v) => ({ value: v, name: offer.names.get(v) ?? v })),
  });
  const modelIds = offer.models.map((m) => m.id);
  return [
    select("model", "model", current.model, modelIds),
    ...(efforts.length ? [select(offer.effortId, "thought_level", current.effort, efforts)] : []),
    select("mode", "mode", current.mode, offer.modes),
  ];
}

function configure(offer: Offer, current: SessionState, configId: string, value: string) {
  if (configId === offer.effortId) return { ...current, effort: value };
  if (configId === "mode") return { ...current, mode: value };
  if (configId !== "model") throw RequestError.invalidParams(undefined, `no option ${configId}`);
  const efforts = offer.models.find((m) => m.id === value)?.efforts ?? [];
  const effort = efforts.includes(current.effort) ? current.effort : (efforts.at(-1) ?? "");
  return { ...current, model: value, effort };
}

/** Both Antigravity servers also list every model once per thinking level. */
function variants(offer: Offer) {
  const first = offer.models[0];
  return {
    currentModelId: `${first?.id}-${first?.efforts.at(-1)}`,
    availableModels: offer.models.flatMap((m) =>
      m.efforts.length
        ? m.efforts.map((effort) => ({ modelId: `${m.id}-${effort}`, name: m.name }))
        : [{ modelId: m.id, name: m.name }],
    ),
  };
}

const TURN_USAGE = {
  totalTokens: 100,
  inputTokens: 60,
  outputTokens: 30,
  thoughtTokens: 10,
  cachedReadTokens: 10,
  cachedWriteTokens: 0,
};

const textOf = (blocks: ContentBlock[]) =>
  blocks.map((block) => (block.type === "text" ? block.text : "")).join("");

/** Replays a saved conversation the way `agy` does on session/load: each prompt, then a reply. */
async function replay(client: AgentContext, sessionId: string, prompts: readonly ContentBlock[][]) {
  for (const prompt of prompts) {
    for (const content of prompt)
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "user_message_chunk", content },
      });
    await client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "(earlier)" },
      },
    });
  }
}

function hello(options: FakeAgentOptions) {
  const image = options.image ?? true;
  const restore = options.restore ?? true;
  return {
    protocolVersion: 1,
    agentInfo: { name: "fake-agent", title: "Fake Agent", version: "0.0.1" },
    agentCapabilities: {
      promptCapabilities: { image, embeddedContext: true },
      ...(restore ? { loadSession: true } : {}),
      sessionCapabilities: {
        ...(restore ? { close: {}, list: {} } : {}),
        ...(options.directories === false ? {} : { additionalDirectories: {} }),
      },
      ...(options.mcpHttp ? { mcpCapabilities: { http: true } } : {}),
      auth: { logout: {} },
    },
    authMethods: [
      { id: "oauth-personal", name: "Log in with Google", description: "Your Google account" },
      { id: "gemini-api-key", name: "Gemini API key" },
    ],
  };
}

const emptyLog = (): AgentLog => ({
  sessions: [],
  prompts: [],
  config: [],
  cancels: 0,
  outcomes: [],
  loads: [],
  answers: [],
  signIns: [],
  logouts: 0,
  loadRequests: [],
  closes: [],
});

/** A live view of the log: each field reads the agent's latest record. */
function logView(read: () => AgentLog): AgentLog {
  return {
    get initialize() {
      return read().initialize;
    },
    get sessions() {
      return read().sessions;
    },
    get prompts() {
      return read().prompts;
    },
    get config() {
      return read().config;
    },
    get cancels() {
      return read().cancels;
    },
    get outcomes() {
      return read().outcomes;
    },
    get loads() {
      return read().loads;
    },
    get answers() {
      return read().answers;
    },
    get signIns() {
      return read().signIns;
    },
    get logouts() {
      return read().logouts;
    },
    get loadRequests() {
      return read().loadRequests;
    },
    get closes() {
      return read().closes;
    },
  };
}

type Saved = Readonly<Record<string, readonly ContentBlock[][]>>;

/** The scripted agent's state across requests; every change replaces a value. */
class FakeAgent {
  readonly log = logView(() => this.#log);
  #log = emptyLog();
  #offer: Offer;
  #options: FakeAgentOptions;
  #history: Saved;
  #sessions: ReadonlyMap<string, SessionState> = new Map();
  #cancel: (() => void) | undefined;
  #prompts = 0;
  #signedIn: boolean;

  constructor(options: FakeAgentOptions) {
    this.#options = options;
    this.#offer = offerOf(options);
    this.#history = options.history ?? {};
    this.#signedIn = options.signedOut !== true;
  }

  /** Saved conversations, including this process's. */
  get history(): Saved {
    return this.#history;
  }

  #note(patch: Partial<AgentLog>) {
    this.#log = { ...this.#log, ...patch };
  }

  initialize(params: InitializeRequest) {
    this.#note({ initialize: params });
    return hello(this.#options);
  }

  signInAs(methodId: string | undefined) {
    if (methodId === undefined) this.#note({ logouts: this.#log.logouts + 1 });
    else this.#note({ signIns: [...this.#log.signIns, methodId] });
    this.#signedIn = methodId !== undefined;
    return {};
  }

  newSession(params: NewSessionRequest, client: AgentContext) {
    if (!this.#signedIn) throw RequestError.authRequired();
    this.#note({ sessions: [...this.#log.sessions, params] });
    const sessionId = `${this.#options.idPrefix ?? ""}s${this.#log.sessions.length}`;
    this.#history = { ...this.#history, [sessionId]: [] };
    return this.#open(sessionId, client);
  }

  async load(request: LoadSessionRequest, client: AgentContext) {
    if (!this.#signedIn) throw RequestError.authRequired();
    const { sessionId } = request;
    const { loads, loadRequests } = this.#log;
    this.#note({ loads: [...loads, sessionId], loadRequests: [...loadRequests, request] });
    const prompts = this.#history[sessionId];
    if (!prompts) throw RequestError.resourceNotFound(sessionId);
    await replay(client, sessionId, prompts);
    return this.#open(sessionId, client);
  }

  close(sessionId: string) {
    this.#note({ closes: [...this.#log.closes, sessionId] });
    this.#sessions = new Map([...this.#sessions].filter(([id]) => id !== sessionId));
    return {};
  }

  cancel() {
    this.#note({ cancels: this.#log.cancels + 1 });
    this.#cancel?.();
  }

  setOption(sessionId: string, configId: string, value: unknown) {
    const current = this.#sessions.get(sessionId);
    if (!current || typeof value !== "string") throw new Error("bad config request");
    this.#note({ config: [...this.#log.config, [configId, value]] });
    const next = configure(this.#offer, current, configId, value);
    this.#sessions = new Map([...this.#sessions, [sessionId, next]]);
    return { configOptions: configOptions(this.#offer, next) };
  }

  async answer(sessionId: string, blocks: ContentBlock[], client: AgentContext) {
    this.#note({ prompts: [...this.#log.prompts, blocks] });
    const saved = this.#history[sessionId];
    if (saved) this.#history = { ...this.#history, [sessionId]: [...saved, blocks] };
    const cancelled = new Promise<void>((resolve) => {
      this.#cancel = resolve;
    });
    const answered = (outcome: RequestPermissionOutcome) =>
      this.#note({ outcomes: [...this.#log.outcomes, outcome] });
    const replied = (reply: CreateElicitationResponse) =>
      this.#note({ answers: [...this.#log.answers, reply] });
    const pb = { client, sessionId, cancelled, answered, replied };
    const steps = this.#options.script(blocks, this.#prompts);
    this.#prompts += 1;
    return { stopReason: (await play(pb, steps)) ?? "end_turn", usage: TURN_USAGE };
  }

  /** Every saved conversation, titled by its first prompt. */
  list(cwd: string) {
    const sessions = Object.entries(this.#history).map(([sessionId, prompts]) => ({
      sessionId,
      cwd,
      title: textOf(prompts[0] ?? []) || null,
      updatedAt: "2026-11-25T10:00:00Z",
    }));
    const ghosts = (this.#options.ghosts ?? []).map((sessionId) => ({
      sessionId,
      cwd,
      title: sessionId,
    }));
    return { sessions: [...sessions, ...ghosts] };
  }

  async #open(
    sessionId: string,
    client: AgentContext,
  ): Promise<NewSessionResponse & { models?: ReturnType<typeof variants> }> {
    const first = this.#offer.models[0];
    const state = {
      model: first?.id ?? "",
      effort: first?.efforts.at(-1) ?? "",
      mode: this.#offer.modes[0] ?? "",
    };
    this.#sessions = new Map([...this.#sessions, [sessionId, state]]);
    if (this.#options.plain) return { sessionId };
    await announce(client, sessionId, this.#options);
    return {
      sessionId,
      configOptions: configOptions(this.#offer, state),
      _meta: { antigravity: { tier: { name: "Test Tier", id: "test" } } },
      ...(this.#options.variants === false ? {} : { models: variants(this.#offer) }),
    };
  }
}

/** What the real servers send before session/new returns: context usage and their commands. */
async function announce(client: AgentContext, sessionId: string, options: FakeAgentOptions) {
  const usage = { sessionUpdate: "usage_update" as const, used: 0, size: 1_000_000 };
  await client.notify(methods.client.session.update, { sessionId, update: usage });
  const availableCommands = options.commands ?? defaultCommands;
  await client.notify(methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "available_commands_update", availableCommands },
  });
}

/** Serves a scripted ACP agent on `stream` and records what the client sent. */
export function serveAgent(stream: Stream, options: FakeAgentOptions) {
  const fake = new FakeAgent(options);
  const connection = agent({ name: "fake-agent" })
    .onRequest(methods.agent.initialize, ({ params }) => fake.initialize(params))
    .onRequest(methods.agent.authenticate, ({ params }) => fake.signInAs(params.methodId))
    .onRequest(methods.agent.logout, () => fake.signInAs(undefined))
    .onRequest(methods.agent.session.new, ({ params, client }) => fake.newSession(params, client))
    .onRequest(methods.agent.session.load, ({ params, client }) => fake.load(params, client))
    .onRequest(methods.agent.session.list, ({ params }) => fake.list(params.cwd ?? "/"))
    .onRequest(methods.agent.session.close, ({ params }) => fake.close(params.sessionId))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) =>
      fake.setOption(params.sessionId, params.configId, params.value),
    )
    .onNotification(methods.agent.session.cancel, () => fake.cancel())
    .onRequest(methods.agent.session.prompt, ({ params, client }) =>
      fake.answer(params.sessionId, params.prompt, client),
    )
    .connect(stream);
  return { log: fake.log, history: () => fake.history, close: () => connection.close() };
}
