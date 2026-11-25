import type { ContentBlock } from "@agentclientprotocol/sdk/unstable";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  getCurrentTools,
  type Message,
  type Model,
  type StopReason,
  type StreamOptions,
  type TranscriptContext,
  type UserMessage,
} from "@earendil-works/pi-ai";

import { AGENT_DEFAULT, effortFor, PROVIDER } from "./catalog.ts";
import { AcpError } from "./client.ts";
import type { AcpSession, ToolView, Turn, TurnEvent } from "./session.ts";
import { TOOL_NAME, toolArguments } from "./tool.ts";

/** Longest wait for the agent to confirm that a cancelled turn has ended. */
const CANCEL_GRACE_MS = 5000;
/** Tool calls the agent starts together arrive as separate updates; wait this long to group them. */
const TOOL_BATCH_MS = 25;
const HISTORY_LIMIT = 24_000;

/** One agent session as this Pi session sees it. */
export interface Conversation {
  session: AcpSession;
  accepts: { image: boolean; embeddedContext: boolean };
  /** `responseId` of the last assistant message built from this session. */
  anchor: string | undefined;
  /** Assistant messages built from the turn in progress. */
  segment: number;
  /** Mirrored Pi tool call id to the agent's tool call id. */
  toolIds: Map<string, string>;
}

export interface StreamHost {
  /** Whether Pi is running a turn of the session this extension serves. */
  conversing(piSessionId: string | undefined): boolean;
  open(signal: AbortSignal | undefined): Promise<Conversation>;
  /** Replaces the agent session with a new one. */
  restart(signal: AbortSignal | undefined): Promise<Conversation>;
  /** Gives up on an agent that would not stop, so it cannot keep working unseen. */
  abandon(): void;
  /** How long to wait for the agent to confirm a cancelled turn. */
  cancelGraceMs?: number;
  /** Reports tool activity when Pi cannot show it as a tool call. */
  noteTool(tool: ToolView): void;
}

export function newConversation(
  session: AcpSession,
  accepts: Conversation["accepts"],
): Conversation {
  return { session, accepts, anchor: undefined, segment: 0, toolIds: new Map() };
}

export function watchMirror(
  conversation: Conversation,
  piToolId: string,
  signal: AbortSignal | undefined,
  onChange: (tool: ToolView) => void,
): Promise<ToolView | undefined> {
  const id = conversation.toolIds.get(piToolId);
  return id === undefined
    ? Promise.resolve(undefined)
    : conversation.session.watchTool(id, signal, onChange);
}

export interface TurnPlan {
  /** The transcript no longer continues what the agent session has seen. */
  diverged: boolean;
  /** Conversation the agent session has not seen, oldest first. */
  missed: Message[];
  /** User messages to send now. */
  prompt: UserMessage[];
}

/**
 * Compares Pi's transcript with what the agent session has seen. The last assistant message this
 * provider wrote carries the session's position as its `responseId`; everything after it is new.
 */
export function planTurn(messages: Message[], anchor: string | undefined): TurnPlan {
  let ours = messages.length - 1;
  let seen: string | undefined;
  for (; ours >= 0; ours--) {
    const message = messages[ours];
    if (message?.role === "assistant" && message.provider === PROVIDER && message.responseId) {
      seen = message.responseId;
      break;
    }
  }
  const diverged = seen !== anchor;
  let cut = messages.length;
  while (cut > 0 && messages[cut - 1]?.role === "user") cut--;
  const prompt = messages.slice(cut).filter((m) => m.role === "user");
  const last = diverged ? undefined : messages[ours];
  const answered = new Set(
    last?.role === "assistant"
      ? last.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
      : [],
  );
  const missed = messages
    .slice(diverged ? 0 : ours + 1, cut)
    .filter((m) => m.role !== "system" && !(m.role === "toolResult" && answered.has(m.toolCallId)));
  return { diverged, missed, prompt };
}

function plainText(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : "[image]"))
    .join("\n");
}

/** Renders earlier conversation as text for an agent session that was not part of it. */
export function renderHistory(messages: Message[]): string {
  const lines = messages.flatMap((message) => {
    if (message.role === "user") return [`User: ${plainText(message.content)}`];
    if (message.role === "toolResult")
      return [`Tool result (${message.toolName}): ${plainText(message.content).slice(0, 600)}`];
    if (message.role !== "assistant") return [];
    const said = message.content
      .flatMap((block) => {
        if (block.type === "text") return [block.text];
        if (block.type === "toolCall")
          return [`[tool ${block.name}: ${JSON.stringify(block.arguments)}]`];
        return [];
      })
      .join("\n");
    return said ? [`Assistant: ${said}`] : [];
  });
  if (lines.length === 0) return "";
  const text = lines.join("\n\n");
  const kept =
    text.length > HISTORY_LIMIT
      ? `[earlier conversation omitted]\n${text.slice(-HISTORY_LIMIT)}`
      : text;
  return `Conversation so far, supplied by the client as context:\n\n${kept}`;
}

