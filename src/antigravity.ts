import { type ExtensionAPI, type ExtensionContext, VERSION } from "@earendil-works/pi-coding-agent";

import { launch, resolveAgent, type RunningAgent } from "./agent.ts";
import { type Catalog, learn, piModels, PROVIDER, readCatalog, writeCatalog } from "./catalog.ts";
import { AcpClient, SignInRequired, type Workspace } from "./client.ts";
import { Conversation, parseAnchor } from "./conversation.ts";
import { answerElicitation } from "./elicit.ts";
import { readFlags } from "./flags.ts";
import { pick } from "./pick.ts";
import { planLines } from "./plan.ts";
import type { AcpSession, SessionHooks } from "./session.ts";
import { signIn } from "./sign-in.ts";
import { createStream, haltTurn } from "./stream.ts";
import { choiceLabels, TOOL_NAME, toolArguments } from "./tool.ts";
import { workspaceFor } from "./workspace.ts";

const STATUS = "antigravity";
const PLAN = "antigravity-plan";
export const selected = (ctx: ExtensionContext | undefined) => ctx?.model?.provider === PROVIDER;

export function noSuchMode(wanted: string, session: AcpSession): string {
  const offered = session.choices("mode").map((mode) => mode.value);
  const available = offered.length ? ` Available: ${offered.join(", ")}.` : "";
  return `Antigravity has no "${wanted}" mode.${available}`;
}

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
  /** The plan widget's lines as last shown, to skip redrawing an unchanged plan. */
  #shownPlan = "null";
  /** The previous permission dialog; the agent can ask about several tool calls at once. */
  #asking: Promise<unknown> = Promise.resolve();
  #stream = createStream({
    conversing: (piSessionId) =>
      this.#running &&
      piSessionId !== undefined &&
      piSessionId === this.#pane?.sessionManager.getSessionId(),
    open: (_signal, anchor) => this.open(anchor),
    restart: async (_signal, anchor) => {
      const replaced = this.#live?.session.id;
      this.#opening = undefined;
      this.#live = undefined;
      // Pi rewound inside the session being replaced, which went on past that point.
      const reopen =
        anchor !== undefined && parseAnchor(anchor)?.sessionId === replaced ? undefined : anchor;
      const [conversation] = await Promise.all([
        this.open(reopen),
        replaced === undefined ? undefined : this.#close(replaced),
      ]);
      return conversation;
    },
    abandon: () => this.#lose(),
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

  /** The agent's own slash commands, from the live session or the last one. */
  get commands() {
    return this.#live?.session.commands ?? this.#catalog.commands;
  }

  /** Whether the model Pi uses now is one of this extension's. */
  get selected() {
    return selected(this.#pane);
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
    const { mode } = readFlags(this.#pi);
    if (mode !== undefined) this.#wantedMode = mode;
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
    if (this.#live?.session.turn && !(await haltTurn(this.#live.session))) this.#lose();
    this.publish();
  }

  commandStarted(ctx: ExtensionContext) {
    this.#pane = ctx;
  }

  shutdown() {
    this.#forget();
  }

  /** Remembers a permission mode the agent confirmed, for this and later sessions. */
  modeChosen(id: string) {
    this.#wantedMode = id;
    this.#showStatus();
  }

  /** The agent session in use; the first call reopens the one at `anchor` when it is still there. */
  open(anchor?: string): Promise<Conversation> {
    this.#opening ??= this.#start(anchor).catch((error: unknown) => {
      this.#lose();
      throw error;
    });
    return this.#opening;
  }

  #showStatus() {
    const pane = this.#pane;
    if (!pane?.hasUI) return;
    const mode = this.#live?.session.current("mode") ?? this.#wantedMode;
    pane.ui.setStatus(STATUS, selected(pane) && mode ? `agy mode: ${mode}` : undefined);
    this.#showPlan(pane);
  }

  /** Shows the agent's plan above the editor until every step is done. */
  #showPlan(pane: ExtensionContext) {
    const lines = selected(pane) ? planLines(this.#live?.session.plan) : undefined;
    const shown = JSON.stringify(lines ?? null);
    if (shown === this.#shownPlan) return;
    this.#shownPlan = shown;
    pane.ui.setWidget(PLAN, lines);
  }

  /** Keeps the mirror tool declared only while an Antigravity model is selected. */
  #syncTool() {
    const active = this.#pi.getActiveTools();
    const declared = active.includes(TOOL_NAME);
    const wanted = selected(this.#pane);
    if (wanted && !declared) this.#pi.setActiveTools([...active, TOOL_NAME]);
    else if (!wanted && declared)
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

  /** Runs a dialog after the previous one closes. */
  #dialog<T>(show: () => Promise<T>): Promise<T> {
    const shown = this.#asking.then(show);
    this.#asking = shown.catch(() => {});
    return shown;
  }

  #hooks: SessionHooks = {
    askPermission: (tool, options, signal) =>
      this.#dialog(async () => {
        const pane = this.#pane;
        if (signal.aborted || !pane?.hasUI) return undefined;
        const { kind, title } = toolArguments(tool);
        const question = `Antigravity asks permission · ${kind}: ${title}`;
        return pick(pane.ui, question, options, choiceLabels(options), signal);
      }),
    elicit: (request, signal) =>
      this.#dialog(async () => {
        const pane = this.#pane;
        if (!pane?.hasUI) return { action: "cancel" };
        return answerElicitation(request, pane.ui, signal);
      }),
    changed: () => {
      if (this.#live) this.#absorb(this.#live);
      this.#showStatus();
    },
  };

  /** Closes the connection, which also stops the commands the agent ran, and stops the agent. */
  #forget() {
    const connected = this.#client;
    this.#live?.session.dispose();
    this.#agent?.stop();
    this.#agent = undefined;
    this.#client = undefined;
    this.#opening = undefined;
    this.#live = undefined;
    void connected?.then(
      (c) => c.close(),
      () => {},
    );
  }

  /** Drops a dead or stuck agent and clears what Pi showed for it. */
  #lose() {
    this.#forget();
    this.#showStatus();
  }

  async #connect(): Promise<AcpClient> {
    const cwd = this.#pane?.cwd ?? process.cwd();
    const started = launch(resolveAgent(readFlags(this.#pi).agent), cwd);
    this.#agent = started;
    const identity = { name: "pi", title: "Pi", version: VERSION };
    const connected = await AcpClient.connect(started.stream, identity, this.#hooks);
    // When the agent exits, start over on the next message instead of talking to a dead process.
    const ended = () => {
      if (this.#agent === started) this.#lose();
    };
    void connected.closed.then(ended, ended);
    return connected;
  }

  /** Asks the agent to free a session nobody will prompt again; the agent keeps it saved. */
  async #close(sessionId: string) {
    const connected = await this.#client;
    // Freeing memory is a courtesy: a session the agent keeps open costs nothing visible.
    await connected?.closeSession(sessionId).catch(() => {});
  }

  /** Reopens the agent session Pi's transcript left off in, if the agent is still at that point. */
  async #reopen(connected: AcpClient, anchor: string, where: Workspace) {
    const at = parseAnchor(anchor);
    const session = at && (await connected.loadSession(at.sessionId, where));
    if (!session) return undefined;
    if (session.turns === at.turns) return new Conversation(session, connected.accepts, anchor);
    // The agent has prompts this transcript never saw; continuing would mix the two conversations.
    await this.#close(session.id);
    return undefined;
  }

  /** The connection to the agent, starting the agent if needed, without opening a session. */
  connected(): Promise<AcpClient> {
    this.#client ??= this.#connect().catch((error: unknown) => {
      // A failed start is not kept: the next request tries again, for example once agy is installed.
      this.#forget();
      throw error;
    });
    return this.#client;
  }

  /** Drops the agent process; the next message starts a new one. */
  disconnect() {
    this.#lose();
  }

  async #begin(connected: AcpClient, anchor: string | undefined, where: Workspace) {
    return (
      (anchor && (await this.#reopen(connected, anchor, where))) ||
      new Conversation(await connected.newSession(where), connected.accepts)
    );
  }

  async #start(anchor: string | undefined): Promise<Conversation> {
    const connected = await this.connected();
    const pane = this.#pane;
    const trusted = pane?.isProjectTrusted() ?? false;
    const { where, notes } = workspaceFor(this.#pi, pane?.cwd ?? process.cwd(), trusted);
    for (const note of notes) this.#pane?.ui.notify(note, "warning");
    for (const server of where.mcpServers ?? [])
      if (!connected.takes(server))
        this.#pane?.ui.notify(
          `MCP server ${server.name}: this agent takes no HTTP servers; it does not get it.`,
          "warning",
        );
    const conversation = await this.#begin(connected, anchor, where).catch(
      async (error: unknown) => {
        const title = "Antigravity needs you to sign in";
        if (error instanceof SignInRequired && (await signIn(connected, this.#pane, title)))
          return this.#begin(connected, anchor, where);
        throw error;
      },
    );
    const { session } = conversation;
    const wanted = this.#wantedMode;
    if (wanted !== undefined && (await session.select("mode", wanted)) === "unavailable") {
      this.#pane?.ui.notify(noSuchMode(wanted, session), "warning");
      this.#wantedMode = undefined;
    }
    this.#live = conversation;
    this.#absorb(this.#live);
    this.#showStatus();
    return this.#live;
  }
}
