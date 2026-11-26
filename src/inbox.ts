import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk/unstable";

import { put, without } from "./immutable.ts";

const EARLY_UPDATE_LIMIT = 64;
/** Sessions whose early updates are kept at once; the oldest is dropped for a new one. */
const EARLY_SESSION_LIMIT = 16;

/** One prompt turn of a replayed conversation, as its text. */
export interface Exchange {
  readonly user: string;
  readonly agent: string;
}

/**
 * Prompt turns an agent replays while it loads a saved session; each starts with the user speaking.
 * With `exchanges`, their text is kept as well.
 */
interface Replay {
  readonly turns: number;
  readonly userSpeaking: boolean;
  readonly exchanges: readonly Exchange[] | undefined;
}

function chunkText(content: ContentBlock): string {
  return content.type === "text" ? content.text : "";
}

function extend(exchanges: readonly Exchange[], side: keyof Exchange, text: string) {
  const last = exchanges.at(-1);
  if (!last) return exchanges;
  return [...exchanges.slice(0, -1), { ...last, [side]: last[side] + text }];
}

/** Updates in which the agent answers; the user's next message starts a new turn after one. */
const AGENT_TURN = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
]);

/** The replay after one more update; each user message after an agent update starts a turn. */
function replayed(replay: Replay, update: SessionUpdate): Replay {
  const { exchanges } = replay;
  if (update.sessionUpdate === "user_message_chunk") {
    const starts = !replay.userSpeaking;
    const begun = starts && exchanges ? [...exchanges, { user: "", agent: "" }] : exchanges;
    return {
      turns: replay.turns + (starts ? 1 : 0),
      userSpeaking: true,
      exchanges: begun && extend(begun, "user", chunkText(update.content)),
    };
  }
  const answered =
    update.sessionUpdate === "agent_message_chunk" && exchanges
      ? extend(exchanges, "agent", chunkText(update.content))
      : exchanges;
  return {
    turns: replay.turns,
    userSpeaking: replay.userSpeaking && !AGENT_TURN.has(update.sessionUpdate),
    exchanges: answered,
  };
}

/** Updates for sessions not open yet: the replay of a reopened session, and early settings and usage. */
export class Inbox {
  #early: ReadonlyMap<string, readonly SessionUpdate[]> = new Map();
  #replays: ReadonlyMap<string, Replay> = new Map();

  /** Starts counting the replay of `sessionId`, keeping its text when `keepText` is set. */
  startReplay(sessionId: string, keepText: boolean) {
    this.#early = without(this.#early, sessionId);
    const replay = { turns: 0, userSpeaking: false, exchanges: keepText ? [] : undefined };
    this.#replays = put(this.#replays, sessionId, replay);
  }

  /** Stops counting the replay of `sessionId` and returns what was counted. */
  endReplay(sessionId: string): Replay | undefined {
    const replay = this.#replays.get(sessionId);
    this.#replays = without(this.#replays, sessionId);
    return replay;
  }

  hold(sessionId: string, update: SessionUpdate) {
    const replay = this.#replays.get(sessionId);
    if (replay) this.#replays = put(this.#replays, sessionId, replayed(replay, update));
    if (replay && /^(user_message|agent_|tool_call|plan)/.test(update.sessionUpdate)) return;
    const held = this.#early.get(sessionId) ?? [];
    if (held.length >= EARLY_UPDATE_LIMIT) return;
    const refreshed = put(without(this.#early, sessionId), sessionId, [...held, update]);
    // A Map keeps insertion order, so the first entry is the session held longest.
    this.#early =
      refreshed.size > EARLY_SESSION_LIMIT ? new Map([...refreshed].slice(1)) : refreshed;
  }

  /** The updates held for `sessionId`, which are no longer held. */
  take(sessionId: string): readonly SessionUpdate[] {
    const held = this.#early.get(sessionId) ?? [];
    this.#early = without(this.#early, sessionId);
    return held;
  }
}
