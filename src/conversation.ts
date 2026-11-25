import type { ContentBlock } from "@agentclientprotocol/sdk/unstable";

import type { AcpSession, ToolView, Turn } from "./session.ts";

/** One agent session as this Pi session sees it. */
export class Conversation {
  readonly session: AcpSession;
  readonly accepts: { image: boolean; embeddedContext: boolean };
  #anchor: string | undefined;
  /** Assistant messages built from the turn in progress. */
  #segment = 0;
  /** Mirrored Pi tool call id to the agent's tool call id. */
  #toolIds = new Map<string, string>();

  constructor(session: AcpSession, accepts: Conversation["accepts"]) {
    this.session = session;
    this.accepts = accepts;
  }

  /** `responseId` of the last assistant message built from this session. */
  get anchor() {
    return this.#anchor;
  }

  startTurn(prompt: ContentBlock[]): Turn {
    this.#segment = 0;
    return this.session.startTurn(prompt);
  }

  /** The session's position for the next assistant message, which becomes the anchor. */
  stamp(): string {
    this.#segment += 1;
    this.#anchor = `${this.session.id}/${this.session.turns}.${this.#segment}`;
    return this.#anchor;
  }

  /** A Pi tool call id for one of the agent's tool calls. */
  mirror(tool: ToolView): string {
    const prefix = this.session.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
    const id = `agy_${prefix}_${this.#toolIds.size + 1}`;
    this.#toolIds.set(id, tool.id);
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
