import type { ContentBlock } from "@agentclientprotocol/sdk/unstable";

import { put } from "./immutable.ts";
import type { AcpSession, ToolView } from "./session.ts";

/** Characters of the agent session id kept in a mirrored tool call id. */
const ID_PREFIX_LIMIT = 40;

/** Where a saved assistant message left an agent session: `<session id>/<turns>.<segment>`. */
export function anchorFor(sessionId: string, turns: number, segment: number): string {
  return `${sessionId}/${turns}.${segment}`;
}

/** The session id and turn count of an anchor written by `anchorFor`. */
export function parseAnchor(anchor: string): { sessionId: string; turns: number } | undefined {
  const match = /^(.+)\/(\d+)\.\d+$/.exec(anchor);
  return match?.[1] && match[2] ? { sessionId: match[1], turns: Number(match[2]) } : undefined;
}

/** One agent session as this Pi session sees it. */
export class Conversation {
  readonly session: AcpSession;
  readonly accepts: { image: boolean; embeddedContext: boolean };
  #anchor: string | undefined;
  /** Assistant messages built from the turn in progress. */
  #segment = 0;
  /** Tool calls mirrored so far; numbers the Pi tool call ids. */
  #mirrored = 0;
  /** Mirrored Pi tool call id to the agent's tool call id, for the turn in progress. */
  #toolIds: ReadonlyMap<string, string> = new Map();

  /** `anchor` is set when the session was reopened at that position of Pi's transcript. */
  constructor(session: AcpSession, accepts: Conversation["accepts"], anchor?: string) {
    this.session = session;
    this.accepts = accepts;
    this.#anchor = anchor;
  }

  /** `responseId` of the last assistant message built from this session. */
  get anchor() {
    return this.#anchor;
  }

  startTurn(prompt: ContentBlock[]) {
    this.#segment = 0;
    // The agent's tool calls belong to their turn; earlier ones can no longer be followed.
    this.#toolIds = new Map();
    this.session.startTurn(prompt);
  }

  /** The session's position for the next assistant message, which becomes the anchor. */
  stamp(): string {
    this.#segment += 1;
    this.#anchor = anchorFor(this.session.id, this.session.turns, this.#segment);
    return this.#anchor;
  }

  /** A Pi tool call id for one of the agent's tool calls. */
  mirror(tool: ToolView): string {
    const prefix = this.session.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, ID_PREFIX_LIMIT);
    // The turn keeps ids unique when the session is reopened and this count starts again.
    this.#mirrored += 1;
    const id = `agy_${prefix}_${this.session.turns}_${this.#mirrored}`;
    this.#toolIds = put(this.#toolIds, id, tool.id);
    return id;
  }

  /** Follows the agent's tool call behind a mirrored Pi tool call. */
  watch(
    piToolId: string,
    signal: AbortSignal | undefined,
    onChange: (tool: ToolView) => void,
  ): Promise<ToolView | undefined> {
    const id = this.#toolIds.get(piToolId);
    return id === undefined
      ? Promise.resolve(undefined)
      : this.session.watchTool(id, signal, onChange);
  }
}
