import { join } from "node:path";

import { agent, methods, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk/unstable";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";

import * as processAgent from "../src/agent.ts";
import { Antigravity } from "../src/antigravity.ts";
import { pair } from "./support/harness.ts";
import { scratchDir } from "./support/scratch.ts";

const hello = { protocolVersion: PROTOCOL_VERSION };

async function fixture(handlers: {
	initialize: () => Promise<typeof hello>;
	session: () => Promise<{ sessionId: string }>;
}) {
	const scratch = await scratchDir("startup");
	const streams = pair();
	const server = agent({ name: "test" })
		.onRequest(methods.agent.initialize, handlers.initialize)
		.onRequest(methods.agent.session.new, handlers.session)
		.connect(streams.agentSide);
	const stop = vi.fn(() => server.close());
	vi.spyOn(processAgent, "resolveAgent").mockReturnValue({ command: "test", args: [] });
	vi.spyOn(processAgent, "launch").mockReturnValue({ stream: streams.clientSide, stop });
	const pi = {
		getFlag: () => undefined,
		getActiveTools: () => [],
		setActiveTools: () => {},
		registerProvider: () => {},
	};
	const link = new Antigravity(pi, join(scratch, "catalog.json"));
	onTestFinished(() => link.shutdown());
	return { link, stop };
}

async function signInFixture(beforeSignInMs = 0) {
	const scratch = await scratchDir("startup-auth");
	const streams = pair();
	const choice = Promise.withResolvers<string | undefined>();
	const shown = Promise.withResolvers<void>();
	const firstRequest = Promise.withResolvers<void>();
	const authenticating = Promise.withResolvers<void>();
	const retried = Promise.withResolvers<void>();
	const authentication = Promise.withResolvers<object>();
	const retry = Promise.withResolvers<{ sessionId: string }>();
	let requests = 0;
	const server = agent({ name: "test" })
		.onRequest(methods.agent.initialize, () => ({ ...hello, authMethods: [{ id: "login", name: "Login" }] }))
		.onRequest(methods.agent.authenticate, () => {
			authenticating.resolve();
			return authentication.promise;
		})
		.onRequest(methods.agent.session.new, async () => {
			if (++requests === 1) {
				firstRequest.resolve();
				if (beforeSignInMs) await new Promise<void>((resolve) => setTimeout(resolve, beforeSignInMs));
				throw new RequestError(-32000, "Authentication required");
			}
			retried.resolve();
			return retry.promise;
		})
		.connect(streams.agentSide);
	const stop = vi.fn(() => server.close());
	vi.spyOn(processAgent, "resolveAgent").mockReturnValue({ command: "test", args: [] });
	vi.spyOn(processAgent, "launch").mockReturnValue({ stream: streams.clientSide, stop });
	const link = new Antigravity(
		{ getFlag: () => undefined, getActiveTools: () => [], setActiveTools: () => {}, registerProvider: () => {} },
		join(scratch, "catalog.json"),
	);
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: scratch,
		agentDir: scratch,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: scratch,
		agentDir: scratch,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(scratch),
	});
	const runner = session.extensionRunner;
	runner.setUIContext(
		{
			...runner.getUIContext(),
			select: () => {
				shown.resolve();
				return choice.promise;
			},
		},
		"tui",
	);
	link.commandStarted(runner.createContext());
	onTestFinished(() => {
		choice.resolve(undefined);
		authentication.resolve({});
		retry.resolve({ sessionId: "late" });
		link.shutdown();
		session.dispose();
	});
	return { link, stop, shown, choice, firstRequest, authenticating, authentication, retried, retry };
}

afterEach(() => vi.useRealTimers());

test("sign-in choice and authentication do not consume the startup deadline", async () => {
	const { link, stop, shown, choice, authenticating, authentication, retry } = await signInFixture();
	vi.useFakeTimers();
	const opening = link.open();
	await shown.promise;
	await vi.advanceTimersByTimeAsync(60_000);
	expect(stop).not.toHaveBeenCalled();
	choice.resolve("Login");
	await authenticating.promise;
	await vi.advanceTimersByTimeAsync(60_000);
	expect(stop).not.toHaveBeenCalled();
	authentication.resolve({});
	retry.resolve({ sessionId: "signed-in" });
	expect((await opening).session.id).toBe("signed-in");
});

