import { createHash } from "node:crypto";

import type { ContentBlock } from "@agentclientprotocol/sdk/unstable";
import {
	getCurrentTools,
	type ImageContent,
	type Message,
	type Model,
	type StopReason,
	type StreamOptions,
	type TextContent,
	type ThinkingLevel,
	type TranscriptContext,
	type UserMessage,
} from "@earendil-works/pi-ai";

import { AGENT_DEFAULT, effortFor, PROVIDER } from "./catalog.ts";
import { AcpError, reasonOf } from "./client.ts";
import type { Conversation } from "./conversation.ts";
import { Draft } from "./draft.ts";
import type { AcpSession, ToolView, Turn, TurnEvent } from "./session.ts";
import { TOOL_NAME } from "./tool.ts";

const CANCEL_GRACE_MS = 5000;
/** Tool calls the agent starts together arrive as separate updates; wait this long to group them. */
const TOOL_BATCH_MS = 25;
const HISTORY_LIMIT = 24_000;
const TOOL_RESULT_LIMIT = 600;

/** Shown when Pi continues a turn the agent no longer runs; it must not look retryable either. */
export const TURN_LOST =
	"Antigravity's turn was over before Pi finished showing its tool calls, so this reply is empty. Send a message to go on.";

/**
 * Shown instead of sending a message again whose earlier attempt failed after reaching the agent.
 * Pi retries some errors on its own; this text must not look like one of them.
 */
export const NOT_RESENT =
	"Antigravity stopped before it finished this message, so what it did is unknown. It was not sent again; check the workspace, then send it again if needed.";

interface StreamHost {
	conversing(piSessionId: string | undefined): boolean;
	/**
	 * The agent session in use, opening one if needed. `anchor` is where Pi's transcript last left an
	 * agent session; the host reopens that session when it is still at that position.
	 */
	open(signal: AbortSignal | undefined, anchor: string | undefined): Promise<Conversation>;
	restart(signal: AbortSignal | undefined, anchor: string | undefined): Promise<Conversation>;
	abandon(): void;
	cancelGraceMs?: number;
	noteTool(tool: ToolView): void;
}

interface TurnPlan {
	diverged: boolean;
	missed: Message[];
	prompt: UserMessage[];
}

/**
 * Compares Pi's transcript with what the agent session has seen. The last assistant message this
 * provider wrote carries the session's position as its `responseId`; everything after it is new.
 */
export function planTurn(messages: Message[], anchor: string | undefined): TurnPlan {
	const { index: ours, anchor: seen } = lastAnchor(messages);
	const diverged = seen !== anchor;
	const prompt = pendingPrompt(messages);
	const cut = messages.length - prompt.length;
	const last = diverged ? undefined : messages[ours];
	const answered = new Set(
		last?.role === "assistant" ? last.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])) : [],
	);
	const missed = messages
		.slice(diverged ? 0 : ours + 1, cut)
		.filter((m) => m.role !== "system" && !(m.role === "toolResult" && answered.has(m.toolCallId)));
	return { diverged, missed, prompt };
}

function pendingPrompt(messages: Message[]): UserMessage[] {
	let cut = messages.length;
	while (cut > 0 && messages[cut - 1]?.role === "user") cut--;
	return messages.slice(cut).filter((m) => m.role === "user");
}

export function lastAnchor(messages: Message[]): { index: number; anchor: string | undefined } {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant" && message.provider === PROVIDER && message.responseId)
			return { index, anchor: message.responseId };
	}
	return { index: -1, anchor: undefined };
}

function plainText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

export function renderHistory(messages: Message[]): string {
	const lines = messages.flatMap((message) => {
		if (message.role === "user") return [`User: ${plainText(message.content)}`];
		if (message.role === "toolResult")
			return [`Tool result (${message.toolName}): ${plainText(message.content).slice(0, TOOL_RESULT_LIMIT)}`];
		if (message.role !== "assistant") return [];
		const said = message.content
			.flatMap((block) => {
				if (block.type === "text") return [block.text];
				if (block.type === "toolCall") return [`[tool ${block.name}: ${JSON.stringify(block.arguments)}]`];
				return [];
			})
			.join("\n");
		return said ? [`Assistant: ${said}`] : [];
	});
	if (lines.length === 0) return "";
	const text = lines.join("\n\n");
	const kept = text.length > HISTORY_LIMIT ? `[earlier conversation omitted]\n${text.slice(-HISTORY_LIMIT)}` : text;
	return `Conversation so far, supplied by the client as context:\n\n${kept}`;
}

/** One block of a user message as the agent takes it; an image needs an agent that accepts images. */
function agentBlock(block: TextContent | ImageContent, accepts: Conversation["accepts"]): ContentBlock {
	if (block.type === "text") return { type: "text", text: block.text };
	if (!accepts.image) throw new AcpError("This Antigravity agent does not accept images.");
	return { type: "image", data: block.data, mimeType: block.mimeType };
}

