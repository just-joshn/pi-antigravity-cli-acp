/* oxlint-disable no-await-in-loop -- scripted steps run strictly in order */
import {
  agent,
  type AgentContext,
  type ContentBlock,
  type InitializeRequest,
  methods,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption,
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
  closes: string[];
}

export const allow: PermissionOption = { kind: "allow_once", optionId: "allow", name: "Allow" };
export const deny: PermissionOption = { kind: "reject_once", optionId: "deny", name: "Deny" };
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
  else if ("title" in step)
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
  const reply: NewSessionResponse & { models?: unknown } = {
    sessionId,
    configOptions: configOptions(offer, state),
    _meta: { antigravity: { tier: { name: "Test Tier", id: "test" } } },
  };
  if (options.variants !== false) reply.models = variants(offer);
  return reply;
}

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

/** Serves a scripted ACP agent on `stream` and records what the client sent. */
export function serveAgent(stream: Stream, options: FakeAgentOptions) {
  const offer = offerOf(options);
  const log: AgentLog = {
    sessions: [],
    prompts: [],
    config: [],
    cancels: 0,
    outcomes: [],
    loads: [],
    closes: [],
  };
  const history = options.history ?? {};
  const restore = options.restore ?? true;
  const sessions = new Map<string, SessionState>();
  let cancel: (() => void) | undefined;
  let count = 0;

  const connection = agent({ name: "fake-agent" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      log.initialize = params;
      const image = options.image ?? true;
      const embeddedContext = options.embeddedContext ?? true;
      return {
        protocolVersion: 1,
        agentInfo: { name: "fake-agent", title: "Fake Agent", version: "0.0.1" },
        agentCapabilities: {
          promptCapabilities: { image, embeddedContext },
          ...(restore ? { loadSession: true, sessionCapabilities: { close: {} } } : {}),
        },
        authMethods: [],
      };
    })
    .onRequest(methods.agent.session.new, ({ params, client }) => {
      log.sessions.push(params);
      const sessionId = `${options.idPrefix ?? ""}s${log.sessions.length}`;
      history[sessionId] = [];
      return openSession(offer, options, sessions, sessionId, client);
    })
    .onRequest(methods.agent.session.load, async ({ params, client }) => {
      log.loads.push(params.sessionId);
      const prompts = history[params.sessionId];
      if (!prompts) throw RequestError.resourceNotFound(params.sessionId);
      await replay(client, params.sessionId, prompts);
      return openSession(offer, options, sessions, params.sessionId, client);
    })
    .onRequest(methods.agent.session.close, ({ params }) => {
      log.closes.push(params.sessionId);
      sessions.delete(params.sessionId);
      return {};
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      const current = sessions.get(params.sessionId);
      if (!current || typeof params.value !== "string") throw new Error("bad config request");
      log.config.push([params.configId, params.value]);
      const next = configure(offer, current, params.configId, params.value);
      sessions.set(params.sessionId, next);
      return { configOptions: configOptions(offer, next) };
    })
    .onNotification(methods.agent.session.cancel, () => {
      log.cancels += 1;
      cancel?.();
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      log.prompts.push(params.prompt);
      history[params.sessionId]?.push(params.prompt);
      const cancelled = new Promise<void>((resolve) => {
        cancel = resolve;
      });
      const pb = { client, sessionId: params.sessionId, log, cancelled };
      const stopReason = (await play(pb, options.script(params.prompt, count++))) ?? "end_turn";
      return { stopReason, usage: TURN_USAGE };
    })
    .connect(stream);

  return { log, close: () => connection.close() };
}