test.each(["choice", "authentication"])(
	"owner abort during %s stops startup and rejects late results",
	async (phase) => {
		const { link, stop, shown, choice, authenticating, authentication, retry } = await signInFixture();
		const owner = new AbortController();
		const opening = link.open(undefined, owner.signal);
		await shown.promise;
		if (phase === "authentication") {
			choice.resolve("Login");
			await authenticating.promise;
		}
		owner.abort();
		await expect(opening).rejects.toMatchObject({ name: "AbortError" });
		expect(stop).toHaveBeenCalledOnce();
		choice.resolve("Login");
		authentication.resolve({});
		retry.resolve({ sessionId: "late" });
		await Promise.resolve();
		expect(link.live).toBeUndefined();
	},
);

test("a post-authentication retry only gets the remaining machine budget", async () => {
	const { link, stop, shown, choice, firstRequest, authenticating, authentication, retried } =
		await signInFixture(5_000);
	vi.useFakeTimers();
	const opening = expect(link.open()).rejects.toThrow("startup timed out");
	await firstRequest.promise;
	await vi.advanceTimersByTimeAsync(5_000);
	await shown.promise;
	choice.resolve("Login");
	await authenticating.promise;
	authentication.resolve({});
	await retried.promise;
	await vi.advanceTimersByTimeAsync(24_999);
	expect(stop).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	await opening;
	expect(stop).toHaveBeenCalledOnce();
	expect(link.live).toBeUndefined();
});

test("a joined abort during sign-in leaves the owner running", async () => {
	const { link, stop, shown, choice, authenticating, authentication, retry } = await signInFixture();
	const opening = link.open();
	await shown.promise;
	const controller = new AbortController();
	const joined = link.open(undefined, controller.signal);
	controller.abort();
	await expect(joined).rejects.toMatchObject({ name: "AbortError" });
	expect(stop).not.toHaveBeenCalled();
	choice.resolve("Login");
	await authenticating.promise;
	authentication.resolve({});
	retry.resolve({ sessionId: "owner" });
	expect((await opening).session.id).toBe("owner");
});

test("shutdown during authentication stops the owner without publishing a late session", async () => {
	const { link, stop, shown, choice, authenticating, authentication, retry } = await signInFixture();
	const opening = link.open();
	await shown.promise;
	choice.resolve("Login");
	await authenticating.promise;
	link.shutdown();
	await expect(opening).rejects.toThrow("connection closed");
	authentication.resolve({});
	retry.resolve({ sessionId: "late" });
	await Promise.resolve();
	expect(stop).toHaveBeenCalledOnce();
	expect(link.live).toBeUndefined();
});

test("a timed out startup can retry with a new agent", async () => {
	const started = Promise.withResolvers<void>();
	const response = Promise.withResolvers<typeof hello>();
	const { link, stop } = await fixture({
		initialize: () => {
			started.resolve();
			return response.promise;
		},
		session: async () => ({ sessionId: "unused" }),
	});
	vi.useFakeTimers();
	const opening = expect(link.open()).rejects.toThrow("timed out");
	await started.promise;
	await vi.advanceTimersByTimeAsync(30_000);
	await opening;
	expect(stop).toHaveBeenCalledOnce();
	const streams = pair();
	const server = agent({ name: "retry" })
		.onRequest(methods.agent.initialize, () => hello)
		.onRequest(methods.agent.session.new, () => ({ sessionId: "fresh" }))
		.connect(streams.agentSide);
	vi.mocked(processAgent.launch).mockReturnValueOnce({ stream: streams.clientSide, stop: () => server.close() });
	expect((await link.open()).session.id).toBe("fresh");
	response.resolve(hello);
});

