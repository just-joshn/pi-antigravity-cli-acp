import { join } from "node:path";

import { agent, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/unstable";
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

afterEach(() => vi.useRealTimers());

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
