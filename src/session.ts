import type {
  AvailableCommand,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk/unstable";

import { isRecord } from "./guards.ts";
import { put, without } from "./immutable.ts";
import { isPlanUpdate, nextPlan, type Plan } from "./plan.ts";

/** The agent settings a client can change, named by ACP's config-option categories. */
type OptionCategory = "model" | "thought_level" | "mode";

/** A command the agent runs when a prompt starts with `/name`. */
export interface AgentCommand {
  name: string;
  description: string;
  /** What to type after the command, when it takes input. */
  hint: string | undefined;
}

const COMMAND_LIMIT = 200;
const TEXT_LIMIT = 500;
const TITLE_LIMIT = 200;

function agentCommand(command: AvailableCommand): AgentCommand {
  const hint = command.input?.hint.slice(0, TEXT_LIMIT);
  return { name: command.name, description: command.description.slice(0, TEXT_LIMIT), hint };
}

export interface Choice {
  value: string;
  name: string;
  description: string | undefined;
}

/** Immutable snapshot of one tool call the agent made. A new snapshot replaces it on every update. */
export interface ToolView {
  readonly id: string;
  readonly kind: ToolKind;
  readonly title: string;
  readonly paths: readonly string[];
  readonly status: ToolCallStatus;
  readonly content: readonly ToolCallContent[];
  readonly rawOutput: unknown;
  /** Output so far of the client terminals the tool call shows, in order. */
  readonly terminalOutput: string;
  readonly decision: "allowed" | "declined" | undefined;
  /** No further updates will arrive: the tool finished or its turn ended. */
  readonly settled: boolean;
}

export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; tool: ToolView }
  | { type: "end"; stopReason: PromptResponse["stopReason"]; usage: PromptResponse["usage"] }
  | { type: "failed"; message: string };

/** The requests a session sends to its agent. */
export interface AgentPort {
  prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<SessionConfigOption[]>;
}

export interface SessionHooks {
  /** Resolves with the option the user picked, or undefined when nobody decided. */
  askPermission(
    tool: ToolView,
    options: PermissionOption[],
    signal: AbortSignal,
  ): Promise<PermissionOption | undefined>;
  /** Answers a structured question from the agent; cancelled when nobody can answer. */
  elicit(
    request: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse>;
  /** The session's settings, usage or title changed. */
  changed(): void;
}

/** An immutable list, newest first. */
type Stack<T> = { readonly head: T; readonly tail: Stack<T> } | undefined;

function reversed<T>(stack: Stack<T>): Stack<T> {
  let result: Stack<T>;
  for (let rest = stack; rest; rest = rest.tail) result = { head: rest.head, tail: result };
  return result;
}

/**
 * Ordered events of one prompt turn. Each event goes to one reader. The queue is two immutable
 * lists, so adding and taking an event are constant time on average without changing either list.
 */
export class Turn {
  #front: Stack<TurnEvent>;
  #back: Stack<TurnEvent>;
  #waiting: readonly (() => void)[] = [];
  #halting: Promise<boolean> | undefined;

  /** Runs `halt` once for this turn; later callers share its result. */
  haltOnce(halt: () => Promise<boolean>): Promise<boolean> {
    this.#halting ??= halt();
    return this.#halting;
  }

  push(event: TurnEvent) {
    this.#back = { head: event, tail: this.#back };
    for (const wake of this.#waiting) wake();
  }

  #peek(): TurnEvent | undefined {
    if (!this.#front) {
      this.#front = reversed(this.#back);
      this.#back = undefined;
    }
    return this.#front?.head;
  }

  #shift(): TurnEvent | undefined {
    const head = this.#peek();
    this.#front = this.#front?.tail;
    return head;
  }

