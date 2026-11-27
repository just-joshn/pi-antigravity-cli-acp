import {
	type ClientConnection,
	client,
	type InitializeRequest,
	type InitializeResponse,
	type LoadSessionResponse,
	type McpServer,
	methods,
	type NewSessionRequest,
	type NewSessionResponse,
	PROTOCOL_VERSION,
	RequestError,
	type SessionInfo,
	type Stream,
} from "@agentclientprotocol/sdk/unstable";

import { readTextFile, writeTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import { type Exchange, Inbox } from "./inbox.ts";
import { AcpSession, type AgentPort, type SessionHooks } from "./session.ts";
import { Terminals } from "./terminal.ts";

/** A failure the user can act on. Its message is shown as is. */
export class AcpError extends Error {}

/** The agent needs the user to sign in before it can start a session. */
export class SignInRequired extends AcpError {}

export interface SignInMethod {
	id: string;
	name: string;
	description: string | undefined;
}

const REASON_LIMIT = 300;

export function reasonOf(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message.slice(0, REASON_LIMIT) : fallback;
}

interface ClientIdentity {
	name: string;
	title: string;
	version: string;
}

const AUTH_REQUIRED = -32000;
const RESOURCE_NOT_FOUND = -32002;
const LIST_PAGES = 5;

export interface SavedSession {
	id: string;
	title: string | undefined;
	updatedAt: string | undefined;
}

function savedSession(info: SessionInfo): SavedSession {
	return {
		id: info.sessionId,
		title: info.title ?? undefined,
		updatedAt: info.updatedAt ?? undefined,
	};
}

function tierName(meta: unknown): string | undefined {
	if (!isRecord(meta)) return undefined;
	const { antigravity } = meta;
	if (!isRecord(antigravity)) return undefined;
	const { tier } = antigravity;
	if (!isRecord(tier)) return undefined;
	const { name } = tier;
	return typeof name === "string" ? name : undefined;
}

/** Both Antigravity servers also list each model once per thinking level, outside the typed schema. */
function modelVariants(created: unknown): string[] {
	if (!isRecord(created)) return [];
	const { models } = created;
	if (!isRecord(models)) return [];
	const { availableModels } = models;
	if (!Array.isArray(availableModels)) return [];
	return availableModels.flatMap((entry: unknown) => {
		if (!isRecord(entry)) return [];
		const { modelId } = entry;
		return typeof modelId === "string" ? [modelId] : [];
	});
}

function explain(action: string) {
	return (error: unknown): never => {
		if (error instanceof RequestError && error.code === AUTH_REQUIRED)
			throw new SignInRequired(
				"Antigravity needs you to sign in. Run `agy` in a terminal, sign in, then try again.",
			);
		throw new AcpError(`Antigravity could not ${action}: ${reasonOf(error, "the agent stopped")}`);
	};
}

function sessionCwd(sessions: ReadonlyMap<string, AcpSession>, sessionId: string): string {
	const session = sessions.get(sessionId);
	if (!session) throw RequestError.invalidParams(undefined, `no session ${sessionId}`);
	return session.cwd;
}

type ClientBuilder = ReturnType<typeof client>;

function serveTerminals(
	builder: ClientBuilder,
	sessions: ReadonlyMap<string, AcpSession>,
	terminals: Terminals,
): ClientBuilder {
	return builder
		.onRequest(methods.client.terminal.create, ({ params }) =>
			terminals.create(params, sessionCwd(sessions, params.sessionId)),
		)
		.onRequest(methods.client.terminal.output, ({ params }) => terminals.output(params.sessionId, params.terminalId))
		.onRequest(methods.client.terminal.waitForExit, ({ params }) =>
			terminals.waitForExit(params.sessionId, params.terminalId),
		)
		.onRequest(methods.client.terminal.kill, ({ params }) => terminals.kill(params.sessionId, params.terminalId))
		.onRequest(methods.client.terminal.release, ({ params }) =>
			terminals.release(params.sessionId, params.terminalId),
		);
}

interface Wiring {
	sessions: Map<string, AcpSession>;
	inbox: Inbox;
	hooks: SessionHooks;
	terminals: Terminals;
}

function serve(
	stream: Stream,
	identity: ClientIdentity,
	{ sessions, inbox, hooks, terminals }: Wiring,
): ClientConnection {
	return serveTerminals(client({ name: identity.name }), sessions, terminals)
		.onRequest(methods.client.session.requestPermission, ({ params }) => {
			const session = sessions.get(params.sessionId);
			return session ? session.permission(params) : { outcome: { outcome: "cancelled" } };
		})
		.onRequest(methods.client.elicitation.create, ({ params }) => {
			if ("sessionId" in params) {
				const session = sessions.get(String(params.sessionId));
				return session ? session.elicit(params) : { action: "cancel" };
			}
			// A question outside any session, such as during sign-in; it cannot be interrupted.
			return hooks.elicit(params, new AbortController().signal);
		})
		.onNotification(methods.client.elicitation.complete, () => {
			// Only says the agent finished with a link it showed; nothing in Pi waits for that.
		})
		.onRequest(methods.client.fs.readTextFile, ({ params }) => readTextFile(params))
		.onRequest(methods.client.fs.writeTextFile, ({ params }) =>
			writeTextFile(params, sessions.get(params.sessionId)?.workspaces ?? []),
		)
		.onNotification(methods.client.session.update, ({ params }) => {
			const session = sessions.get(params.sessionId);
			// Agents report usage before session/new returns; keep it until the session exists.
			if (session) session.receive(params.update);
			else inbox.hold(params.sessionId, params.update);
		})
		.connect(stream);
}

export interface Workspace {
	cwd: string;
	directories?: readonly string[];
	mcpServers?: readonly McpServer[];
}

type Introduced = Pick<AcpClient, "agent" | "accepts" | "offers" | "signInMethods">;

function introduced(hello: InitializeResponse): Introduced {
	const capabilities = hello.agentCapabilities;
	const sessionCapabilities = capabilities?.sessionCapabilities;
	const prompts = capabilities?.promptCapabilities;
	return {
		agent: {
			name: hello.agentInfo?.title ?? hello.agentInfo?.name ?? "ACP agent",
			version: hello.agentInfo?.version ?? "",
		},
		accepts: {
			image: prompts?.image === true,
			embeddedContext: prompts?.embeddedContext === true,
		},
		offers: {
			load: capabilities?.loadSession === true,
			close: Boolean(sessionCapabilities?.close),
			directories: Boolean(sessionCapabilities?.additionalDirectories),
			mcpHttp: capabilities?.mcpCapabilities?.http === true,
			logout: Boolean(capabilities?.auth?.logout),
			list: Boolean(sessionCapabilities?.list),
		},
		signInMethods: (hello.authMethods ?? []).flatMap((method) =>
			"type" in method ? [] : [{ id: method.id, name: method.name, description: method.description ?? undefined }],
		),
	};
}

export class AcpClient {
	readonly agent: { name: string; version: string };
	readonly accepts: { image: boolean; embeddedContext: boolean };
	readonly offers: {
		load: boolean;
		close: boolean;
		directories: boolean;
		mcpHttp: boolean;
		logout: boolean;
		list: boolean;
	};
	/** Sign-in methods the agent runs itself; terminal methods need a capability Pi does not offer. */
	readonly signInMethods: readonly SignInMethod[];
	#connection: ClientConnection;
	#terminals: Terminals;
	#sessions: Map<string, AcpSession>;
	#inbox: Inbox;
	#hooks: SessionHooks;

	private constructor(connection: ClientConnection, wiring: Wiring, hello: Introduced) {
		this.#connection = connection;
		this.#terminals = wiring.terminals;
		this.#sessions = wiring.sessions;
		this.#inbox = wiring.inbox;
		this.#hooks = wiring.hooks;
		this.agent = hello.agent;
		this.accepts = hello.accepts;
		this.offers = hello.offers;
		this.signInMethods = hello.signInMethods;
	}

	static async connect(stream: Stream, identity: ClientIdentity, hooks: SessionHooks): Promise<AcpClient> {
		const sessions = new Map<string, AcpSession>();
		const terminals = new Terminals((sessionId, terminalId, output) =>
			sessions.get(sessionId)?.terminalOutput(terminalId, output),
		);
		const wiring = { sessions, inbox: new Inbox(), hooks, terminals };
		const connection = serve(stream, identity, wiring);
		const introduction: InitializeRequest = {
			protocolVersion: PROTOCOL_VERSION,
			clientInfo: identity,
			clientCapabilities: {
				fs: { readTextFile: true, writeTextFile: true },
				terminal: true,
				elicitation: { form: {}, url: {} },
				plan: {},
			},
		};
		const hello = await connection.agent.request(methods.agent.initialize, introduction).catch((error: unknown) => {
			connection.close();
			return explain("start")(error);
		});
		if (hello.protocolVersion !== PROTOCOL_VERSION) {
			connection.close();
			throw new AcpError(
				`This Antigravity agent speaks ACP version ${hello.protocolVersion}; this extension speaks version ${PROTOCOL_VERSION}.`,
			);
		}
		return new AcpClient(connection, wiring, introduced(hello));
	}

	/** Resolves when the connection ends, for whatever reason. */
	get closed(): Promise<void> {
		return this.#connection.closed;
	}

	/** Whether the agent can be given `server`: stdio servers always, HTTP ones if it says so. */
	takes(server: McpServer): boolean {
		return this.offers.mcpHttp || !("type" in server);
	}

	#place(where: Workspace): NewSessionRequest {
		const mcpServers = (where.mcpServers ?? []).filter((server) => this.takes(server));
		const directories = where.directories ?? [];
		return {
			cwd: where.cwd,
			mcpServers,
			...(this.offers.directories && directories.length ? { additionalDirectories: [...directories] } : {}),
		};
	}

	async newSession(where: Workspace): Promise<AcpSession> {
		const placed = this.#place(where);
		const created = await this.#connection.agent
			.request(methods.agent.session.new, placed)
			.catch(explain("start a session"));
		return this.#adopt(created.sessionId, created, placed, 0);
	}

	/**
	 * Reopens a saved agent session, with its prompt turns counted from the agent's replay.
	 * Resolves with undefined when the agent cannot load sessions or no longer has this one.
	 */
	async loadSession(sessionId: string, where: Workspace): Promise<AcpSession | undefined> {
		return (await this.#load(sessionId, where, false))?.session;
	}

	async readTranscript(sessionId: string, where: Workspace): Promise<readonly Exchange[] | undefined> {
		const loaded = await this.#load(sessionId, where, true);
		if (!loaded) return undefined;
		// Closing frees the agent's memory; a session left open costs nothing visible.
		await this.closeSession(sessionId).catch(() => undefined);
		return loaded.exchanges;
	}

	/** The agent's saved conversations for `cwd`, newest first as the agent lists them. */
	async listSessions(cwd: string): Promise<SavedSession[]> {
		return this.offers.list ? this.#listPages(cwd, undefined, LIST_PAGES) : [];
	}

	/** The sessions on this page and those after it, up to `pages` pages; each page names the next. */
	async #listPages(cwd: string, cursor: string | undefined, pages: number): Promise<SavedSession[]> {
		const listed = await this.#connection.agent
			.request(methods.agent.session.list, { cwd, ...(cursor ? { cursor } : {}) })
			.catch(explain("list its sessions"));
		const found = listed.sessions.map(savedSession);
		const next = listed.nextCursor ?? undefined;
		return next && pages > 1 ? [...found, ...(await this.#listPages(cwd, next, pages - 1))] : found;
	}

	async #load(sessionId: string, where: Workspace, keepText: boolean) {
		if (!this.offers.load) return undefined;
		const placed = this.#place(where);
		this.#inbox.startReplay(sessionId, keepText);
		const loaded = await this.#connection.agent
			.request(methods.agent.session.load, { sessionId, ...placed })
			.catch((error: unknown) => {
				this.#inbox.endReplay(sessionId);
				this.#inbox.take(sessionId);
				if (error instanceof RequestError && error.code === RESOURCE_NOT_FOUND) return undefined;
				return explain("reopen the saved session")(error);
			});
		if (!loaded) return undefined;
		const replay = this.#inbox.endReplay(sessionId);
		const session = this.#adopt(sessionId, loaded, placed, replay?.turns ?? 0);
		return { session, exchanges: replay?.exchanges ?? [] };
	}

	async signIn(methodId: string): Promise<void> {
		await this.#connection.agent.request(methods.agent.authenticate, { methodId }).catch(explain("sign in"));
	}

	async logOut(): Promise<void> {
		await this.#connection.agent.request(methods.agent.logout, {}).catch(explain("sign out"));
	}

	async closeSession(sessionId: string): Promise<void> {
		this.#terminals.releaseSession(sessionId);
		this.#sessions.delete(sessionId);
		this.#inbox.take(sessionId);
		if (!this.offers.close) return;
		await this.#connection.agent
			.request(methods.agent.session.close, { sessionId })
			.catch(explain("close a session"));
	}

	#adopt(
		sessionId: string,
		opened: NewSessionResponse | LoadSessionResponse,
		placed: NewSessionRequest,
		turns: number,
	): AcpSession {
		const { agent } = this.#connection;
		const port: AgentPort = {
			prompt: (id, prompt) => agent.request(methods.agent.session.prompt, { sessionId: id, prompt }),
			cancel: (id) => agent.notify(methods.agent.session.cancel, { sessionId: id }),
			setConfigOption: async (id, configId, value) => {
				const reply = await agent
					.request(methods.agent.session.setConfigOption, { sessionId: id, configId, value })
					.catch(explain(`change ${configId}`));
				return reply.configOptions;
			},
		};
		const session = new AcpSession(
			sessionId,
			{
				options: opened.configOptions ?? [],
				tier: tierName(opened._meta),
				variants: modelVariants(opened),
				cwd: placed.cwd,
				directories: placed.additionalDirectories ?? [],
				turns,
			},
			port,
			this.#hooks,
		);
		this.#sessions.set(session.id, session);
		for (const update of this.#inbox.take(session.id)) session.receive(update);
		return session;
	}

	close() {
		this.#terminals.releaseAll();
		this.#connection.close();
	}
}
