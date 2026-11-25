import { join } from "node:path";

import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { type AgentChoice, launch, resolveAgent, type RunningAgent } from "./agent.ts";
import { type Catalog, learn, piModels, PROVIDER, readCatalog, writeCatalog } from "./catalog.ts";
import { AcpClient, AcpError } from "./client.ts";
import { Conversation } from "./conversation.ts";
import { callLine, resultLines } from "./render.ts";
import type { AcpSession, SessionHooks } from "./session.ts";
import { createStream, haltTurn } from "./stream.ts";
import { choiceLabels, runMirror, TOOL_NAME, toolArguments, type ToolDetails } from "./tool.ts";

const STATUS = "antigravity";
const selected = (ctx: ExtensionContext | undefined) => ctx?.model?.provider === PROVIDER;
const CHOICES: readonly string[] = ["auto", "cli", "registry"] satisfies AgentChoice[];

function isChoice(value: unknown): value is AgentChoice {
  return typeof value === "string" && CHOICES.includes(value);
}

/**
 * Makes Pi an ACP client of the Antigravity agent: the agent's models appear in Pi's model picker,
 * and the agent, not Pi, runs the tools and keeps the conversation.
 */
export default function antigravityAcp(pi: ExtensionAPI) {
  pi.registerFlag("agy-agent", {
    type: "string",
    description: "Antigravity ACP agent to run: auto, cli (agy acp) or registry (installed by Zed)",
  });
  pi.registerFlag("agy-mode", {
    type: "string",
    description: "Antigravity permission mode to start in, for example default, auto or yolo",
  });

  const catalogFile = join(getAgentDir(), "antigravity", "catalog.json");
  let catalog: Catalog = readCatalog(catalogFile);
  let published = "";
  /** Latest context Pi handed to this extension; dialogs and the status line go through it. */
  let pane: ExtensionContext | undefined;
  let running = false;
  let wantedMode: string | undefined;
  let agent: RunningAgent | undefined;
  let client: Promise<AcpClient> | undefined;
  let opening: Promise<Conversation> | undefined;
  let live: Conversation | undefined;

  function showStatus() {
    if (!pane?.hasUI) return;
    const mode = live?.session.current("mode") ?? wantedMode;
    pane.ui.setStatus(STATUS, selected(pane) && mode ? `agy mode: ${mode}` : undefined);
  }

  /** Keeps the mirror tool declared only while an Antigravity model is selected. */
  function syncTool() {
    const active = pi.getActiveTools();
    const declared = active.includes(TOOL_NAME);
    if (selected(pane) && !declared) pi.setActiveTools([...active, TOOL_NAME]);
    else if (!selected(pane) && declared)
      pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
  }

  function publish() {
    const models = piModels(catalog);
    const key = JSON.stringify(models);
    if (key === published) return;
    published = key;
    pi.registerProvider({
      id: PROVIDER,
      name: "Antigravity (ACP)",
      auth: {
        apiKey: {
          name: "Signed in through the Antigravity agent",
          resolve: () => Promise.resolve({ auth: {}, source: "Antigravity agent" }),
        },
      },
      getModels: () => models,
      stream,
      streamSimple: stream,
    });
  }

  function absorb(session: AcpSession) {
    const next = learn(catalog, session);
    if (JSON.stringify(next) === JSON.stringify(catalog)) return;
    catalog = next;
    try {
      writeCatalog(catalogFile, catalog);
    } catch {
      // The catalog is a cache; without it the model list is rebuilt from the next session.
    }
    if (!running) publish();
  }

  /** The previous permission dialog; the agent can ask about several tool calls at once. */
  let asking: Promise<unknown> = Promise.resolve();

  const hooks: SessionHooks = {
    askPermission(tool, options, signal) {
      const answer = asking.then(async () => {
        if (signal.aborted || !pane?.hasUI) return undefined;
        const labels = choiceLabels(options);
        const { kind, title } = toolArguments(tool);
        const picked = await pane.ui.select(
          `Antigravity asks permission · ${kind}: ${title}`,
          labels,
          { signal },
        );
        return picked === undefined ? undefined : options[labels.indexOf(picked)];
      });
      asking = answer.catch(() => {});
      return answer;
    },
    changed() {
      if (live) absorb(live.session);
      showStatus();
    },
  };

  function forget() {
    agent?.stop();
    agent = undefined;
    client = undefined;
    opening = undefined;
    live = undefined;
  }

  async function connect(): Promise<AcpClient> {
    const flag = pi.getFlag("agy-agent");
    const cwd = pane?.cwd ?? process.cwd();
    const started = launch(resolveAgent(isChoice(flag) ? flag : "auto"), cwd);
    agent = started;
    const connected = await AcpClient.connect(
      started.stream,
      { name: "pi", title: "Pi", version: VERSION },
      hooks,
    );
    // When the agent exits, start over on the next message instead of talking to a dead process.
    const ended = () => {
      if (agent === started) forget();
    };
    void connected.closed.then(ended, ended);
    return connected;
  }

  async function start(): Promise<Conversation> {
    client ??= connect();
    const connected = await client;
    const session = await connected.newSession(pane?.cwd ?? process.cwd());
    if (wantedMode !== undefined && (await session.select("mode", wantedMode)) === "unavailable") {
      const offered = session.choices("mode").map((mode) => mode.value);
      pane?.ui.notify(
        `Antigravity has no "${wantedMode}" mode. Available: ${offered.join(", ")}.`,
        "warning",
      );
      wantedMode = undefined;
    }
    live = new Conversation(session, connected.accepts);
    absorb(session);
    showStatus();
    return live;
  }

  function open(): Promise<Conversation> {
    opening ??= start().catch((error: unknown) => {
      forget();
      throw error;
    });
    return opening;
  }

  const stream = createStream({
    conversing: (piSessionId) =>
      running && piSessionId !== undefined && piSessionId === pane?.sessionManager.getSessionId(),
    open,
    restart() {
      opening = undefined;
      live = undefined;
      return open();
    },
    abandon: forget,
    noteTool(tool) {
      const { kind, title } = toolArguments(tool);
      pane?.ui.notify(`Antigravity ${kind}: ${title}`, "info");
    },
  });
  publish();

  const parameters = Type.Object({ kind: Type.String(), title: Type.String() });
  pi.registerTool<typeof parameters, ToolDetails>({
    name: TOOL_NAME,
    label: "Antigravity",
    description:
      "Shows a tool call made by the Antigravity agent. The agent runs the tool itself; this cannot be called directly.",
    parameters,
    defaultActive: false,
    execute: (id, _params, signal, onUpdate) =>
      runMirror(
        (stop, onChange) => (live ? live.watch(id, stop, onChange) : Promise.resolve(undefined)),
        signal,
        onUpdate,
      ),
    renderCall(args, theme, context) {
      const text =
        context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(callLine(args, theme));
      return text;
    },
    renderResult(result, view, theme, context) {
      const text =
        context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(resultLines(result.details, view, theme).join("\n"));
      return text;
    },
  });

  pi.on("session_start", (_event, ctx) => {
    pane = ctx;
    const mode = pi.getFlag("agy-mode");
    if (typeof mode === "string" && mode !== "") wantedMode = mode;
    syncTool();
    showStatus();
  });
  pi.on("model_select", (_event, ctx) => {
    pane = ctx;
    syncTool();
    showStatus();
  });
  pi.on("agent_start", (_event, ctx) => {
    pane = ctx;
    running = true;
  });
  pi.on("agent_end", async (_event, ctx) => {
    pane = ctx;
    running = false;
    // Pi can end a run while mirrored tools are still pending; the agent must not keep working unseen.
    if (live?.session.turn && !(await haltTurn(live.session))) forget();
    publish();
  });
  pi.on("session_before_compact", (event, ctx) => {
    if (!selected(ctx)) return undefined;
    if (event.reason === "manual")
      ctx.ui.notify(
        "Antigravity manages its own context, so Pi's compaction is skipped for this model.",
        "info",
      );
    return { cancel: true };
  });
  pi.on("session_shutdown", () => {
    const connected = client;
    forget();
    void connected?.then(
      (c) => c.close(),
      () => {},
    );
  });

  async function chooseMode(requested: string | undefined, ctx: ExtensionContext) {
    const { session } = await open();
    const modes = session.choices("mode");
    let id = requested;
    if (id === undefined) {
      const labels = modes.map((mode) => `${mode.value} — ${mode.description ?? mode.name}`);
      const picked = ctx.hasUI
        ? await ctx.ui.select("Antigravity permission mode", labels)
        : undefined;
      id = picked === undefined ? undefined : modes[labels.indexOf(picked)]?.value;
      if (id === undefined) return;
    }
    if ((await session.select("mode", id)) === "unavailable") {
      ctx.ui.notify(
        `Antigravity has no "${id}" mode. Available: ${modes.map((mode) => mode.value).join(", ")}.`,
        "warning",
      );
      return;
    }
    wantedMode = id;
    showStatus();
    ctx.ui.notify(`Antigravity permission mode: ${id}`, "info");
  }

  async function showAgent(ctx: ExtensionContext) {
    if (!live) {
      ctx.ui.notify(
        "No Antigravity session yet. It starts with your first message to an antigravity model.",
        "info",
      );
      return;
    }
    const { session } = live;
    const connected = await client;
    const usage = session.usage;
    const lines = [
      `Agent: ${connected?.agent.name ?? "unknown"} ${connected?.agent.version ?? ""}`.trim(),
      session.tier ? `Quota tier: ${session.tier}` : "",
      `Model: ${session.current("model") ?? "unknown"}`,
      `Thinking: ${session.current("thought_level") ?? "not adjustable"}`,
      `Permission mode: ${session.current("mode") ?? "unknown"}`,
      usage
        ? `Context: ${usage.used.toLocaleString("en-US")} of ${usage.size.toLocaleString("en-US")} tokens`
        : "",
      `Agent session: ${session.id}${session.title ? ` (${session.title})` : ""}`,
    ];
    ctx.ui.notify(lines.filter(Boolean).join("\n"), "info");
  }

  pi.registerCommand("agy", {
    description: "Antigravity agent: /agy status, or /agy mode [id] to change its permission mode",
    getArgumentCompletions(prefix) {
      const options = ["status", "mode", ...catalog.modes.map((mode) => `mode ${mode.value}`)];
      const matches = options.filter((option) => option.startsWith(prefix));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    async handler(args, ctx) {
      pane = ctx;
      const [command, value] = args.trim().split(/\s+/);
      try {
        if (command === "mode") await chooseMode(value, ctx);
        else if (!command || command === "status") await showAgent(ctx);
        else ctx.ui.notify("Usage: /agy status, or /agy mode [id]", "warning");
      } catch (error) {
        ctx.ui.notify(
          error instanceof AcpError ? error.message : "The Antigravity agent could not be reached.",
          "error",
        );
      }
    },
  });
}