function promptBlocks(plan: TurnPlan, accepts: Conversation["accepts"]): ContentBlock[] {
  const history = renderHistory(plan.missed);
  const blocks: ContentBlock[] = [];
  if (history && accepts.embeddedContext) {
    blocks.push({
      type: "resource",
      resource: { uri: "context://conversation-so-far", mimeType: "text/markdown", text: history },
    });
  } else if (history) blocks.push({ type: "text", text: history });
  for (const message of plan.prompt) {
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    for (const block of content) {
      if (block.type === "text") blocks.push({ type: "text", text: block.text });
      else if (accepts.image)
        blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
      else throw new AcpError("This Antigravity agent does not accept images.");
    }
  }
  return blocks;
}

async function applyChoices(session: AcpSession, model: Model<string>, level: string | undefined) {
  if (model.id !== AGENT_DEFAULT && (await session.select("model", model.id)) === "unavailable")
    throw new AcpError(
      `Antigravity does not offer ${model.id} right now. Choose another model with /model.`,
    );
  const effort = effortFor(model, level);
  if (effort === undefined) return undefined;
  return (await session.select("thought_level", effort)) === "unavailable" ? undefined : effort;
}

const halting = new WeakMap<Turn, Promise<boolean>>();

/**
 * Stops the turn in progress. Resolves false when the agent did not confirm within `graceMs`:
 * the session is then still busy and must not be prompted again.
 */
export function haltTurn(session: AcpSession, graceMs = CANCEL_GRACE_MS): Promise<boolean> {
  const { turn } = session;
  if (!turn) return Promise.resolve(true);
  const running = halting.get(turn);
  if (running) return running;
  const stop = (async () => {
    const ended = (async () => {
      await session.cancelTurn();
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- drains events in order until the turn ends
        const event = await turn.next();
        if (event.type === "end" || event.type === "failed") return true;
      }
    })().catch(() => false);
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<false>((resolve) => {
      timer = setTimeout(resolve, graceMs, false);
    });
    const confirmed = await Promise.race([ended, grace]);
    clearTimeout(timer);
    session.endTurn(turn);
    return confirmed;
  })();
  halting.set(turn, stop);
  return stop;
}

const STOP: Record<Extract<TurnEvent, { type: "end" }>["stopReason"], StopReason> = {
  end_turn: "stop",
  max_turn_requests: "stop",
  max_tokens: "length",
  refusal: "error",
  cancelled: "aborted",
};

class Aborted extends Error {}

/** Writes one Pi assistant message as the agent's events arrive. */
class Draft {
  readonly message: AssistantMessage;
  readonly events = createAssistantMessageEventStream();
  #open: "text" | "thinking" | undefined;

