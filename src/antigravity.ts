import { type ExtensionAPI, type ExtensionContext, VERSION } from "@earendil-works/pi-coding-agent";

import { launch, type RunningAgent, resolveAgent } from "./agent.ts";
import { type Catalog, learn, PROVIDER, piModels, readCatalog, writeCatalog } from "./catalog.ts";
import { AcpClient, SignInRequired, type Workspace } from "./client.ts";
import { Conversation, parseAnchor } from "./conversation.ts";
import { answerElicitation } from "./elicit.ts";
import { readFlags } from "./flags.ts";
import { pick } from "./pick.ts";
import { planLines } from "./plan.ts";
import type { AcpSession, SessionHooks } from "./session.ts";
import { signIn } from "./sign-in.ts";
import { createStream, haltTurn, lastAnchor } from "./stream.ts";
import { choiceLabels, TOOL_NAME, toolArguments } from "./tool.ts";
import { workspaceFor } from "./workspace.ts";

const STARTUP_TIMEOUT_MS = 30_000;
const STATUS = "antigravity";
const PLAN = "antigravity-plan";
export const selected = (ctx: ExtensionContext | undefined) => ctx?.model?.provider === PROVIDER;

export function noSuchMode(wanted: string, session: AcpSession): string {
	const offered = session.choices("mode").map((mode) => mode.value);
	const available = offered.length ? ` Available: ${offered.join(", ")}.` : "";
	return `Antigravity has no "${wanted}" mode.${available}`;
}

type Host = Pick<ExtensionAPI, "getFlag" | "getActiveTools" | "setActiveTools" | "registerProvider">;

