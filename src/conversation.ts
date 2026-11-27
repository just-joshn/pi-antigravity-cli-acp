import type { ContentBlock } from "@agentclientprotocol/sdk/unstable";

import { put } from "./immutable.ts";
import type { AcpSession, ToolView } from "./session.ts";

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

export class Conversation {
	readonly session: AcpSession;
	readonly accepts: { image: boolean; embeddedContext: boolean };
	#anchor: string | undefined;
	#segment = 0;
	#mirrored = 0;
	#toolIds: ReadonlyMap<string, string> = new Map();

	/** `anchor` is set when the session was reopened at that position of Pi's transcript. */
	constructor(session: AcpSession, accepts: Conversation["accepts"], anchor?: string) {
		this.session = session;
		this.accepts = accepts;
		this.#anchor = anchor;
	}

	get anchor() {
		return this.#anchor;
	}

	startTurn(prompt: ContentBlock[]) {
		this.#segment = 0;
		// The agent's tool calls belong to their turn; earlier ones can no longer be followed.
		this.#toolIds = new Map();
		this.session.startTurn(prompt);
	}

	stamp(): string {
		this.#segment += 1;
		this.#anchor = anchorFor(this.session.id, this.session.turns, this.#segment);
		return this.#anchor;
	}

	mirror(tool: ToolView): string {
		const prefix = this.session.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, ID_PREFIX_LIMIT);
		// The turn keeps ids unique when the session is reopened and this count starts again.
		this.#mirrored += 1;
		const id = `agy_${prefix}_${this.session.turns}_${this.#mirrored}`;
		this.#toolIds = put(this.#toolIds, id, tool.id);
		return id;
	}

	watch(
		piToolId: string,
		signal: AbortSignal | undefined,
		onChange: (tool: ToolView) => void,
	): Promise<ToolView | undefined> {
		const id = this.#toolIds.get(piToolId);
		return id === undefined ? Promise.resolve(undefined) : this.session.watchTool(id, signal, onChange);
	}
}
