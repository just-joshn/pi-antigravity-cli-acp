/* oxlint-disable no-await-in-loop -- scripted steps run strictly in order */
import {
  agent,
  type ContentBlock,
  type InitializeRequest,
  methods,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption,
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
}

export interface AgentLog {
  initialize?: InitializeRequest;
  sessions: NewSessionRequest[];
  prompts: ContentBlock[][];
  config: [configId: string, value: string][];
  cancels: number;
  outcomes: RequestPermissionOutcome[];
}

export const allow: PermissionOption = { kind: "allow_once", optionId: "allow", name: "Allow" };
export const deny: PermissionOption = { kind: "reject_once", optionId: "deny", name: "Deny" };
export const defaultModels: FakeModel[] = [
  { id: "gemini-a", name: "Gemini A", efforts: ["low", "medium", "high"] },
  { id: "gemini-b", name: "Gemini B", efforts: ["low", "high", "xhigh"] },
];

/** Serves a scripted ACP agent on `stream` and records what the client sent. */
export function serveAgent(stream: Stream, options: FakeAgentOptions) {
  const models = options.models ?? defaultModels;
  const modes = options.modes ?? ["default", "auto"];
  const effortId = options.effortId ?? "thought_level";
  const log: AgentLog = { sessions: [], prompts: [], config: [], cancels: 0, outcomes: [] };
  const state = new Map<string, { model: string; effort: string; mode: string }>();
  let cancelled: (() => void) | undefined;
  let count = 0;

  const configOptions = (sessionId: string): SessionConfigOption[] => {
    const current = state.get(sessionId);
    if (!current) throw new Error(`unknown session ${sessionId}`);
    const efforts = models.find((m) => m.id === current.model)?.efforts ?? [];
    const select = (id: string, category: string, value: string, values: string[]) => ({
      id,
      name: id,
      category,
      type: "select" as const,
      currentValue: value,
      options: values.map((v) => ({ value: v, name: models.find((m) => m.id === v)?.name ?? v })),
    });
    return [
      select(
        "model",
        "model",
        current.model,
        models.map((m) => m.id),
      ),
      ...(efforts.length ? [select(effortId, "thought_level", current.effort, efforts)] : []),
      select("mode", "mode", current.mode, modes),
    ];
  };

  const connection = agent({ name: "fake-agent" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      log.initialize = params;
      return {
        protocolVersion: 1,
        agentInfo: { name: "fake-agent", title: "Fake Agent", version: "0.0.1" },
        agentCapabilities: {
          promptCapabilities: {
            image: options.image ?? true,
            embeddedContext: options.embeddedContext ?? true,
          },
        },
        authMethods: [],
      };
    })
    .onRequest(methods.agent.session.new, async ({ params, client }) => {
      log.sessions.push(params);
      const sessionId = `s${log.sessions.length}`;
      const first = models[0];
      state.set(sessionId, {
        model: first?.id ?? "",
        effort: first?.efforts.at(-1) ?? "",
        mode: modes[0] ?? "",
      });
      if (options.plain) return { sessionId };
      // The real servers report context usage before session/new returns.
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "usage_update", used: 0, size: 1_000_000 },
      });
      const reply: NewSessionResponse & { models?: unknown } = {
        sessionId,
        configOptions: configOptions(sessionId),
        _meta: { antigravity: { tier: { name: "Test Tier", id: "test" } } },
      };
      if (options.variants !== false)
        reply.models = {
          currentModelId: `${first?.id}-${first?.efforts.at(-1)}`,
          availableModels: models.flatMap((m) =>
            m.efforts.length
              ? m.efforts.map((effort) => ({ modelId: `${m.id}-${effort}`, name: m.name }))
              : [{ modelId: m.id, name: m.name }],
          ),
        };
      return reply;
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      const current = state.get(params.sessionId);
      if (!current || typeof params.value !== "string") throw new Error("bad config request");
      log.config.push([params.configId, params.value]);
      if (params.configId === "model") {
        current.model = params.value;
        const efforts = models.find((m) => m.id === params.value)?.efforts ?? [];
        if (!efforts.includes(current.effort)) current.effort = efforts.at(-1) ?? "";
      } else if (params.configId === effortId) current.effort = params.value;
      else current.mode = params.value;
      return { configOptions: configOptions(params.sessionId) };
    })
    .onNotification(methods.agent.session.cancel, () => {
      log.cancels += 1;
      cancelled?.();
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      const { sessionId } = params;
      log.prompts.push(params.prompt);
      const waitForCancel = new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      const send = (update: SessionUpdate) =>
        client.notify(methods.client.session.update, { sessionId, update });
      const text = (kind: "agent_message_chunk" | "agent_thought_chunk", value: string) =>
        send({ sessionUpdate: kind, content: { type: "text", text: value } });

      const play = async (steps: Step[]): Promise<StopReason | undefined> => {
        for (const step of steps) {
          if ("say" in step) await text("agent_message_chunk", step.say);
          else if ("think" in step) await text("agent_thought_chunk", step.think);
          else if ("tool" in step) await send({ sessionUpdate: "tool_call", ...step.tool });
          else if ("update" in step)
            await send({ sessionUpdate: "tool_call_update", ...step.update });
          else if ("title" in step)
            await send({ sessionUpdate: "session_info_update", title: step.title });
          else if ("usage" in step)
            await send({ sessionUpdate: "usage_update", used: step.usage[0], size: step.usage[1] });
          else if ("read" in step) {
            const file = await client.request(methods.client.fs.readTextFile, {
              sessionId,
              path: step.read,
            });
            await text("agent_message_chunk", file.content);
          } else if ("write" in step) {
            const [path, content] = step.write;
            await client.request(methods.client.fs.writeTextFile, { sessionId, path, content });
          } else if ("ask" in step) {
            const { outcome } = await client.request(methods.client.session.requestPermission, {
              sessionId,
              toolCall: { toolCallId: step.ask },
              options: step.options ?? [allow, deny],
            });
            log.outcomes.push(outcome);
            if (outcome.outcome === "cancelled") return "cancelled";
            const granted = outcome.optionId.startsWith("allow");
            const stop = await play((granted ? step.allowed : step.declined) ?? []);
            if (stop) return stop;
          } else if ("hold" in step) {
            if (step.hold !== "cancel") await step.hold;
            else {
              await waitForCancel;
              return "cancelled";
            }
          } else if ("fail" in step) throw new Error(step.fail);
          else return step.stop;
        }
        return undefined;
      };

      const stopReason = (await play(options.script(params.prompt, count++))) ?? "end_turn";
      return {
        stopReason,
        usage: {
          totalTokens: 100,
          inputTokens: 60,
          outputTokens: 30,
          thoughtTokens: 10,
          cachedReadTokens: 10,
          cachedWriteTokens: 0,
        },
      };
    })
    .connect(stream);

  return { log, close: () => connection.close() };
}