function promptBlocks(plan: TurnPlan, accepts: Conversation["accepts"]): ContentBlock[] {
	const history = renderHistory(plan.missed);
	const resource = {
		uri: "context://conversation-so-far",
		mimeType: "text/markdown",
		text: history,
	};
	const context: ContentBlock[] = !history
		? []
		: [accepts.embeddedContext ? { type: "resource", resource } : { type: "text", text: history }];
	const prompt = plan.prompt.flatMap((message): ContentBlock[] =>
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.map((block) => agentBlock(block, accepts)),
	);
	return [...context, ...prompt];
}

async function applyChoices(session: AcpSession, model: Model<string>, level: ThinkingLevel | undefined) {
	if (model.id !== AGENT_DEFAULT && (await session.select("model", model.id)) === "unavailable")
		throw new AcpError(`Antigravity does not offer ${model.id} right now. Choose another model with /model.`);
	const effort = effortFor(model, level);
	if (effort === undefined) return undefined;
	return (await session.select("thought_level", effort)) === "unavailable" ? undefined : effort;
}

/**
 * Stops the turn in progress. Resolves false when the agent did not confirm within `graceMs`:
 * the session is then still busy and must not be prompted again.
 */
export function haltTurn(session: AcpSession, graceMs = CANCEL_GRACE_MS): Promise<boolean> {
	const { turn } = session;
	if (!turn) return Promise.resolve(true);
	return turn.haltOnce(async () => {
		const giveUp = new AbortController();
		// A cancel or a read that fails leaves the halt unconfirmed, so the caller abandons the agent.
		const ended = (async () => {
			await session.cancelTurn();
			for (;;) {
				const event = await turn.next(giveUp.signal);
				if (!event) return false;
				if (event.type === "end" || event.type === "failed") return true;
			}
		})().catch(() => false);
		let timer: NodeJS.Timeout | undefined;
		const grace = new Promise<false>((resolve) => {
			timer = setTimeout(resolve, graceMs, false);
		});
		const confirmed = await Promise.race([ended, grace]);
		clearTimeout(timer);
		giveUp.abort();
		session.endTurn(turn);
		return confirmed;
	});
}

const STOP = {
	end_turn: "stop",
	max_turn_requests: "stop",
	max_tokens: "length",
	refusal: "error",
	cancelled: "aborted",
} satisfies Record<Extract<TurnEvent, { type: "end" }>["stopReason"], StopReason>;

class Aborted extends Error {}

type Request = StreamOptions & { reasoning?: ThinkingLevel };
type EndEvent = Extract<TurnEvent, { type: "end" | "failed" }>;

const OUTSIDE_CONVERSATION =
	"Antigravity keeps its own context, so it only answers messages in the conversation. Summaries and other background requests are not available with this model.";

class Reply {
	readonly draft: Draft;
	#host: StreamHost;
	#unfinished: Set<string>;
	#sent: UserMessage[] = [];
	#model: Model<string>;
	#context: TranscriptContext;
	#options: Request;
	#conversation: Conversation | undefined;

	constructor(
		host: StreamHost,
		model: Model<string>,
		context: TranscriptContext,
		options: Request,
		unfinished: Set<string>,
	) {
		this.draft = new Draft(model);
		this.#unfinished = unfinished;
		this.#host = host;
		this.#model = model;
		this.#context = context;
		this.#options = options;
	}

	start() {
		this.#run()
			.catch((error: unknown) => this.#fail(error))
			.finally(() => this.draft.events.end());
		return this.draft.events;
	}

	#stamp(active: Conversation) {
		const { usage } = this.draft.message;
		const totalTokens = active.session.usage?.used ?? 0;
		this.draft.update({ responseId: active.stamp(), usage: { ...usage, totalTokens } });
	}