  /** The next event. With a signal, resolves with undefined once it aborts and nothing is queued. */
  next(): Promise<TurnEvent>;
  next(signal: AbortSignal | undefined): Promise<TurnEvent | undefined>;
  async next(signal?: AbortSignal): Promise<TurnEvent | undefined> {
    for (;;) {
      const event = this.#shift();
      if (event || signal?.aborted) return event;
      // oxlint-disable-next-line no-await-in-loop -- waits for the next event; nothing to run in parallel
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.#waiting = this.#waiting.filter((waiting) => waiting !== wake);
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        this.#waiting = [...this.#waiting, wake];
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }

  /** Takes the next event only when it is a tool call that has already arrived. */
  takeTool(): ToolView | undefined {
    const head = this.#peek();
    if (head?.type !== "tool") return undefined;
    this.#shift();
    return head.tool;
  }
}

type SelectOption = Extract<SessionConfigOption, { type: "select" }>;

function describeFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : "The agent ended the request.";
  const data = error instanceof Error && "data" in error ? error.data : undefined;
  const detail = isRecord(data) ? data["details"] : undefined;
  return [text, typeof detail === "string" ? detail : ""]
    .filter(Boolean)
    .join(": ")
    .slice(0, TEXT_LIMIT);
}

/** One agent conversation: its settings, context usage, tool calls and the turn in progress. */
export class AcpSession {
  readonly id: string;
  readonly tier: string | undefined;
  readonly cwd: string;
  /** Where Pi writes files for the agent: the session's directory and its extra ones. */
  readonly workspaces: readonly string[];
  /** Model ids the agent lists with the thinking level spelled out, such as `gemini-x-high`. */
  readonly variants: readonly string[];
  #title: string | undefined;
  #turns = 0;
  #options: SessionConfigOption[];
  #usage: { used: number; size: number } | undefined;
  #commands: readonly AgentCommand[] | undefined;
  /** Latest output of each client terminal of this session. */
  #terminals: ReadonlyMap<string, string> = new Map();
  #plan: Plan | undefined;
  #tools: ReadonlyMap<string, ToolView> = new Map();
  /** The previous turn's tool calls; a late update to one of them is not a new call. */
  #endedTools: ReadonlySet<string> = new Set();
  #watchers: ReadonlyMap<string, readonly ((tool: ToolView) => void)[]> = new Map();
  #turn: Turn | undefined;
  #dialogs = new AbortController();
  #port: AgentPort;
  #hooks: SessionHooks;

  constructor(
    id: string,
    initial: {
      options: SessionConfigOption[];
      tier: string | undefined;
      variants: string[];
      cwd: string;
      directories: readonly string[];
      /** Prompt turns the session already had, when it was reopened. */
      turns: number;
    },
    port: AgentPort,
    hooks: SessionHooks,
  ) {
    this.id = id;
    this.tier = initial.tier;
    this.variants = initial.variants;
    this.cwd = initial.cwd;
    this.workspaces = [initial.cwd, ...initial.directories];
    this.#turns = initial.turns;
    this.#options = initial.options;
    this.#port = port;
    this.#hooks = hooks;
  }

  get usage() {
    return this.#usage;
  }

  get turn() {
    return this.#turn;
  }

  /** The commands the agent last listed for this session; undefined until it lists them. */
  get commands() {
    return this.#commands;
  }

  get plan() {
    return this.#plan;
  }

  get title() {
    return this.#title;
  }

  /** Prompt turns started so far. */
  get turns() {
    return this.#turns;
  }