test("aborting initialization stops the owned agent", async () => {
	const started = Promise.withResolvers<void>();
	const response = Promise.withResolvers<typeof hello>();
	const { link, stop } = await fixture({
		initialize: () => {
			started.resolve();
			return response.promise;
		},
		session: async () => ({ sessionId: "unused" }),
	});
	const controller = new AbortController();
	const opening = link.open(undefined, controller.signal);
	await started.promise;
	controller.abort();
	await expect(opening).rejects.toMatchObject({ name: "AbortError" });
	expect(stop).toHaveBeenCalledOnce();
	response.resolve(hello);
});

test("a stalled initialization times out and stops its agent", async () => {
	const started = Promise.withResolvers<void>();
	const response = Promise.withResolvers<typeof hello>();
	const { link, stop } = await fixture({
		initialize: () => {
			started.resolve();
			return response.promise;
		},
		session: async () => ({ sessionId: "unused" }),
	});
	vi.useFakeTimers();
	const rejected = expect(link.open()).rejects.toThrow("timed out");
	await started.promise;
	await vi.advanceTimersByTimeAsync(30_000);
	await rejected;
	expect(stop).toHaveBeenCalledOnce();
	response.resolve(hello);
});

test.each([false, true])("abort closes a stalled session request (already initialized: %s)", async (initialized) => {
	const started = Promise.withResolvers<void>();
	const response = Promise.withResolvers<{ sessionId: string }>();
	const { link, stop } = await fixture({
		initialize: async () => hello,
		session: () => {
			started.resolve();
			return response.promise;
		},
	});
	if (initialized) await link.connected();
	const controller = new AbortController();
	const opening = link.open(undefined, controller.signal);
	await started.promise;
	controller.abort();
	await expect(opening).rejects.toMatchObject({ name: "AbortError" });
	expect(stop).toHaveBeenCalledOnce();
	expect(link.live).toBeUndefined();
	response.resolve({ sessionId: "old" });
});

test.each(["new", "load"])("a stalled session %s times out", async (kind) => {
	const scratch = await scratchDir("startup-session");
	const streams = pair();
	const started = Promise.withResolvers<void>();
	const response = Promise.withResolvers<{ sessionId: string }>();
	const loaded = Promise.withResolvers<void>();
	const server = agent({ name: "test" })
		.onRequest(methods.agent.initialize, () => ({ ...hello, agentCapabilities: { loadSession: true } }))
		.onRequest(methods.agent.session.new, () => {
			started.resolve();
			return response.promise;
		})
		.onRequest(methods.agent.session.load, () => {
			started.resolve();
			return loaded.promise;
		})
		.connect(streams.agentSide);
	const stop = vi.fn(() => server.close());
	vi.spyOn(processAgent, "resolveAgent").mockReturnValue({ command: "test", args: [] });
	vi.spyOn(processAgent, "launch").mockReturnValue({ stream: streams.clientSide, stop });
	const link = new Antigravity(
		{ getFlag: () => undefined, getActiveTools: () => [], setActiveTools: () => {}, registerProvider: () => {} },
		join(scratch, "catalog.json"),
	);
	onTestFinished(() => {
		response.resolve({ sessionId: "late" });
		loaded.resolve();
		link.shutdown();
	});
	vi.useFakeTimers();
	const opening = expect(link.open(kind === "load" ? "old/0.0" : undefined)).rejects.toThrow("timed out");
	await started.promise;
	await vi.advanceTimersByTimeAsync(30_000);
	await opening;
	expect(stop).toHaveBeenCalledOnce();
	expect(link.live).toBeUndefined();
});

test("a caller can stop waiting for a shared startup without stopping it for the owner", async () => {
	const response = Promise.withResolvers<{ sessionId: string }>();
	const { link, stop } = await fixture({ initialize: async () => hello, session: () => response.promise });
	const opening = link.open();
	const controller = new AbortController();
	const joined = link.open(undefined, controller.signal);
	controller.abort();
	await expect(joined).rejects.toMatchObject({ name: "AbortError" });
	response.resolve({ sessionId: "shared" });
	expect((await opening).session.id).toBe("shared");
	expect(stop).not.toHaveBeenCalled();
});