	async #run() {
		const { signal, sessionId } = this.#options;
		signal?.throwIfAborted();
		if (!this.#host.conversing(sessionId)) throw new AcpError(OUTSIDE_CONVERSATION);
		// An automatic retry would give the agent the same message twice, repeating whatever it did.
		const pending = pendingPrompt(this.#context.messages);
		if (pending.some((message) => this.#unfinished.has(messageKey(message)))) throw new AcpError(NOT_RESENT);
		const seen = lastAnchor(this.#context.messages).anchor;
		this.draft.begin();
		let conversation = await this.#host.open(signal, seen);
		signal?.throwIfAborted();
		this.#conversation = conversation;
		const plan = planTurn(this.#context.messages, conversation.anchor);
		const hasPrompt = plan.prompt.length > 0;
		const running = conversation.session.turn !== undefined;
		const afterTools = this.#context.messages.at(-1)?.role === "toolResult";
		if (!hasPrompt && !plan.diverged && afterTools && !running) throw new AcpError(TURN_LOST);
		if (!hasPrompt && (plan.diverged || !running)) {
			this.draft.finish("stop");
			return;
		}
		if (hasPrompt) conversation = await this.#prompt(conversation, plan);
		const tools = getCurrentTools(this.#context.messages);
		const mirrored = tools.some((tool) => tool.name === TOOL_NAME);
		const { turn } = conversation.session;
		if (turn) await this.#relay(conversation, turn, mirrored);
	}

	/** Ends whatever the agent was doing and sends the new message, in a new session if the transcript diverged. */
	async #prompt(current: Conversation, first: TurnPlan): Promise<Conversation> {
		const { signal } = this.#options;
		const seen = lastAnchor(this.#context.messages).anchor;
		// Refuse what cannot be sent before stopping the turn in progress for it.
		promptBlocks(first, current.accepts);
		let conversation = current;
		if (!(await haltTurn(conversation.session, this.#host.cancelGraceMs))) {
			this.#host.abandon();
			conversation = await this.#host.open(signal, seen);
		} else if (first.diverged && conversation.session.turns > 0)
			conversation = await this.#host.restart(signal, seen);
		this.#conversation = conversation;
		const plan = planTurn(this.#context.messages, conversation.anchor);
		const prompt = promptBlocks(plan, conversation.accepts);
		const effort = await applyChoices(conversation.session, this.#model, this.#options.reasoning);
		if (effort !== undefined) this.draft.update({ providerThinkingLevel: effort });
		signal?.throwIfAborted();
		this.#sent = plan.prompt;
		conversation.startTurn(prompt);
		return conversation;
	}

	async #relay(active: Conversation, turn: Turn, mirrored: boolean) {
		for (;;) {
			const event = await turn.next(this.#options.signal);
			if (!event) throw new Aborted();
			if (event.type === "text") this.draft.append("text", event.text);
			else if (event.type === "thought") this.draft.append("thinking", event.text);
			else if (event.type === "tool" && !mirrored) this.#host.noteTool(event.tool);
			else if (event.type === "tool") return this.#mirror(active, turn, event.tool);
			else return this.#end(active, turn, event);
		}
	}

	/** Ends the message with the agent's tool calls, grouping those it started together. */
	async #mirror(active: Conversation, turn: Turn, first: ToolView) {
		const add = (tool: ToolView) => this.draft.call(active.mirror(tool), tool);
		add(first);
		await new Promise((resolve) => setTimeout(resolve, TOOL_BATCH_MS));
		for (let next = turn.takeTool(); next; next = turn.takeTool()) add(next);
		this.#stamp(active);
		this.draft.finish("toolUse");
	}

	#end(active: Conversation, turn: Turn, event: EndEvent) {
		active.session.endTurn(turn);
		this.#stamp(active);
		if (event.type === "failed") throw new AcpError(event.message);
		const usage = event.usage;
		this.draft.update({
			usage: {
				...this.draft.message.usage,
				input: usage?.inputTokens ?? 0,
				output: usage?.outputTokens ?? 0,
				cacheRead: usage?.cachedReadTokens ?? 0,
				cacheWrite: usage?.cachedWriteTokens ?? 0,
				...(typeof usage?.thoughtTokens === "number" ? { reasoning: usage.thoughtTokens } : {}),
			},
			rawStopReason: event.stopReason,
		});
		const reason = STOP[event.stopReason];
		if (reason === "aborted") throw new Aborted();
		if (reason === "error") throw new AcpError("Antigravity refused this request.");
		this.draft.finish(reason);
	}

	async #fail(error: unknown) {
		this.draft.close();
		const aborted = error instanceof Aborted || this.#options.signal?.aborted === true;
		const conversation = this.#conversation;
		if (aborted && conversation?.session.turn) {
			this.#stamp(conversation);
			if (!(await haltTurn(conversation.session, this.#host.cancelGraceMs))) this.#host.abandon();
		}
		if (!aborted) for (const sent of this.#sent) this.#unfinished.add(messageKey(sent));
		this.draft.fail(
			aborted ? "aborted" : "error",
			aborted
				? "Antigravity request cancelled."
				: error instanceof AcpError
					? error.message
					: `The Antigravity agent stopped unexpectedly (${reasonOf(error, "no reason given")}). Check that \`agy\` works in a terminal.`,
		);
	}
}

/** Identifies a user message across the copies Pi makes of its transcript, in constant space. */
function messageKey(message: UserMessage): string {
	const content = createHash("sha256").update(JSON.stringify(message.content)).digest("hex");
	return `${message.timestamp}:${content}`;
}

export function createStream(host: StreamHost) {
	const unfinished = new Set<string>();
	return (model: Model<string>, context: TranscriptContext, options: Request = {}) =>
		new Reply(host, model, context, options, unfinished).start();
}