  #option(category: OptionCategory): SelectOption | undefined {
    return this.#options.find(
      (o): o is SelectOption => o.type === "select" && (o.category ?? o.id) === category,
    );
  }

  current(category: OptionCategory): string | undefined {
    return this.#option(category)?.currentValue;
  }

  choices(category: OptionCategory): Choice[] {
    const option = this.#option(category);
    if (!option) return [];
    return option.options
      .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
      .map((o) => ({ value: o.value, name: o.name, description: o.description ?? undefined }));
  }

  async select(
    category: OptionCategory,
    value: string,
  ): Promise<"set" | "unchanged" | "unavailable"> {
    const option = this.#option(category);
    if (!option || !this.choices(category).some((c) => c.value === value)) return "unavailable";
    if (option.currentValue === value) return "unchanged";
    this.#options = await this.#port.setConfigOption(this.id, option.id, value);
    this.#hooks.changed();
    return this.current(category) === value ? "set" : "unavailable";
  }

  startTurn(prompt: ContentBlock[]): Turn {
    const turn = new Turn();
    this.#turns += 1;
    this.#turn = turn;
    this.#settleTools();
    this.#endedTools = new Set(this.#tools.keys());
    this.#tools = new Map();
    const dialogs = new AbortController();
    this.#dialogs = dialogs;
    const finish = (event: TurnEvent) => {
      // A permission question outlives its turn only by mistake; it must not be answerable later.
      dialogs.abort();
      if (this.#turn === turn || this.#turn === undefined) this.#settleTools();
      turn.push(event);
    };
    this.#port.prompt(this.id, prompt).then(
      (reply) => finish({ type: "end", stopReason: reply.stopReason, usage: reply.usage }),
      (error: unknown) => finish({ type: "failed", message: describeFailure(error) }),
    );
    return turn;
  }

  /** Closes open permission dialogs; the session is being dropped. */
  dispose() {
    this.#dialogs.abort();
    this.#settleTools();
  }

  /** Asks the agent to stop the turn in progress. The turn still ends with its own event. */
  async cancelTurn(): Promise<void> {
    if (!this.#turn) return;
    this.#dialogs.abort();
    await this.#port.cancel(this.id);
  }

  /** Marks a turn as fully consumed so the next prompt can start. */
  endTurn(turn: Turn | undefined) {
    if (turn && this.#turn === turn) this.#turn = undefined;
  }

  /** Resolves with the tool's final state, or undefined when the agent never made that call. */
  watchTool(
    id: string,
    signal: AbortSignal | undefined,
    onChange: (tool: ToolView) => void,
  ): Promise<ToolView | undefined> {
    const current = this.#tools.get(id);
    if (!current || current.settled || signal?.aborted) return Promise.resolve(current);
    return new Promise((resolve) => {
      const done = (tool: ToolView | undefined) => {
        this.#unwatch(id, watch);
        signal?.removeEventListener("abort", abort);
        resolve(tool);
      };
      const watch = (tool: ToolView) => {
        if (tool.settled) done(tool);
        else onChange(tool);
      };
      const abort = () => done(this.#tools.get(id));
      this.#watchers = put(this.#watchers, id, [...(this.#watchers.get(id) ?? []), watch]);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  #unwatch(id: string, watch: (tool: ToolView) => void) {
    const left = (this.#watchers.get(id) ?? []).filter((other) => other !== watch);
    this.#watchers = left.length ? put(this.#watchers, id, left) : without(this.#watchers, id);
  }

  receive(update: SessionUpdate) {
    if (
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk"
    ) {
      if (update.content.type !== "text") return;
      const type = update.sessionUpdate === "agent_message_chunk" ? "text" : "thought";
      this.#turn?.push({ type, text: update.content.text });
    } else if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      if (!this.#tools.has(update.toolCallId) && this.#endedTools.has(update.toolCallId)) return;
      this.#mergeTool(update);
    } else if (update.sessionUpdate === "usage_update") {
      this.#usage = { used: update.used, size: update.size };
      this.#hooks.changed();
    } else if (update.sessionUpdate === "config_option_update") {
      this.#options = update.configOptions;
      this.#hooks.changed();
    } else if (update.sessionUpdate === "current_mode_update") {
      // The agent changed its own mode; the mode setting must say so, or selecting it again is skipped.
      const mode = this.#option("mode");
      this.#options = this.#options.map((option) =>
        option === mode ? { ...mode, currentValue: update.currentModeId } : option,
      );
      this.#hooks.changed();
    } else if (isPlanUpdate(update)) {
      this.#plan = nextPlan(this.#plan, update);
      this.#hooks.changed();
    } else if (update.sessionUpdate === "available_commands_update") {
      this.#commands = update.availableCommands.slice(0, COMMAND_LIMIT).map(agentCommand);
      this.#hooks.changed();
    } else if (update.sessionUpdate === "session_info_update") {
      if (update.title !== undefined)
        this.#title = update.title?.slice(0, TITLE_LIMIT) || undefined;
      this.#hooks.changed();
    }
  }

  async permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // The answer decides the tool call's fate; a status sent with the question cannot.
    const tool = this.#mergeTool({ ...request.toolCall, status: null });
    const { signal } = this.#dialogs;
    // A dialog that fails decides nothing, so the request falls back to the agent's reject option.
    const choice = await this.#hooks
      .askPermission(tool, request.options, signal)
      .catch(() => undefined);
    if (signal.aborted) return { outcome: { outcome: "cancelled" } };
    const picked =
      request.options.find((o) => o.optionId === choice?.optionId) ??
      request.options.find((o) => o.kind === "reject_once");
    const latest = this.#tools.get(tool.id) ?? tool;
    this.#publish({
      ...latest,
      decision: picked?.kind.startsWith("allow") ? "allowed" : "declined",
    });
    return picked
      ? { outcome: { outcome: "selected", optionId: picked.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  /** A question asked during the turn; like a permission dialog, it closes when the turn ends. */
  async elicit(request: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const { signal } = this.#dialogs;
    const cancel: CreateElicitationResponse = { action: "cancel" };
    // A question nobody could answer is cancelled, as when the user dismisses it.
    const reply = await this.#hooks.elicit(request, signal).catch(() => cancel);
    return signal.aborted ? cancel : reply;
  }

  #mergeTool(patch: ToolCallUpdate): ToolView {
    const previous = this.#tools.get(patch.toolCallId);
    const status = patch.status ?? previous?.status ?? "pending";
    const content = patch.content ?? previous?.content ?? [];
    const tool: ToolView = {
      id: patch.toolCallId,
      kind: patch.kind ?? previous?.kind ?? "other",
      title: patch.title ?? previous?.title ?? "",
      paths: patch.locations?.map((l) => l.path) ?? previous?.paths ?? [],
      status,
      content,
      rawOutput: patch.rawOutput ?? previous?.rawOutput,
      // A released terminal's last output stays, even when the agent updates the call afterwards.
      terminalOutput: this.#terminalOutputOf(content) || (previous?.terminalOutput ?? ""),
      decision: previous?.decision,
      // Once a call is settled it stays so, even if the agent sends another update for it.
      settled: previous?.settled === true || status === "completed" || status === "failed",
    };
    this.#publish(tool);
    if (!previous) this.#turn?.push({ type: "tool", tool });
    return tool;
  }

  #terminalOutputOf(content: readonly ToolCallContent[]): string {
    return content
      .flatMap((item) =>
        item.type === "terminal" ? [this.#terminals.get(item.terminalId) ?? ""] : [],
      )
      .join("\n");
  }

  /** New output of a client terminal, or undefined once it is released; tool calls showing it are updated. */
  terminalOutput(terminalId: string, output: string | undefined) {
    // A released terminal's last output stays in the tool calls that showed it.
    if (output === undefined) {
      this.#terminals = without(this.#terminals, terminalId);
      return;
    }
    this.#terminals = put(this.#terminals, terminalId, output);
    for (const tool of this.#tools.values()) {
      const shows = tool.content.some(
        (item) => item.type === "terminal" && item.terminalId === terminalId,
      );
      if (shows) this.#publish({ ...tool, terminalOutput: this.#terminalOutputOf(tool.content) });
    }
  }

  #settleTools() {
    for (const tool of this.#tools.values()) {
      if (!tool.settled) this.#publish({ ...tool, settled: true });
    }
  }

  #publish(tool: ToolView) {
    this.#tools = put(this.#tools, tool.id, tool);
    for (const watch of this.#watchers.get(tool.id) ?? []) watch(tool);
  }
}