export class Antigravity {
	#pi: Host;
	#catalogFile: string;
	#catalog: Catalog;
	/** The catalog as last saved, kept to tell whether a session changed it without saving again. */
	#savedCatalog: string;
	#published = "";
	#pane: ExtensionContext | undefined;
	#running = false;
	#wantedMode: string | undefined;
	#agent: RunningAgent | undefined;
	#client: Promise<AcpClient> | undefined;
	#opening: Promise<Conversation> | undefined;
	#openingAbort: AbortController | undefined;
	#live: Conversation | undefined;
	/** The plan widget's lines as last shown, to skip redrawing an unchanged plan. */
	#shownPlan = "null";
	/** The previous permission dialog; the agent can ask about several tool calls at once. */
	#asking: Promise<unknown> = Promise.resolve();
	#stream = createStream({
		conversing: (piSessionId) =>
			this.#running && piSessionId !== undefined && piSessionId === this.#pane?.sessionManager.getSessionId(),
		open: (signal, anchor) => this.open(anchor, signal),
		restart: async (signal, anchor) => {
			const replaced = this.#live?.session.id;
			this.#openingAbort?.abort(new Error("Antigravity session was replaced."));
			this.#opening = undefined;
			this.#live = undefined;
			// Pi rewound inside the session being replaced, which went on past that point.
			const reopen = anchor !== undefined && parseAnchor(anchor)?.sessionId === replaced ? undefined : anchor;
			const [conversation] = await Promise.all([
				this.open(reopen, signal),
				replaced === undefined ? undefined : this.#close(replaced),
			]);
			return conversation;
		},
		abandon: () => this.#lose(),
		noteTool: (tool) => {
			const { kind, title } = toolArguments(tool);
			this.#pane?.ui.notify(`Antigravity ${kind}: ${title}`, "info");
		},
	});

	constructor(pi: Host, catalogFile: string) {
		this.#pi = pi;
		this.#catalogFile = catalogFile;
		this.#catalog = readCatalog(catalogFile);
		this.#savedCatalog = JSON.stringify(this.#catalog);
	}

	get live() {
		return this.#live;
	}

	get modes() {
		return this.#catalog.modes;
	}

	get commands() {
		return this.#live?.session.commands ?? this.#catalog.commands;
	}

	get selected() {
		return selected(this.#pane);
	}

	async agentInfo() {
		return (await this.#client)?.agent;
	}

	/** Registers the provider, again only when the agent's model list changed. */
	publish() {
		const models = piModels(this.#catalog);
		const key = JSON.stringify(models);
		if (key === this.#published) return;
		this.#published = key;
		this.#pi.registerProvider({
			id: PROVIDER,
			name: "Antigravity (ACP)",
			auth: {
				apiKey: {
					name: "Signed in through the Antigravity agent",
					resolve: () => Promise.resolve({ auth: {}, source: "Antigravity agent" }),
				},
			},
			getModels: () => models,
			stream: this.#stream,
			streamSimple: this.#stream,
		});
	}

	sessionStarted(ctx: ExtensionContext) {
		this.#pane = ctx;
		const { mode } = readFlags(this.#pi);
		if (mode !== undefined) this.#wantedMode = mode;
		this.#syncTool();
		this.#showStatus();
	}

	modelSelected(ctx: ExtensionContext) {
		this.#pane = ctx;
		this.#syncTool();
		this.#showStatus();
	}

	runStarted(ctx: ExtensionContext) {
		this.#pane = ctx;
		this.#running = true;
	}

	async runEnded(ctx: ExtensionContext) {
		this.#pane = ctx;
		this.#running = false;
		// Pi can end a run while mirrored tools are still pending; the agent must not keep working unseen.
		if (this.#live?.session.turn && !(await haltTurn(this.#live.session))) this.#lose();
		this.publish();
	}

	commandStarted(ctx: ExtensionContext) {
		this.#pane = ctx;
	}

	shutdown() {
		this.#forget();
	}

	modeChosen(id: string) {
		this.#wantedMode = id;
		this.#showStatus();
	}

	/** The agent session in use, reopening the one Pi's current transcript left off in, if any. */
	openFor(ctx: ExtensionContext): Promise<Conversation> {
		const messages = ctx.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
		return this.open(lastAnchor(messages).anchor);
	}

	/** The agent session in use; the first call reopens the one at `anchor` when it is still there. */
	open(anchor?: string, signal?: AbortSignal): Promise<Conversation> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (this.#opening) return this.#wait(this.#opening, signal);
		const abort = new AbortController();
		this.#openingAbort = abort;
		const cancel = () => abort.abort(signal?.reason);
		signal?.addEventListener("abort", cancel, { once: true });
		const timer = setTimeout(() => abort.abort(new Error("Antigravity startup timed out.")), STARTUP_TIMEOUT_MS);
		const opening = this.#wait(this.#start(anchor, abort.signal), abort.signal)
			.catch((error: unknown) => {
				if (this.#opening === opening) this.#lose();
				throw error;
			})
			.finally(() => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", cancel);
				if (this.#openingAbort === abort) this.#openingAbort = undefined;
			});
		this.#opening = opening;
		return opening;
	}

	#wait<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
		if (!signal) return work;
		if (signal.aborted) return Promise.reject(signal.reason);
		let abort: () => void;
		return new Promise<T>((resolve, reject) => {
			abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			void work.then(resolve, reject);
		}).finally(() => signal.removeEventListener("abort", abort));
	}

	#showStatus() {
		const pane = this.#pane;
		if (!pane?.hasUI) return;
		const mode = this.#live?.session.current("mode") ?? this.#wantedMode;
		pane.ui.setStatus(STATUS, selected(pane) && mode ? `agy mode: ${mode}` : undefined);
		this.#showPlan(pane);
	}

	#showPlan(pane: ExtensionContext) {
		const lines = selected(pane) ? planLines(this.#live?.session.plan) : undefined;
		const shown = JSON.stringify(lines ?? null);
		if (shown === this.#shownPlan) return;
		this.#shownPlan = shown;
		pane.ui.setWidget(PLAN, lines);
	}

	#syncTool() {
		const active = this.#pi.getActiveTools();
		const declared = active.includes(TOOL_NAME);
		const wanted = selected(this.#pane);
		if (wanted && !declared) this.#pi.setActiveTools([...active, TOOL_NAME]);
		else if (!wanted && declared) this.#pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
	}

	#absorb(conversation: Conversation) {
		const next = learn(this.#catalog, conversation.session);
		const serialized = JSON.stringify(next);
		if (serialized === this.#savedCatalog) return;
		this.#catalog = next;
		this.#savedCatalog = serialized;
		try {
			writeCatalog(this.#catalogFile, next);
		} catch {
			// The catalog is a cache; without it the model list is rebuilt from the next session.
		}
		if (!this.#running) this.publish();
	}

	#dialog<T>(show: () => Promise<T>): Promise<T> {
		const shown = this.#asking.then(show);
		this.#asking = shown.catch(() => {});
		return shown;
	}

	#hooks: SessionHooks = {
		askPermission: (tool, options, signal) =>
			this.#dialog(async () => {
				const pane = this.#pane;
				if (signal.aborted || !pane?.hasUI) return undefined;
				const { kind, title } = toolArguments(tool);
				const question = `Antigravity asks permission · ${kind}: ${title}`;
				return pick(pane.ui, question, options, choiceLabels(options), signal);
			}),
		elicit: (request, signal) =>
			this.#dialog(async () => {
				const pane = this.#pane;
				if (!pane?.hasUI) return { action: "cancel" };
				return answerElicitation(request, pane.ui, signal);
			}),
		changed: () => {
			if (this.#live) this.#absorb(this.#live);
			this.#showStatus();
		},
	};

	#forget(abortOpening = true) {
		if (abortOpening) this.#openingAbort?.abort(new Error("Antigravity connection closed."));
		this.#openingAbort = undefined;
		const connected = this.#client;
		this.#live?.session.dispose();
		this.#agent?.stop();
		this.#agent = undefined;
		this.#client = undefined;
		this.#opening = undefined;
		this.#live = undefined;
		void connected?.then(
			(c) => c.close(),
			() => {},
		);
	}

	#lose() {
		this.#forget();
		this.#showStatus();
	}

	async #connect(): Promise<AcpClient> {
		const cwd = this.#pane?.cwd ?? process.cwd();
		const started = launch(resolveAgent(readFlags(this.#pi).agent), cwd);
		this.#agent = started;
		const identity = { name: "pi", title: "Pi", version: VERSION };
		const connected = await AcpClient.connect(started.stream, identity, this.#hooks);
		if (this.#agent !== started) {
			connected.close();
			throw new Error("Antigravity connection was replaced.");
		}
		const ended = () => {
			if (this.#agent === started) this.#lose();
		};
		void connected.closed.then(ended, ended);
		return connected;
	}

	async #close(sessionId: string) {
		const connected = await this.#client;
		// Closing frees the live session; it does not delete the saved conversation.
		await connected?.closeSession(sessionId).catch(() => {});
	}

	async #reopen(connected: AcpClient, anchor: string, where: Workspace) {
		const at = parseAnchor(anchor);
		const session = at && (await connected.loadSession(at.sessionId, where));
		if (!session) return undefined;
		if (session.turns === at.turns) return new Conversation(session, connected.accepts, anchor);
		// The agent has prompts this transcript never saw; continuing would mix the two conversations.
		await connected.closeSession(session.id).catch(() => {});
		return undefined;
	}

	/** The connection to the agent, starting the agent if needed, without opening a session. */
	connected(): Promise<AcpClient> {
		if (this.#client) return this.#client;
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(new Error("Antigravity startup timed out.")), STARTUP_TIMEOUT_MS);
		const connected = this.#wait(this.#connect(), deadline.signal)
			.catch((error: unknown) => {
				if (this.#client === connected) this.#forget(false);
				throw error;
			})
			.finally(() => clearTimeout(timer));
		this.#client = connected;
		return connected;
	}

	disconnect() {
		this.#lose();
	}

	async #begin(connected: AcpClient, anchor: string | undefined, where: Workspace) {
		return (
			(anchor && (await this.#reopen(connected, anchor, where))) ||
			new Conversation(await connected.newSession(where), connected.accepts)
		);
	}

	async #start(anchor: string | undefined, signal: AbortSignal): Promise<Conversation> {
		const connected = await this.connected();
		signal.throwIfAborted();
		const pane = this.#pane;
		const trusted = pane?.isProjectTrusted() ?? false;
		const { where, notes } = workspaceFor(this.#pi, pane?.cwd ?? process.cwd(), trusted);
		for (const note of notes) this.#pane?.ui.notify(note, "warning");
		for (const server of where.mcpServers ?? [])
			if (!connected.takes(server))
				this.#pane?.ui.notify(
					`MCP server ${server.name}: this agent takes no HTTP servers; it does not get it.`,
					"warning",
				);
		const conversation = await this.#begin(connected, anchor, where).catch(async (error: unknown) => {
			signal.throwIfAborted();
			const title = "Antigravity needs you to sign in";
			if (!(error instanceof SignInRequired) || !(await signIn(connected, this.#pane, title, signal))) throw error;
			signal.throwIfAborted();
			return this.#begin(connected, anchor, where);
		});
		const { session } = conversation;
		try {
			signal.throwIfAborted();
			const wanted = this.#wantedMode;
			const mode = wanted === undefined ? undefined : await session.select("mode", wanted);
			signal.throwIfAborted();
			if (wanted !== undefined && mode === "unavailable") {
				this.#pane?.ui.notify(noSuchMode(wanted, session), "warning");
				this.#wantedMode = undefined;
			}
		} catch (error) {
			session.dispose();
			void connected.closeSession(session.id).catch(() => {});
			throw error;
		}
		this.#live = conversation;
		this.#absorb(this.#live);
		this.#showStatus();
		return this.#live;
	}
}
