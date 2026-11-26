import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { type Antigravity, noSuchMode } from "./antigravity.ts";
import { AcpError, reasonOf } from "./client.ts";
import { uniqueLabels } from "./labels.ts";
import { pick } from "./pick.ts";
import { openSaved } from "./sessions.ts";
import { signIn } from "./sign-in.ts";

const USAGE =
  "Usage: /agy status, /agy mode [id], /agy sessions, /agy login, /agy logout, or /agy <agent command> [input]";

/** Sets the agent's permission mode, asking the user to pick one when `requested` is undefined. */
async function chooseMode(link: Antigravity, requested: string | undefined, ctx: ExtensionContext) {
  const { session } = await link.openFor(ctx);
  const modes = session.choices("mode");
  let id = requested;
  if (id === undefined) {
    const labels = uniqueLabels(
      modes.map((mode) => `${mode.value} — ${mode.description ?? mode.name}`),
      (label, n) => `${label} (${n})`,
    );
    const picked = ctx.hasUI
      ? await pick(ctx.ui, "Antigravity permission mode", modes, labels)
      : undefined;
    id = picked?.value;
    if (id === undefined) return;
  }
  if ((await session.select("mode", id)) === "unavailable") {
    ctx.ui.notify(noSuchMode(id, session), "warning");
    return;
  }
  link.modeChosen(id);
  ctx.ui.notify(`Antigravity permission mode: ${id}`, "info");
}

async function showAgent(link: Antigravity, _value: string | undefined, ctx: ExtensionContext) {
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

async function logIn(link: Antigravity, _value: string | undefined, ctx: ExtensionContext) {
  const method = await signIn(await link.connected(), ctx, "Sign in to Antigravity");
  ctx.ui.notify(
    method ? `Signed in to Antigravity with ${method.name}.` : "Not signed in to Antigravity.",
    "info",
  );
}

async function logOut(link: Antigravity, _value: string | undefined, ctx: ExtensionContext) {
  const client = await link.connected();
  if (!client.offers.logout) {
    ctx.ui.notify(
      "This Antigravity agent cannot sign out from Pi. Run `agy` to sign out.",
      "warning",
    );
    return;
  }
  const sure = await ctx.ui.confirm("Sign out of Antigravity?", "You will need to sign in again.");
  if (!sure) {
    ctx.ui.notify("Still signed in to Antigravity.", "info");
    return;
  }
  await client.logOut();
  link.disconnect();
  ctx.ui.notify("Signed out of Antigravity.", "info");
}

type Subcommand = (
  link: Antigravity,
  value: string | undefined,
  ctx: ExtensionCommandContext,
) => Promise<void>;

/** /agy's own subcommands; an agent command with one of these names is typed directly instead. */
const OWN: Record<string, Subcommand> = {
  status: showAgent,
  mode: chooseMode,
  login: logIn,
  logout: logOut,
  sessions: (link, _value, ctx) => openSaved(link, ctx),
};

/** Sends `/name input` to the agent as an ordinary user message, as if typed at the prompt. */
function runAgentCommand(
  pi: ExtensionAPI,
  link: Antigravity,
  name: string,
  typed: string,
  ctx: ExtensionContext,
) {
  if (!link.selected) {
    ctx.ui.notify(
      `/agy ${name} runs in the Antigravity agent. Select an antigravity model with /model first.`,
      "warning",
    );
    return;
  }
  pi.sendUserMessage(`/${typed}`, ctx.isIdle() ? {} : { deliverAs: "followUp" });
}

function completions(link: Antigravity, prefix: string) {
  const own = [...Object.keys(OWN), ...link.modes.map((mode) => `mode ${mode.value}`)].map(
    (value) => ({ value, label: value }),
  );
  const agents = link.commands
    .filter((command) => !Object.hasOwn(OWN, command.name))
    .map((command) => ({
      value: command.name,
      label: command.name,
      description: command.hint ? `${command.description} (${command.hint})` : command.description,
    }));
  const matches = [...own, ...agents].filter((option) => option.value.startsWith(prefix));
  return matches.length ? matches : null;
}

/** `/agy` with its own subcommands, and the agent's commands as `/agy <command> [input]`. */
export function registerAgyCommand(pi: ExtensionAPI, link: Antigravity) {
  pi.registerCommand("agy", {
    description:
      "Antigravity agent: /agy status, mode [id], sessions, login, logout, or /agy <agent command> [input]",
    getArgumentCompletions: (prefix) => completions(link, prefix),
    async handler(args, ctx) {
      link.commandStarted(ctx);
      const typed = args.trim();
      const [command = "status", value] = typed.split(/\s+/).filter(Boolean);
      const own = Object.hasOwn(OWN, command) ? OWN[command] : undefined;
      try {
        if (own) await own(link, value, ctx);
        else if (link.commands.some((known) => known.name === command))
          runAgentCommand(pi, link, command, typed, ctx);
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
