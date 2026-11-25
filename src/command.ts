import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Antigravity } from "./antigravity.ts";
import { AcpError } from "./client.ts";

/** Sets the agent's permission mode, asking the user to pick one when `requested` is undefined. */
async function chooseMode(link: Antigravity, requested: string | undefined, ctx: ExtensionContext) {
  const { session } = await link.open();
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
  link.modeChosen(id);
  ctx.ui.notify(`Antigravity permission mode: ${id}`, "info");
}

async function showAgent(link: Antigravity, ctx: ExtensionContext) {
  const { live } = link;
  if (!live) {
    ctx.ui.notify(
      "No Antigravity session yet. It starts with your first message to an antigravity model.",
      "info",
    );
    return;
  }
  const { session } = live;
  const agent = await link.agentInfo();
  const usage = session.usage;
  const lines = [
    `Agent: ${agent?.name ?? "unknown"} ${agent?.version ?? ""}`.trim(),
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

/** `/agy status` and `/agy mode [id]`. */
export function registerAgyCommand(pi: ExtensionAPI, link: Antigravity) {
  pi.registerCommand("agy", {
    description: "Antigravity agent: /agy status, or /agy mode [id] to change its permission mode",
    getArgumentCompletions(prefix) {
      const options = ["status", "mode", ...link.modes.map((mode) => `mode ${mode.value}`)];
      const matches = options.filter((option) => option.startsWith(prefix));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    async handler(args, ctx) {
      link.commandStarted(ctx);
      const [command, value] = args.trim().split(/\s+/);
      try {
        if (command === "mode") await chooseMode(link, value, ctx);
        else if (!command || command === "status") await showAgent(link, ctx);
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