  constructor(model: Model<string>) {
    this.message = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      content: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
    };
  }

  append(kind: "text" | "thinking", delta: string) {
    if (this.#open !== kind) {
      this.close();
      this.#open = kind;
      this.message.content.push(
        kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
      );
      this.events.push({ type: `${kind}_start`, contentIndex: this.#index, partial: this.message });
    }
    const block = this.message.content[this.#index];
    if (block?.type === "text") block.text += delta;
    else if (block?.type === "thinking") block.thinking += delta;
    this.events.push({
      type: `${kind}_delta`,
      contentIndex: this.#index,
      delta,
      partial: this.message,
    });
  }

  close() {
    const block = this.message.content[this.#index];
    const partial = this.message;
    if (this.#open === "text" && block?.type === "text")
      this.events.push({
        type: "text_end",
        contentIndex: this.#index,
        content: block.text,
        partial,
      });
    else if (this.#open === "thinking" && block?.type === "thinking")
      this.events.push({
        type: "thinking_end",
        contentIndex: this.#index,
        content: block.thinking,
        partial,
      });
    this.#open = undefined;
  }

  call(id: string, tool: ToolView) {
    this.close();
    const toolCall = {
      type: "toolCall" as const,
      id,
      name: TOOL_NAME,
      arguments: toolArguments(tool),
    };
    this.message.content.push(toolCall);
    const partial = this.message;
    this.events.push({ type: "toolcall_start", contentIndex: this.#index, partial });
    this.events.push({ type: "toolcall_end", contentIndex: this.#index, toolCall, partial });
  }

  get #index() {
    return this.message.content.length - 1;
  }
}

type Request = StreamOptions & { reasoning?: string };

export function createStream(host: StreamHost) {
  return (model: Model<string>, context: TranscriptContext, options: Request = {}) => {
    const draft = new Draft(model);
    const { message, events } = draft;
    const { signal } = options;
    let conversation: Conversation | undefined;

    /** Stamps the message with the session's position so the next request can tell what the agent has seen. */
    const stamp = (active: Conversation) => {
      active.segment += 1;
      message.responseId = `${active.session.id}/${active.session.turns}.${active.segment}`;
      active.anchor = message.responseId;
      message.usage.totalTokens = active.session.usage?.used ?? 0;
    };

    const finish = (reason: "stop" | "length" | "toolUse") => {
      draft.close();
      message.stopReason = reason;
      events.push({ type: "done", reason, message });
    };

    async function relay(active: Conversation, turn: Turn, mirrored: boolean) {
      const { session } = active;
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- events are consumed strictly in order
        const event = await turn.next(signal);
        if (!event) throw new Aborted();
        if (event.type === "text") draft.append("text", event.text);
        else if (event.type === "thought") draft.append("thinking", event.text);
        else if (event.type === "tool" && !mirrored) host.noteTool(event.tool);
        else if (event.type === "tool") {
          const add = (tool: ToolView) => {
            const id = `agy_${session.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40)}_${active.toolIds.size + 1}`;
            active.toolIds.set(id, tool.id);
            draft.call(id, tool);
          };
          add(event.tool);
          // oxlint-disable-next-line no-await-in-loop -- one short wait per assistant message
          await new Promise((resolve) => setTimeout(resolve, TOOL_BATCH_MS));
          for (let next = turn.takeTool(); next; next = turn.takeTool()) add(next);
          stamp(active);
          finish("toolUse");
          return;
        } else {
          session.endTurn(turn);
          stamp(active);
          if (event.type === "failed") throw new AcpError(event.message);
          const usage = event.usage;
          message.usage = {
            ...message.usage,
            input: usage?.inputTokens ?? 0,
            output: usage?.outputTokens ?? 0,
            cacheRead: usage?.cachedReadTokens ?? 0,
            cacheWrite: usage?.cachedWriteTokens ?? 0,
            ...(typeof usage?.thoughtTokens === "number" ? { reasoning: usage.thoughtTokens } : {}),
          };
          message.rawStopReason = event.stopReason;
          const reason = STOP[event.stopReason];
          if (reason === "aborted") throw new Aborted();
          if (reason === "error") throw new AcpError("Antigravity refused this request.");
          finish(reason === "length" ? "length" : "stop");
          return;
        }
      }
    }

    async function run() {
      signal?.throwIfAborted();
      if (!host.conversing(options.sessionId))
        throw new AcpError(
          "Antigravity keeps its own context, so it only answers messages in the conversation. Summaries and other background requests are not available with this model.",
        );
      conversation = await host.open(signal);
      let plan = planTurn(context.messages, conversation.anchor);
      const continuing = !plan.diverged && plan.prompt.length === 0;
      if (!continuing || !conversation.session.turn) {
        if (plan.prompt.length === 0) {
          events.push({ type: "start", partial: message });
          finish("stop");
          return;
        }
        // A new message ends whatever the agent was doing; a transcript it does not match needs a new session.
        if (!(await haltTurn(conversation.session, host.cancelGraceMs))) {
          host.abandon();
          conversation = await host.open(signal);
        } else if (plan.diverged && conversation.session.turns > 0)
          conversation = await host.restart(signal);
        plan = planTurn(context.messages, conversation.anchor);
        const prompt = promptBlocks(plan, conversation.accepts);
        const effort = await applyChoices(conversation.session, model, options.reasoning);
        if (effort !== undefined) message.providerThinkingLevel = effort;
        signal?.throwIfAborted();
        conversation.segment = 0;
        conversation.session.startTurn(prompt);
      }
      events.push({ type: "start", partial: message });
      const mirrored = getCurrentTools(context.messages).some((tool) => tool.name === TOOL_NAME);
      const { turn } = conversation.session;
      if (turn) await relay(conversation, turn, mirrored);
    }

    run()
      .catch(async (error: unknown) => {
        draft.close();
        const aborted = error instanceof Aborted || signal?.aborted === true;
        if (aborted && conversation?.session.turn) {
          stamp(conversation);
          if (!(await haltTurn(conversation.session, host.cancelGraceMs))) host.abandon();
        }
        message.stopReason = aborted ? "aborted" : "error";
        message.errorMessage = aborted
          ? "Antigravity request cancelled."
          : error instanceof AcpError
            ? error.message
            : "The Antigravity agent stopped unexpectedly. Check that `agy` works in a terminal.";
        events.push({ type: "error", reason: message.stopReason, error: message });
      })
      .finally(() => events.end());
    return events;
  };
}
