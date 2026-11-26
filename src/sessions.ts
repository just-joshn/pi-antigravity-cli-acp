import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { Antigravity } from "./antigravity.ts";
import { AGENT_DEFAULT, API, PROVIDER } from "./catalog.ts";
import type { SavedSession } from "./client.ts";
import { anchorFor } from "./conversation.ts";
import { noUsage } from "./draft.ts";
import type { Exchange } from "./inbox.ts";
import { occurrences } from "./occurrences.ts";
import { pick } from "./pick.ts";

const MINUTE = "YYYY-MM-DDTHH:MM".length;

/** One label per session, numbered when titles and times repeat. */
export function labels(saved: readonly SavedSession[]): string[] {
  const texts = saved.map((session) => {
    const when = session.updatedAt
      ? ` — ${session.updatedAt.slice(0, MINUTE).replace("T", " ")}`
      : "";
    return `${session.title ?? "Untitled"}${when}`;
  });
  return occurrences(texts, (text) => text).map(({ item, nth }) =>
    nth > 1 ? `${item} (${nth})` : item,
  );
}

/** Pi messages for a replayed conversation. Each reply carries the agent session's position. */
function messages(sessionId: string, exchanges: readonly Exchange[]) {
  const timestamp = Date.now();
  return exchanges.flatMap((exchange, index) => {
    const reply: AssistantMessage = {
      role: "assistant",
      content: exchange.agent ? [{ type: "text", text: exchange.agent }] : [],
      api: API,
      provider: PROVIDER,
      model: AGENT_DEFAULT,
      usage: noUsage(),
      stopReason: "stop",
      timestamp,
      responseId: anchorFor(sessionId, index + 1, 1),
    };
    return [{ role: "user" as const, content: exchange.user, timestamp }, reply];
  });
}

/** `/agy sessions`: opens one of the agent's saved conversations as a new Pi session. */
export async function openSaved(link: Antigravity, ctx: ExtensionCommandContext) {
  const client = await link.connected();
  const saved = await client.listSessions(ctx.cwd);
  if (saved.length === 0) {
    ctx.ui.notify("Antigravity has no saved sessions for this directory.", "info");
    return;
  }
  const chosen = await pick(ctx.ui, "Open an Antigravity session", saved, labels(saved));
  if (!chosen) return;
  if (chosen.id === link.live?.session.id) {
    ctx.ui.notify("That Antigravity session is the one in use here.", "info");
    return;
  }
  const exchanges = await client.readTranscript(chosen.id, { cwd: ctx.cwd });
  if (!exchanges) {
    ctx.ui.notify("Antigravity no longer has that session.", "warning");
    return;
  }
  const parentSession = ctx.sessionManager.getSessionFile();
  await ctx.newSession({
    ...(parentSession ? { parentSession } : {}),
    setup: async (manager) => {
      for (const message of messages(chosen.id, exchanges)) manager.appendMessage(message);
      if (chosen.title) manager.appendSessionInfo(chosen.title);
    },
  });
}
