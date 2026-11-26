/** A real Pi session with this extension loaded, talking to the scripted `agy`. */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionCommandContextActions,
	type ExtensionUIContext,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, onTestFinished, vi } from "vitest";

import { emptyCatalog, piModels } from "../../src/catalog.ts";
import { isRecord } from "../../src/guards.ts";
import antigravityAcp from "../../src/index.ts";
import type { AgentLog } from "./fake-agent.ts";
import { answering, recorder } from "./record.ts";
import { scratchDir } from "./scratch.ts";

const fakeAgy = join(import.meta.dirname, "fake-agy.ts");
type ProcessLog = AgentLog & { argv: string[]; cwd: string };

function isProcessLog(value: unknown): value is ProcessLog {
	return isRecord(value) && "prompts" in value && "argv" in value;
}

export const said = (message: AssistantMessage | undefined) =>
	(message?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");

/** The scripted agents' saved conversations in a scratch HOME: prompts by agent session id. */
export async function agentStore(home: string): Promise<Record<string, unknown[]>> {
	const saved: unknown = JSON.parse(await readFile(join(home, "agy-sessions.json"), "utf8"));
	if (!isRecord(saved)) throw new Error("the scripted agents' store is not an object");
	const listed = Object.entries(saved).map(([id, prompts]): [string, unknown[]] => [
		id,
		Array.isArray(prompts) ? prompts : [],
	]);
	return Object.fromEntries(listed);
}

/** A prompt as the agent received it: its text, with other blocks shown by type. */
export const texts = (prompt: { type: string; text?: string }[] | undefined) =>
	(prompt ?? []).map((block) => (block.type === "text" ? block.text : `[${block.type}]`));

const refuse = () => {
	throw new Error("the other provider is not called in these tests");
};

/** Another provider, so a test can switch away from Antigravity. */
function otherProvider(pi: ExtensionAPI) {
	const [model] = piModels(emptyCatalog);
	expect.assert(model);
	pi.registerProvider({
		id: "other",
		name: "Other",
		auth: {
			apiKey: { name: "none", resolve: () => Promise.resolve({ auth: {}, source: "test" }) },
		},
		getModels: () => [{ ...model, provider: "other", id: "other-model", name: "Other" }],
		stream: refuse,
		streamSimple: refuse,
	});
}

/** A UI that answers dialogs from a list and records what the extension showed. */
export function fakeUi(answers: readonly (string | undefined)[] = []) {
	const next = answering(answers);
	const notes = recorder<string>();
	const dialogs = recorder<{ title: string; options: string[] }>();
	const statuses = recorder<[key: string, text: string | undefined]>();
	const widgets = recorder<[key: string, lines: unknown]>();
	const ui: Partial<ExtensionUIContext> = {
		select(title, options) {
			dialogs.record({ title, options });
			return Promise.resolve(next());
		},
		notify: (message, type) => notes.record(`${type ?? "info"}: ${message}`),
		setStatus: (key, text) => statuses.record([key, text]),
		setWidget: (key: string, content: unknown) => widgets.record([key, content]),
	};
	/** The last status the extension set under `key`. */
	const status = (key: string) => statuses.all().findLast(([shown]) => shown === key)?.[1];
	return { ui, notes: notes.all, dialogs: dialogs.all, status, widgets: widgets.all };
}

interface StartOptions {
	agy?: boolean;
	/** Dialogs and notices; Pi's no-op UI supplies everything else. */
	ui?: Partial<ExtensionUIContext>;
	flags?: Record<string, string | boolean>;
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
	/** Start the scripted agent without a tier, settings or context usage. */
	plain?: boolean;
	/** Reuse the scratch HOME of an earlier start, with its saved Pi and agent sessions. */
	home?: string;
	/** Pi's newSession for commands; without it, the SDK's does nothing. */
	newSession?: ExtensionCommandContextActions["newSession"];
	/** Prepares the scratch HOME before Pi starts, for example with config files. */
	setup?: (home: string) => Promise<void>;
	/** A session the scripted agent lists but cannot load. */
	ghost?: string;
	/** Start the scripted agent signed out. */
	signedOut?: boolean;
	/** Start the scripted agent without session/load and session/close. */
	restore?: boolean;
}

/** Puts the scripted `agy` on the PATH of a scratch HOME. */
export async function installAgy(home: string) {
	const script = `#!/bin/sh\nexec "${process.execPath}" "${fakeAgy}" "$@"\n`;
	await writeFile(join(home, "bin", "agy"), script, { mode: 0o755 });
}

/** A scratch HOME whose PATH holds only the scripted `agy`, away from any editor-installed agent. */
async function scratchHome(options: StartOptions) {
	const dir = options.home ?? (await scratchDir("ext"));
	const [work, bin, agentDir] = [join(dir, "work"), join(dir, "bin"), join(dir, "pi")];
	const logFile = join(dir, `agent-log-${randomUUID()}.json`);
	await Promise.all([mkdir(work, { recursive: true }), mkdir(bin, { recursive: true })]);
	await options.setup?.(dir);
	if (options.agy ?? true) await installAgy(dir);
	vi.stubEnv("PATH", bin);
	vi.stubEnv("HOME", dir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("FAKE_AGY_LOG", logFile);
	vi.stubEnv("FAKE_AGY_PLAIN", options.plain ? "1" : "0");
	vi.stubEnv("FAKE_AGY_SIGNED_OUT", options.signedOut ? "1" : "0");
	vi.stubEnv("FAKE_AGY_RESTORE", options.restore === false ? "0" : "1");
	vi.stubEnv("FAKE_AGY_STORE", join(dir, "agy-sessions.json"));
	vi.stubEnv("FAKE_AGY_GHOST", options.ghost ?? "");
	onTestFinished(() => {
		vi.unstubAllEnvs();
	});
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline test"));
	onTestFinished(() => fetch.mockRestore());
	return { dir, work, agentDir, logFile };
}

const unsupported = () => Promise.reject(new Error("not used by these tests"));

/** Command actions the SDK leaves out, with a test's own newSession. */
function commandActions(newSession: ExtensionCommandContextActions["newSession"]): ExtensionCommandContextActions {
	return {
		waitForIdle: () => Promise.resolve(),
		newSession,
		fork: unsupported,
		navigateTree: unsupported,
		switchSession: unsupported,
		reload: unsupported,
	};
}

/** A Pi session in `work` with this extension and another provider loaded. */
async function piSession(home: { dir: string; work: string; agentDir: string }, options: StartOptions) {
	const { work, agentDir } = home;
	const settingsManager = SettingsManager.inMemory(options.settings);
	const resourceLoader = new DefaultResourceLoader({
		cwd: work,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [antigravityAcp, otherProvider],
	});
	await resourceLoader.reload();
	const [model] = piModels(emptyCatalog);
	expect.assert(model);
	const { session } = await createAgentSession({
		cwd: work,
		agentDir,
		settingsManager,
		sessionManager: SessionManager.continueRecent(work, join(home.dir, "sessions")),
		resourceLoader,
		model,
	});
	for (const [name, value] of Object.entries(options.flags ?? {})) session.extensionRunner.setFlagValue(name, value);
	await session.bindExtensions({
		...(options.ui ? { uiContext: { ...session.extensionRunner.getUIContext(), ...options.ui } } : {}),
		...(options.newSession ? { commandContextActions: commandActions(options.newSession) } : {}),
	});
	return session;
}

/** Resolves once no scripted agent process of this test is running; each marks itself running. */
async function agentsExited(logFile: string) {
	const marker = `${basename(logFile)}.running.`;
	await vi.waitFor(
		async () => {
			const names = await readdir(dirname(logFile));
			if (names.some((name) => name.startsWith(marker))) throw new Error("an agent process has not exited");
		},
		{ timeout: 5000, interval: 20 },
	);
}

/** Reads what the newest scripted agent recorded, once every agent process has exited. */
async function agentLog(logFile: string): Promise<ProcessLog> {
	await agentsExited(logFile);
	// An agent writes its log as it exits, before it removes its running marker.
	const recorded: unknown = JSON.parse(await readFile(logFile, "utf8"));
	if (!isProcessLog(recorded)) throw new Error(`the agent log is incomplete: ${logFile}`);
	return recorded;
}

/** A real Pi session with the extension loaded and a scripted `agy` first on PATH. */
export async function start(options: StartOptions = {}) {
	const home = await scratchHome(options);
	const { dir, work, agentDir, logFile } = home;
	const session = await piSession(home, options);
	let stopped = false;
	const shutdown = async () => {
		if (stopped) return;
		stopped = true;
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	};
	/** Ends the session the way Pi does and returns what the scripted agent recorded. */
	const stop = async (): Promise<ProcessLog> => {
		await shutdown();
		return agentLog(logFile);
	};
	onTestFinished(async () => {
		await shutdown();
		await agentsExited(logFile);
	});
	const assistants = () => session.messages.filter((m): m is AssistantMessage => m.role === "assistant");
	return { session, home: dir, work, agentDir, stop, assistants };
}
