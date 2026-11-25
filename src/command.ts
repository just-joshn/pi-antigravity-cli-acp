import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Antigravity } from "./antigravity.ts";
import { AcpError, reasonOf } from "./client.ts";

const USAGE = "Usage: /agy status, /agy mode [id], or /agy <agent command> [input]";
/** /agy's own subcommands; an agent command with one of these names is typed directly instead. */
const OWN = new Set(["status", "mode"]);

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

/** Sends `/name input` to the agent as an ordinary user message, as if typed at the prompt. */
function runAgentCommand(
  pi: ExtensionAPI,
  link: Antigravity,
  typed: string,
  ctx: ExtensionContext,
) {
  const name = typed.split(/\s/, 1)[0];
  if (!link.selected) {
    ctx.ui.notify(
      `/agy ${name} runs in the Antigravity agent. Select an antigravity model with /model first.`,
      "warning",
    );
    return;
  }
  if (ctx.isIdle()) pi.sendUserMessage(`/${typed}`);
  else pi.sendUserMessage(`/${typed}`, { deliverAs: "followUp" });
}

function completions(link: Antigravity, prefix: string) {
  const own = ["status", "mode", ...link.modes.map((mode) => `mode ${mode.value}`)].map(
    (value) => ({ value, label: value }),
  );
  const agents = link.commands
    .filter((command) => !OWN.has(command.name))
    .map((command) => ({
      value: command.name,
      label: command.name,
      description: command.hint ? `${command.description} (${command.hint})` : command.description,
    }));
  const matches = [...own, ...agents].filter((option) => option.value.startsWith(prefix));
  return matches.length ? matches : null;
}

/** `/agy status`, `/agy mode [id]` and the agent's own commands as `/agy <command> [input]`. */
export function registerAgyCommand(pi: ExtensionAPI, link: Antigravity) {
  pi.registerCommand("agy", {
    description:
      "Antigravity agent: /agy status, /agy mode [id], or /agy <agent command> [input] to run one of its commands",
    getArgumentCompletions: (prefix) => completions(link, prefix),
    async handler(args, ctx) {
      link.commandStarted(ctx);
      const typed = args.trim();
      const [command, value] = typed.split(/\s+/);
      try {
        if (command === "mode") await chooseMode(link, value, ctx);
        else if (!command || command === "status") await showAgent(link, ctx);
        else if (link.commands.some((known) => known.name === command))
          runAgentCommand(pi, link, typed, ctx);
        else ctx.ui.notify(USAGE, "warning");
      } catch (error) {
        ctx.ui.notify(
          error instanceof AcpError
            ? error.message
            : `The Antigravity agent could not be reached: ${reasonOf(error, "no reason given")}`,
          "error",
        );
      }
    },
  });
}
