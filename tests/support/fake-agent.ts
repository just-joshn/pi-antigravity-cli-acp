/* oxlint-disable no-await-in-loop -- scripted steps run strictly in order */
import {
  agent,
  type AgentContext,
  type AvailableCommand,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeRequest,
  type LoadSessionRequest,
  methods,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption,
  type PlanEntry,
  RequestError,
  type RequestPermissionOutcome,
  type SessionConfigOption,
  type SessionUpdate,
  type StopReason,
  type Stream,
  type ToolCall,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk/unstable";

/** One scripted action of the fake agent during a prompt turn. */
export type Step =
  | { say: string }
  | { think: string }
  | { tool: ToolCall }
  | { update: ToolCallUpdate }
  | { ask: string; options?: PermissionOption[]; allowed?: Step[]; declined?: Step[] }
  | { usage: [used: number, size: number] }
  | { title: string }
  | { elicit: CreateElicitationRequest }
  | { plan: PlanEntry[] }
  | { read: string }
  | { write: [path: string, content: string] }
  | { hold: "cancel" | Promise<unknown> }
  | { fail: string }
  | { stop: StopReason };

export type Script = (prompt: ContentBlock[], turn: number) => Step[];

export interface FakeModel {
  id: string;
  name: string;
  efforts: string[];
}

export interface FakeAgentOptions {
  script: Script;
  models?: FakeModel[];
  modes?: string[];
  /** Config option id for the effort selector; the two Antigravity servers name it differently. */
  effortId?: string;
  /** Also list every model once per thinking level, as the Antigravity servers do. */
  variants?: boolean;
  image?: boolean;
  embeddedContext?: boolean;
  /** Report no quota tier, no settings and no context usage when a session starts. */
  plain?: boolean;
  /** Commands the agent lists for its sessions. */
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
  history?: Record<string, ContentBlock[][]>;
  /** Prefix for new session ids, so ids from different agent processes do not collide. */
  idPrefix?: string;
}

export interface AgentLog {
  initialize?: InitializeRequest;
  sessions: NewSessionRequest[];
  prompts: ContentBlock[][];
  config: [configId: string, value: string][];
  cancels: number;
  outcomes: RequestPermissionOutcome[];
  loads: string[];
  /** What the client answered to each question the agent asked. */
  answers: CreateElicitationResponse[];
  /** Auth method ids the client signed in with, and how often it logged out. */
  signIns: string[];
  logouts: number;
  /** The full session/load requests, in order. */
  loadRequests: LoadSessionRequest[];
  closes: string[];
}

export const allow: PermissionOption = { kind: "allow_once", optionId: "allow", name: "Allow" };
export const deny: PermissionOption = { kind: "reject_once", optionId: "deny", name: "Deny" };
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
    modes: options.modes ?? ["default", "auto"],
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

/** The session's settings after the client changes one of them. */
function configure(offer: Offer, current: SessionState, configId: string, value: string) {
  if (configId === offer.effortId) return { ...current, effort: value };
  if (configId !== "model") return { ...current, mode: value };
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

/** One prompt turn being played back. */
interface Playback {
  client: AgentContext;
  sessionId: string;
  log: AgentLog;
  cancelled: Promise<void>;
}

function send(pb: Playback, update: SessionUpdate) {
  return pb.client.notify(methods.client.session.update, { sessionId: pb.sessionId, update });
}

function say(pb: Playback, kind: "agent_message_chunk" | "agent_thought_chunk", text: string) {
  return send(pb, { sessionUpdate: kind, content: { type: "text", text } });
}

async function ask(pb: Playback, step: Extract<Step, { ask: string }>) {
  const { outcome } = await pb.client.request(methods.client.session.requestPermission, {
    sessionId: pb.sessionId,
    toolCall: { toolCallId: step.ask },
    options: step.options ?? [allow, deny],
  });
  pb.log.outcomes.push(outcome);
  if (outcome.outcome === "cancelled") return "cancelled";
  const granted = outcome.optionId.startsWith("allow");
  return play(pb, (granted ? step.allowed : step.declined) ?? []);
}

/** Performs one step; a stop reason ends the turn. */
async function perform(pb: Playback, step: Step): Promise<StopReason | undefined> {
  const { client, sessionId } = pb;
  if ("say" in step) await say(pb, "agent_message_chunk", step.say);
  else if ("think" in step) await say(pb, "agent_thought_chunk", step.think);
  else if ("tool" in step) await send(pb, { sessionUpdate: "tool_call", ...step.tool });
  else if ("update" in step) await send(pb, { sessionUpdate: "tool_call_update", ...step.update });
  else if ("plan" in step) await send(pb, { sessionUpdate: "plan", entries: step.plan });
  else if ("elicit" in step) {
    // A question with an empty session id is about the session being played.
    const question =
      "sessionId" in step.elicit && step.elicit.sessionId === ""
        ? { ...step.elicit, sessionId }
        : step.elicit;
    const reply = await client.request(methods.client.elicitation.create, question);
    pb.log.answers.push(reply);
    await say(pb, "agent_message_chunk", JSON.stringify(reply));
  } else if ("title" in step)
    await send(pb, { sessionUpdate: "session_info_update", title: step.title });
  else if ("usage" in step) {
    const [used, size] = step.usage;
    await send(pb, { sessionUpdate: "usage_update", used, size });
  } else if ("read" in step) {
    const file = await client.request(methods.client.fs.readTextFile, {
      sessionId,
      path: step.read,
    });
    await say(pb, "agent_message_chunk", file.content);
  } else if ("write" in step) {
    const [path, content] = step.write;
    await client.request(methods.client.fs.writeTextFile, { sessionId, path, content });
  } else if ("ask" in step) return ask(pb, step);
  else if ("hold" in step) {
    if (step.hold !== "cancel") await step.hold;
    else return pb.cancelled.then(() => "cancelled" as const);
  } else if ("fail" in step) throw new Error(step.fail);
  else return step.stop;
  return undefined;
}

async function play(pb: Playback, steps: Step[]): Promise<StopReason | undefined> {
  for (const step of steps) {
    const stop = await perform(pb, step);
    if (stop) return stop;
  }
  return undefined;
}

const TURN_USAGE = {
  totalTokens: 100,
  inputTokens: 60,
  outputTokens: 30,
  thoughtTokens: 10,
  cachedReadTokens: 10,
  cachedWriteTokens: 0,
};

async function openSession(
  offer: Offer,
  options: FakeAgentOptions,
  sessions: Map<string, SessionState>,
  sessionId: string,
  client: AgentContext,
) {
  const first = offer.models[0];
  const state = {
    model: first?.id ?? "",
    effort: first?.efforts.at(-1) ?? "",
    mode: offer.modes[0] ?? "",
  };
  sessions.set(sessionId, state);
  if (options.plain) return { sessionId };
  // The real servers report context usage before session/new returns.
  const usage = { sessionUpdate: "usage_update" as const, used: 0, size: 1_000_000 };
  await client.notify(methods.client.session.update, { sessionId, update: usage });
  const availableCommands = options.commands ?? defaultCommands;
  await client.notify(methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "available_commands_update", availableCommands },
  });
  const reply: NewSessionResponse & { models?: unknown } = {
    sessionId,
    configOptions: configOptions(offer, state),
    _meta: { antigravity: { tier: { name: "Test Tier", id: "test" } } },
  };
  if (options.variants !== false) reply.models = variants(offer);
  return reply;
}

