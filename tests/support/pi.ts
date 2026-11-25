/** A real Pi session with this extension loaded, talking to the scripted `agy`. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionUIContext,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, onTestFinished, vi } from "vitest";

import { emptyCatalog, piModels } from "../../src/catalog.ts";
import antigravityAcp from "../../src/index.ts";
import type { AgentLog } from "./fake-agent.ts";

const fakeAgy = join(import.meta.dirname, "fake-agy.ts");
export type ProcessLog = AgentLog & { argv: string[]; cwd: string };

function isProcessLog(value: unknown): value is ProcessLog {
  return typeof value === "object" && value !== null && "prompts" in value && "argv" in value;
}

export const said = (message: AssistantMessage | undefined) =>
  (message?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");

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
export function fakeUi(answers: (string | undefined)[] = []) {
  const notes: string[] = [];
  const dialogs: { title: string; options: string[] }[] = [];
  const status = new Map<string, string | undefined>();
  const ui: Partial<ExtensionUIContext> = {
    select(title, options) {
      dialogs.push({ title, options });
      return Promise.resolve(answers.shift());
    },
    notify(message, type) {
      notes.push(`${type ?? "info"}: ${message}`);
    },
    setStatus(key, text) {
      status.set(key, text);
    },
  };
  return { ui, notes, dialogs, status };
}

export interface StartOptions {
  agy?: boolean;
  /** Dialogs and notices; Pi's no-op UI supplies everything else. */
  ui?: Partial<ExtensionUIContext>;
  flags?: Record<string, string>;
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  /** Start the scripted agent without a tier, settings or context usage. */
  plain?: boolean;
  /** Reuse the scratch HOME of an earlier start, with its saved Pi and agent sessions. */
  home?: string;
  /** Start the scripted agent without session/load and session/close. */
  restore?: boolean;
}

/** A scratch HOME whose PATH holds only the scripted `agy`, away from any editor-installed agent. */
async function scratchHome(options: StartOptions) {
  const dir = options.home ?? (await realpath(await mkdtemp(join(tmpdir(), "pi-acp-ext-"))));
  if (!options.home) onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const [work, bin, agentDir] = [join(dir, "work"), join(dir, "bin"), join(dir, "pi")];
  const logFile = join(dir, `agent-log-${randomUUID()}.json`);
  await Promise.all([mkdir(work, { recursive: true }), mkdir(bin, { recursive: true })]);
  if (options.agy ?? true)
    await writeFile(join(bin, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${fakeAgy}" "$@"\n`, {
      mode: 0o755,
    });
  vi.stubEnv("PATH", bin);
  vi.stubEnv("HOME", dir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("FAKE_AGY_LOG", logFile);
  vi.stubEnv("FAKE_AGY_PLAIN", options.plain ? "1" : "0");
  vi.stubEnv("FAKE_AGY_RESTORE", options.restore === false ? "0" : "1");
  vi.stubEnv("FAKE_AGY_STORE", join(dir, "agy-sessions.json"));
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline test"));
  onTestFinished(() => fetch.mockRestore());
  return { dir, work, agentDir, logFile };
}

/** A Pi session in `work` with this extension and another provider loaded. */
async function piSession(
  home: { dir: string; work: string; agentDir: string },
  options: StartOptions,
) {
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
  for (const [name, value] of Object.entries(options.flags ?? {}))
    session.extensionRunner.setFlagValue(name, value);
  await session.bindExtensions(
    options.ui ? { uiContext: { ...session.extensionRunner.getUIContext(), ...options.ui } } : {},
  );
  return session;
}

/** Reads what the scripted agent recorded, once its process has exited and saved it. */
async function agentLog(logFile: string): Promise<ProcessLog> {
  for (let attempt = 0; attempt < 100; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- polls for the agent process to exit and save its log
    const text = await readFile(logFile, "utf8").catch(() => "");
    const recorded: unknown = text ? JSON.parse(text) : undefined;
    if (isProcessLog(recorded)) return recorded;
    // oxlint-disable-next-line no-await-in-loop -- see above
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the agent process did not exit");
}

/** A real Pi session with the extension loaded and a scripted `agy` first on PATH. */
export async function start(options: StartOptions = {}) {
  const home = await scratchHome(options);
  const { dir, work, agentDir, logFile } = home;
  const session = await piSession(home, options);
  let stopped = false;
  /** Ends the session the way Pi does and returns what the scripted agent recorded. */
  const stop = async (): Promise<ProcessLog> => {
    if (!stopped) {
      stopped = true;
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    return agentLog(logFile);
  };
  onTestFinished(async () => {
    if (!stopped) await stop().catch(() => {});
  });
  const assistants = () =>
    session.messages.filter((m): m is AssistantMessage => m.role === "assistant");
  return { session, home: dir, work, agentDir, stop, assistants };
}
