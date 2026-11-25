import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable";

import { isRecord } from "./guards.ts";

const EARLY_UPDATE_LIMIT = 64;
/** Sessions whose early updates are kept at once; the oldest is dropped for a new one. */
const EARLY_SESSION_LIMIT = 16;

/** One prompt turn of a replayed conversation, as its text. */
export interface Exchange {
  user: string;
  agent: string;
}

/**
 * Prompt turns an agent replays while it loads a saved session; each starts with the user speaking.
 * With `exchanges`, their text is kept as well.
 */
export interface Replay {
  turns: number;
  userSpeaking: boolean;
  exchanges?: Exchange[];
}

function chunkText(update: SessionUpdate): string {
  const content = "content" in update ? update.content : undefined;
  return isRecord(content) && content["type"] === "text" && typeof content["text"] === "string"
    ? content["text"]
    : "";
}

/** Updates that arrive before their session exists: settings and usage are kept, a replay is counted. */
export interface Inbox {
  early: Map<string, SessionUpdate[]>;
  replays: Map<string, Replay>;
}

export function hold(inbox: Inbox, sessionId: string, update: SessionUpdate) {
  const replay = inbox.replays.get(sessionId);
  const kind = update.sessionUpdate;
  if (replay && kind === "user_message_chunk") {
    if (!replay.userSpeaking) replay.turns += 1;
    if (!replay.userSpeaking) replay.exchanges?.push({ user: "", agent: "" });
    replay.userSpeaking = true;
    const last = replay.exchanges?.at(-1);
    if (last) last.user += chunkText(update);
    return;
  }
  if (replay) replay.userSpeaking = false;
  const answering = replay?.exchanges?.at(-1);
  if (answering && kind === "agent_message_chunk") answering.agent += chunkText(update);
  if (replay && /^(agent_|tool_call|plan)/.test(kind)) return;
  const held = inbox.early.get(sessionId) ?? [];
  if (held.length >= EARLY_UPDATE_LIMIT) return;
  inbox.early.delete(sessionId);
  inbox.early.set(sessionId, [...held, update]);
  const oldest = inbox.early.keys().next();
  if (inbox.early.size > EARLY_SESSION_LIMIT && !oldest.done) inbox.early.delete(oldest.value);
}