const textOf = (blocks: ContentBlock[]) =>
  blocks.map((block) => (block.type === "text" ? block.text : "")).join("");

/** Replays a saved conversation the way `agy` does on session/load: each prompt, then a reply. */
async function replay(client: AgentContext, sessionId: string, prompts: ContentBlock[][]) {
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
  const embeddedContext = options.embeddedContext ?? true;
  const restore = options.restore ?? true;
  return {
    protocolVersion: 1,
    agentInfo: { name: "fake-agent", title: "Fake Agent", version: "0.0.1" },
    agentCapabilities: {
      promptCapabilities: { image, embeddedContext },
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

/** The fake agent's state across requests. */
interface Agent {
  offer: Offer;
  options: FakeAgentOptions;
  log: AgentLog;
  history: Record<string, ContentBlock[][]>;
  sessions: Map<string, SessionState>;
  cancel: (() => void) | undefined;
  prompts: number;
  signedIn: boolean;
}

async function load(state: Agent, request: LoadSessionRequest, client: AgentContext) {
  const { sessionId } = request;
  state.log.loads.push(sessionId);
  state.log.loadRequests.push(request);
  const prompts = state.history[sessionId];
  if (!prompts) throw RequestError.resourceNotFound(sessionId);
  await replay(client, sessionId, prompts);
  return openSession(state.offer, state.options, state.sessions, sessionId, client);
}

function setOption(state: Agent, sessionId: string, configId: string, value: unknown) {
  const current = state.sessions.get(sessionId);
  if (!current || typeof value !== "string") throw new Error("bad config request");
  state.log.config.push([configId, value]);
  const next = configure(state.offer, current, configId, value);
  state.sessions.set(sessionId, next);
  return { configOptions: configOptions(state.offer, next) };
}

async function answer(
  state: Agent,
  sessionId: string,
  blocks: ContentBlock[],
  client: AgentContext,
) {
  state.log.prompts.push(blocks);
  state.history[sessionId]?.push(blocks);
  const cancelled = new Promise<void>((resolve) => {
    state.cancel = resolve;
  });
  const pb = { client, sessionId, log: state.log, cancelled };
  const steps = state.options.script(blocks, state.prompts++);
  return { stopReason: (await play(pb, steps)) ?? "end_turn", usage: TURN_USAGE };
}

/** Every saved conversation, titled by its first prompt. */
function list(state: Agent, cwd: string) {
  const sessions = Object.entries(state.history).map(([sessionId, prompts]) => ({
    sessionId,
    cwd,
    title: textOf(prompts[0] ?? []) || null,
    updatedAt: "2026-11-25T10:00:00Z",
  }));
  const ghosts = (state.options.ghosts ?? []).map((sessionId) => ({
    sessionId,
    cwd,
    title: sessionId,
  }));
  return { sessions: [...sessions, ...ghosts] };
}

function signInAs(state: Agent, methodId: string | undefined) {
  if (methodId === undefined) state.log.logouts += 1;
  else state.log.signIns.push(methodId);
  state.signedIn = methodId !== undefined;
  return {};
}

/** Serves a scripted ACP agent on `stream` and records what the client sent. */
export function serveAgent(stream: Stream, options: FakeAgentOptions) {
  const log = emptyLog();
  const state: Agent = {
    offer: offerOf(options),
    options,
    log,
    history: options.history ?? {},
    sessions: new Map(),
    cancel: undefined,
    prompts: 0,
    signedIn: options.signedOut !== true,
  };
  const connection = agent({ name: "fake-agent" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      log.initialize = params;
      return hello(options);
    })
    .onRequest(methods.agent.authenticate, ({ params }) => signInAs(state, params.methodId))
    .onRequest(methods.agent.logout, () => signInAs(state, undefined))
    .onRequest(methods.agent.session.new, ({ params, client }) => {
      if (!state.signedIn) throw RequestError.authRequired();
      log.sessions.push(params);
      const sessionId = `${options.idPrefix ?? ""}s${log.sessions.length}`;
      state.history[sessionId] = [];
      return openSession(state.offer, options, state.sessions, sessionId, client);
    })
    .onRequest(methods.agent.session.load, ({ params, client }) => load(state, params, client))
    .onRequest(methods.agent.session.list, ({ params }) => list(state, params.cwd ?? "/"))
    .onRequest(methods.agent.session.close, ({ params }) => {
      log.closes.push(params.sessionId);
      state.sessions.delete(params.sessionId);
      return {};
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) =>
      setOption(state, params.sessionId, params.configId, params.value),
    )
    .onNotification(methods.agent.session.cancel, () => {
      log.cancels += 1;
      state.cancel?.();
    })
    .onRequest(methods.agent.session.prompt, ({ params, client }) =>
      answer(state, params.sessionId, params.prompt, client),
    )
    .connect(stream);

  return { log, close: () => connection.close() };
}
