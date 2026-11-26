import { join } from "node:path";

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { Antigravity, selected } from "./antigravity.ts";
import { registerAgyCommand } from "./command.ts";
import { callLine, resultLines } from "./render.ts";
import { runMirror, TOOL_NAME, type ToolDetails } from "./tool.ts";
import { registerWorkspaceFlags } from "./workspace.ts";

function registerFlags(pi: ExtensionAPI) {
  pi.registerFlag("agy-agent", {
    type: "string",
    description: "Antigravity ACP agent to run: auto, cli (agy acp) or registry (installed by Zed)",
  });
  pi.registerFlag("agy-mode", {
    type: "string",
    description: "Antigravity permission mode to start in, for example default, auto or yolo",
  });
}

/** The row's previous component when Pi passes one back, so it is updated rather than rebuilt. */
function reused(lastComponent: unknown): Text {
  return lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
}

/** The Pi tool whose calls show the agent's own tool calls. */
function registerMirrorTool(pi: ExtensionAPI, link: Antigravity) {
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
        (stop, onChange) =>
          link.live ? link.live.watch(id, stop, onChange) : Promise.resolve(undefined),
        signal,
        onUpdate,
      ),
    renderCall(args, theme, context) {
      const text = reused(context.lastComponent);
      text.setText(callLine(args, theme));
      return text;
    },
    renderResult(result, view, theme, context) {
      const text = reused(context.lastComponent);
      text.setText(resultLines(result.details, view, theme).join("\n"));
      return text;
    },
  });
}

function registerEvents(pi: ExtensionAPI, link: Antigravity) {
  pi.on("session_start", (_event, ctx) => link.sessionStarted(ctx));
  pi.on("model_select", (_event, ctx) => link.modelSelected(ctx));
  pi.on("agent_start", (_event, ctx) => link.runStarted(ctx));
  pi.on("agent_end", (_event, ctx) => link.runEnded(ctx));
  pi.on("session_before_compact", (event, ctx) => {
    if (!selected(ctx)) return undefined;
    if (event.reason === "manual")
      ctx.ui.notify(
        "Antigravity manages its own context, so Pi's compaction is skipped for this model.",
        "info",
      );
    return { cancel: true };
  });
  pi.on("session_shutdown", () => link.shutdown());
}

/**
 * Makes Pi an ACP client of the Antigravity agent: the agent's models appear in Pi's model picker,
 * and the agent, not Pi, runs the tools and keeps the conversation.
 */
export default function antigravityAcp(pi: ExtensionAPI) {
  registerFlags(pi);
  registerWorkspaceFlags(pi);
  const link = new Antigravity(pi, join(getAgentDir(), "antigravity", "catalog.json"));
  link.publish();
  registerMirrorTool(pi, link);
  registerEvents(pi, link);
  registerAgyCommand(pi, link);
}
