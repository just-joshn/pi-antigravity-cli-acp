import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { Antigravity } from "./antigravity.ts";
import { AGENT_DEFAULT, API, PROVIDER } from "./catalog.ts";
import type { Exchange, SavedSession } from "./client.ts";
import { noUsage } from "./stream.ts";

/** One label per session, numbered when titles and times repeat. */
export function labels(saved: readonly SavedSession[]): string[] {
  const seen = new Map<string, number>();
  return saved.map((session) => {
    const when = session.updatedAt ? ` — ${session.updatedAt.slice(0, 16).replace("T", " ")}` : "";
    const text = `${session.title ?? "Untitled"}${when}`;
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    return count > 1 ? `${text} (${count})` : text;
  });
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
      responseId: `${sessionId}/${index + 1}.1`,
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
  const offered = labels(saved);
  const picked = await ctx.ui.select("Open an Antigravity session", offered);
  const chosen = picked === undefined ? undefined : saved[offered.indexOf(picked)];
  if (!chosen) return;
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
