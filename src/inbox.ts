import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable";

import { isRecord } from "./guards.ts";
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
export interface Replay {
  readonly turns: number;
  readonly userSpeaking: boolean;
  readonly exchanges: readonly Exchange[] | undefined;
}

function chunkText(update: SessionUpdate): string {
  const content = "content" in update ? update.content : undefined;
  return isRecord(content) && content["type"] === "text" && typeof content["text"] === "string"
    ? content["text"]
    : "";
}

/** The exchanges with `text` added to the last one's user or agent side. */
function extend(exchanges: readonly Exchange[], side: keyof Exchange, text: string) {
  const last = exchanges.at(-1);
  if (!last) return exchanges;
  return [...exchanges.slice(0, -1), { ...last, [side]: last[side] + text }];
}

/** The replay after one more update; each user message after an agent update starts a turn. */
export function replayed(replay: Replay, update: SessionUpdate): Replay {
  const { exchanges } = replay;
  if (update.sessionUpdate === "user_message_chunk") {
    const starts = !replay.userSpeaking;
    const begun = starts && exchanges ? [...exchanges, { user: "", agent: "" }] : exchanges;
    return {
      turns: replay.turns + (starts ? 1 : 0),
      userSpeaking: true,
      exchanges: begun && extend(begun, "user", chunkText(update)),
    };
  }
  const answer = update.sessionUpdate === "agent_message_chunk" && exchanges;
  return {
    turns: replay.turns,
    userSpeaking: false,
    exchanges: answer ? extend(answer, "agent", chunkText(update)) : exchanges,
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
    const [oldest] = refreshed.keys();
    const over = refreshed.size > EARLY_SESSION_LIMIT && oldest !== undefined;
    this.#early = over ? without(refreshed, oldest) : refreshed;
  }

  /** The updates held for `sessionId`, which are no longer held. */
  take(sessionId: string): readonly SessionUpdate[] {
    const held = this.#early.get(sessionId) ?? [];
    this.#early = without(this.#early, sessionId);
    return held;
  }
}
