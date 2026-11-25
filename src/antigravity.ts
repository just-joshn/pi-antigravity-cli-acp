import { type ExtensionAPI, type ExtensionContext, VERSION } from "@earendil-works/pi-coding-agent";

import { type AgentChoice, launch, resolveAgent, type RunningAgent } from "./agent.ts";
import { type Catalog, learn, piModels, PROVIDER, readCatalog, writeCatalog } from "./catalog.ts";
import { AcpClient } from "./client.ts";
import { Conversation } from "./conversation.ts";
import type { SessionHooks } from "./session.ts";
import { createStream, haltTurn } from "./stream.ts";
import { choiceLabels, TOOL_NAME, toolArguments } from "./tool.ts";

const STATUS = "antigravity";
const CHOICES: readonly string[] = ["auto", "cli", "registry"] satisfies AgentChoice[];

function isChoice(value: unknown): value is AgentChoice {
  return typeof value === "string" && CHOICES.includes(value);
}

export const selected = (ctx: ExtensionContext | undefined) => ctx?.model?.provider === PROVIDER;

/** The extension's link to the Antigravity agent: its process, session and what it offers. */
export class Antigravity {
  #pi: ExtensionAPI;
  #catalogFile: string;
  #catalog: Catalog;
  #published = "";
  /** Latest context Pi handed to this extension; dialogs and the status line go through it. */
  #pane: ExtensionContext | undefined;
  #running = false;
  #wantedMode: string | undefined;
  #agent: RunningAgent | undefined;
  #client: Promise<AcpClient> | undefined;
  #opening: Promise<Conversation> | undefined;
  #live: Conversation | undefined;
  /** The previous permission dialog; the agent can ask about several tool calls at once. */
  #asking: Promise<unknown> = Promise.resolve();
  #stream = createStream({
    conversing: (piSessionId) =>
      this.#running &&
      piSessionId !== undefined &&
      piSessionId === this.#pane?.sessionManager.getSessionId(),
    open: () => this.open(),
    restart: () => {
      this.#opening = undefined;
      this.#live = undefined;
      return this.open();
    },
    abandon: () => this.#forget(),
    noteTool: (tool) => {
      const { kind, title } = toolArguments(tool);
      this.#pane?.ui.notify(`Antigravity ${kind}: ${title}`, "info");
    },
  });

  constructor(pi: ExtensionAPI, catalogFile: string) {
    this.#pi = pi;
    this.#catalogFile = catalogFile;
    this.#catalog = readCatalog(catalogFile);
  }

  /** The agent session in use, once the first message has started one. */
  get live() {
    return this.#live;
  }

  get modes() {
    return this.#catalog.modes;
  }

  /** The connected agent's name and version, if it has started. */
  async agentInfo() {
    return (await this.#client)?.agent;
  }

  /** Registers the provider, again only when the agent's model list changed. */
  publish() {
    const models = piModels(this.#catalog);
    const key = JSON.stringify(models);
    if (key === this.#published) return;
    this.#published = key;
    this.#pi.registerProvider({
      id: PROVIDER,
      name: "Antigravity (ACP)",
      auth: {
        apiKey: {
          name: "Signed in through the Antigravity agent",
          resolve: () => Promise.resolve({ auth: {}, source: "Antigravity agent" }),
        },
      },
      getModels: () => models,
      stream: this.#stream,
      streamSimple: this.#stream,
    });
  }

  sessionStarted(ctx: ExtensionContext) {
    this.#pane = ctx;
    const mode = this.#pi.getFlag("agy-mode");
    if (typeof mode === "string" && mode !== "") this.#wantedMode = mode;
    this.#syncTool();
    this.#showStatus();
  }

  modelSelected(ctx: ExtensionContext) {
    this.#pane = ctx;
    this.#syncTool();
    this.#showStatus();
  }

  runStarted(ctx: ExtensionContext) {
    this.#pane = ctx;
    this.#running = true;
  }

  async runEnded(ctx: ExtensionContext) {
    this.#pane = ctx;
    this.#running = false;
    // Pi can end a run while mirrored tools are still pending; the agent must not keep working unseen.
    if (this.#live?.session.turn && !(await haltTurn(this.#live.session))) this.#forget();
    this.publish();
  }

  commandStarted(ctx: ExtensionContext) {
    this.#pane = ctx;
  }

  shutdown() {
    const connected = this.#client;
    this.#forget();
    void connected?.then(
      (c) => c.close(),
      () => {},
    );
  }

  /** Remembers a permission mode the agent confirmed, for this and later sessions. */
  modeChosen(id: string) {
    this.#wantedMode = id;
    this.#showStatus();
  }

  open(): Promise<Conversation> {
    this.#opening ??= this.#start().catch((error: unknown) => {
      this.#forget();
      throw error;
    });
    return this.#opening;
  }

  #showStatus() {
    const pane = this.#pane;
    if (!pane?.hasUI) return;
    const mode = this.#live?.session.current("mode") ?? this.#wantedMode;
    pane.ui.setStatus(STATUS, selected(pane) && mode ? `agy mode: ${mode}` : undefined);
  }

  /** Keeps the mirror tool declared only while an Antigravity model is selected. */
  #syncTool() {
    const active = this.#pi.getActiveTools();
    const declared = active.includes(TOOL_NAME);
    if (selected(this.#pane) && !declared) this.#pi.setActiveTools([...active, TOOL_NAME]);
    else if (!selected(this.#pane) && declared)
      this.#pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
  }

  #absorb(conversation: Conversation) {
    const next = learn(this.#catalog, conversation.session);
    if (JSON.stringify(next) === JSON.stringify(this.#catalog)) return;
    this.#catalog = next;
    try {
      writeCatalog(this.#catalogFile, next);
    } catch {
      // The catalog is a cache; without it the model list is rebuilt from the next session.
    }
    if (!this.#running) this.publish();
  }

  #hooks: SessionHooks = {
    askPermission: (tool, options, signal) => {
      const answer = this.#asking.then(async () => {
        const pane = this.#pane;
        if (signal.aborted || !pane?.hasUI) return undefined;
        const labels = choiceLabels(options);
        const { kind, title } = toolArguments(tool);
        const question = `Antigravity asks permission · ${kind}: ${title}`;
        const picked = await pane.ui.select(question, labels, { signal });
        return picked === undefined ? undefined : options[labels.indexOf(picked)];
      });
      this.#asking = answer.catch(() => {});
      return answer;
    },
    changed: () => {
      if (this.#live) this.#absorb(this.#live);
      this.#showStatus();
    },
  };

  #forget() {
    this.#agent?.stop();
    this.#agent = undefined;
    this.#client = undefined;
    this.#opening = undefined;
    this.#live = undefined;
  }

  async #connect(): Promise<AcpClient> {
    const flag = this.#pi.getFlag("agy-agent");
    const cwd = this.#pane?.cwd ?? process.cwd();
    const started = launch(resolveAgent(isChoice(flag) ? flag : "auto"), cwd);
    this.#agent = started;
    const identity = { name: "pi", title: "Pi", version: VERSION };
    const connected = await AcpClient.connect(started.stream, identity, this.#hooks);
    // When the agent exits, start over on the next message instead of talking to a dead process.
    const ended = () => {
      if (this.#agent === started) this.#forget();
    };
    void connected.closed.then(ended, ended);
    return connected;
  }

  async #start(): Promise<Conversation> {
    this.#client ??= this.#connect();
    const connected = await this.#client;
    const session = await connected.newSession(this.#pane?.cwd ?? process.cwd());
    const wanted = this.#wantedMode;
    if (wanted !== undefined && (await session.select("mode", wanted)) === "unavailable") {
      const offered = session.choices("mode").map((mode) => mode.value);
      this.#pane?.ui.notify(
        `Antigravity has no "${wanted}" mode. Available: ${offered.join(", ")}.`,
        "warning",
      );
      this.#wantedMode = undefined;
    }
    this.#live = new Conversation(session, connected.accepts);
    this.#absorb(this.#live);
    this.#showStatus();
    return this.#live;
  }
}
