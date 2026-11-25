import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionUIContext,
  initTheme,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { expect, onTestFinished, test, vi } from "vitest";

import { emptyCatalog, piModels, PROVIDER } from "../src/catalog.ts";
import antigravityAcp from "../src/index.ts";
import { TOOL_NAME } from "../src/tool.ts";
import type { AgentLog } from "./support/fake-agent.ts";

const fakeAgy = join(import.meta.dirname, "support", "fake-agy.ts");
const ENV = ["PATH", "HOME", "PI_CODING_AGENT_DIR", "FAKE_AGY_LOG"] as const;
type ProcessLog = AgentLog & { argv: string[]; cwd: string };

function isProcessLog(value: unknown): value is ProcessLog {
  return typeof value === "object" && value !== null && "prompts" in value && "argv" in value;
}

const said = (message: AssistantMessage | undefined) =>
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
function fakeUi(answers: (string | undefined)[] = []) {
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

interface StartOptions {
  agy?: boolean;
  /** Dialogs and notices; Pi's no-op UI supplies everything else. */
  ui?: Partial<ExtensionUIContext>;
  flags?: Record<string, string>;
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
}

/** A real Pi session with the extension loaded and a scripted `agy` first on PATH. */
async function start(options: StartOptions = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-acp-ext-")));
  const [work, bin, agentDir] = [join(dir, "work"), join(dir, "bin"), join(dir, "pi")];
  const logFile = join(dir, "agent-log.json");
  await Promise.all([mkdir(work), mkdir(bin)]);
  if (options.agy ?? true)
    await writeFile(join(bin, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${fakeAgy}" "$@"\n`, {
      mode: 0o755,
    });
  const saved = ENV.map((name) => [name, process.env[name]] as const);
  // HOME points away from any editor-installed agent; PATH holds only the scripted agy.
  Object.assign(process.env, {
    PATH: bin,
    HOME: dir,
    PI_CODING_AGENT_DIR: agentDir,
    FAKE_AGY_LOG: logFile,
  });
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline test"));
  onTestFinished(() => fetch.mockRestore());
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
    sessionManager: SessionManager.inMemory(work),
    resourceLoader,
    model,
  });
  for (const [name, value] of Object.entries(options.flags ?? {}))
    session.extensionRunner.setFlagValue(name, value);
  await session.bindExtensions(
    options.ui ? { uiContext: { ...session.extensionRunner.getUIContext(), ...options.ui } } : {},
  );
  let stopped = false;
  /** Ends the session the way Pi does and returns what the scripted agent recorded. */
  const stop = async (): Promise<ProcessLog> => {
    if (!stopped) {
      stopped = true;
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      // oxlint-disable-next-line no-await-in-loop -- polls for the agent process to exit and save its log
      const text = await readFile(logFile, "utf8").catch(() => "");
      const recorded: unknown = text ? JSON.parse(text) : undefined;
      if (isProcessLog(recorded)) return recorded;
      // oxlint-disable-next-line no-await-in-loop -- see above
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the agent process did not exit");
  };
  onTestFinished(async () => {
    if (!stopped) await stop().catch(() => {});
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const assistants = () =>
    session.messages.filter((m): m is AssistantMessage => m.role === "assistant");
  return { session, work, agentDir, stop, assistants };
}

test("an ordinary Pi prompt is answered by the agent, which Pi then knows by its models and context use", async () => {
  const { session, work, agentDir, stop, assistants } = await start();
  await session.prompt("hello there");
  const reply = assistants().at(-1);
  expect(reply?.provider).toBe(PROVIDER);
  expect(said(reply)).toBe("echo: hello there");
  expect(reply?.content[0]).toStrictEqual({ type: "thinking", thinking: "hm" });
  expect(session.getContextUsage()?.tokens).toBe(2048);
  expect(
    ["gemini-a", "gemini-b"].map((id) => session.modelRuntime.getModel(PROVIDER, id)?.name),
  ).toStrictEqual(["Gemini A", "Gemini B"]);
  const saved: unknown = JSON.parse(
    await readFile(join(agentDir, "antigravity", "catalog.json"), "utf8"),
  );
  expect(JSON.stringify(saved)).toMatch(
    /"id":"gemini-b","name":"Gemini B","efforts":\["low","high","xhigh"\]/,
  );

  const log = await stop();
  expect(log.argv).toStrictEqual(["acp"]);
  expect(log.cwd).toBe(work);
  expect(log.initialize?.clientInfo?.name).toBe("pi");
  expect(log.sessions[0]?.cwd).toBe(work);
  expect(log.prompts).toStrictEqual([[{ type: "text", text: "hello there" }]]);
});

test("the agent's tool calls show as Pi tool calls; with nobody to ask, permission is declined", async () => {
  const { session, stop, assistants } = await start();
  await session.prompt("please read it");
  const [call, answer] = assistants();
  expect(
    call?.content.filter((block) => block.type === "toolCall").map((b) => [b.name, b.arguments]),
  ).toStrictEqual([[TOOL_NAME, { kind: "read", title: "File notes.txt" }]]);
  expect(said(call)).toBe("Reading.");
  expect(said(answer)).toBe("It says alpha.");
  const results = () => session.messages.filter((m) => m.role === "toolResult");
  expect(results()[0]?.content).toStrictEqual([{ type: "text", text: "alpha" }]);

  await session.prompt("now edit it");
  const declined = results()[1];
  expect(declined?.isError).toBe(true);
  expect(declined?.content).toStrictEqual([
    { type: "text", text: "Permission declined: File notes.txt" },
  ]);
  expect(assistants().at(-1)?.content).toStrictEqual([]);

  const log = await stop();
  expect(log.outcomes).toStrictEqual([{ outcome: "selected", optionId: "deny" }]);
  expect(log.prompts.length).toBe(2);
  expect(log.sessions.length).toBe(1);
});

test("/agy mode changes the agent's permission mode, also before the first message", async () => {
  const { session, stop, assistants } = await start();
  await session.prompt("/agy mode auto");
  await session.prompt("/agy mode bogus");
  await session.prompt("/agy status");
  expect(assistants().length, "commands are not sent to the agent").toBe(0);
  await session.prompt("hello");
  expect(said(assistants().at(-1))).toBe("echo: hello");
  const log = await stop();
  expect(log.config).toStrictEqual([["mode", "auto"]]);
  expect(log.sessions.length).toBe(1);
});

test("Pi's model and thinking level reach the agent, and Pi's compaction is left to the agent", async () => {
  const { session, stop } = await start();
  await session.prompt("hello");
  const second = session.modelRuntime.getModel(PROVIDER, "gemini-b");
  expect.assert(second);
  await session.setModel(second);
  session.setThinkingLevel("xhigh");
  await session.prompt("again");
  await expect(session.compact()).rejects.toThrow();
  const log = await stop();
  expect(log.config).toStrictEqual([
    ["model", "gemini-b"],
    ["thought_level", "xhigh"],
  ]);
  expect(log.prompts.length).toBe(2);
});

test("aborting in Pi cancels the agent's turn and the next prompt works", async () => {
  const { session, stop, assistants } = await start();
  const started = new Promise<void>((resolve) => {
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
        resolve();
    });
  });
  const turn = session.prompt("wait for me");
  await started;
  await session.abort();
  await turn;
  expect(assistants().at(-1)?.stopReason).toBe("aborted");
  await session.prompt("hello");
  expect(said(assistants().at(-1))).toBe("echo: hello");
  const log = await stop();
  expect(log.cancels).toBe(1);
  expect(log.sessions.length).toBe(1);
});

test("without an agent installed, the reply says what to install", async () => {
  const { session, assistants } = await start({ agy: false });
  await session.prompt("hello");
  const reply = assistants().at(-1);
  expect(reply?.stopReason).toBe("error");
  expect(reply?.errorMessage ?? "").toMatch(/agy.*not found on PATH/);
});

test("with a UI, the agent's permission request becomes a Pi dialog and the mode shows in the footer", async () => {
  const { ui, dialogs, status } = fakeUi(["Allow"]);
  const { session, stop, assistants } = await start({ ui });
  await session.prompt("now edit it");
  expect(dialogs).toStrictEqual([
    { title: "Antigravity asks permission · edit: File notes.txt", options: ["Allow", "Deny"] },
  ]);
  expect(said(assistants().at(-1))).toBe("Edited.");
  expect(status.get("antigravity")).toBe("agy mode: default");
  const log = await stop();
  expect(log.outcomes).toStrictEqual([{ outcome: "selected", optionId: "allow" }]);
});

test("/agy mode without an id offers the agent's modes, and /agy status reports the session", async () => {
  const { ui, notes, dialogs, status } = fakeUi(["auto — auto", undefined]);
  const { session, stop } = await start({ ui });
  await session.prompt("/agy status");
  expect(notes.at(-1)).toMatch(/No Antigravity session yet/);
  await session.prompt("/agy mode");
  expect(dialogs[0]?.options).toStrictEqual(["default — default", "auto — auto"]);
  expect(notes.at(-1)).toBe("info: Antigravity permission mode: auto");
  expect(status.get("antigravity")).toBe("agy mode: auto");
  await session.prompt("/agy mode");
  expect(dialogs.length, "a dismissed dialog changes nothing").toBe(2);
  await session.prompt("/agy status");
  expect(notes.at(-1)?.split("\n")).toStrictEqual([
    "info: Agent: Fake Agent 0.0.1",
    "Quota tier: Test Tier",
    "Model: gemini-a",
    "Thinking: high",
    "Permission mode: auto",
    "Context: 0 of 1,000,000 tokens",
    "Agent session: s1",
  ]);
  await session.prompt("/agy bogus");
  expect(notes.at(-1)).toBe("warning: Usage: /agy status, or /agy mode [id]");
  const log = await stop();
  expect(log.config).toStrictEqual([["mode", "auto"]]);
});

test("/agy reports an agent it cannot start, and completes its subcommands", async () => {
  const { ui, notes } = fakeUi();
  const { session } = await start({ agy: false, ui });
  await session.prompt("/agy mode auto");
  expect(notes.at(-1)).toMatch(/^error: .*agy.*not found on PATH/);
  const agy = session.extensionRunner.getCommand("agy");
  expect(await agy?.getArgumentCompletions?.("mo")).toStrictEqual([
    { value: "mode", label: "mode" },
  ]);
  expect(await agy?.getArgumentCompletions?.("x")).toBeNull();
});

test("--agy-mode picks the starting mode, and an unknown one is reported", async () => {
  const chosen = await start({ flags: { "agy-mode": "auto" } });
  await chosen.session.prompt("hello");
  expect((await chosen.stop()).config).toStrictEqual([["mode", "auto"]]);

  const { ui, notes, status } = fakeUi();
  const unknown = await start({ ui, flags: { "agy-mode": "bogus" } });
  expect(status.get("antigravity")).toBe("agy mode: bogus");
  await unknown.session.prompt("hello");
  expect(notes).toContain('warning: Antigravity has no "bogus" mode. Available: default, auto.');
  expect(status.get("antigravity")).toBe("agy mode: default");
  expect(said(unknown.assistants().at(-1))).toBe("echo: hello");
});

test("with the mirror tool turned off, the agent's tool calls become notices", async () => {
  const { ui, notes } = fakeUi();
  const { session, assistants } = await start({ ui });
  session.setActiveToolsByName([]);
  await session.prompt("please read it");
  expect(notes).toContain("info: Antigravity read: File notes.txt");
  expect(said(assistants().at(-1))).toBe("Reading.It says alpha.");
});

test("rewinding Pi's conversation starts a new agent session with the visible history", async () => {
  const { session, stop } = await start();
  await session.prompt("first");
  await session.prompt("second");
  const first = session.sessionManager.getEntries().find((entry) => entry.type === "message");
  expect.assert(first);
  await session.navigateTree(first.id);
  await session.prompt("third");
  const log = await stop();
  expect(log.sessions.length).toBe(2);
  expect(JSON.stringify(log.prompts.at(-1))).toMatch(/third/);
});

test("Pi's manual compaction is declined with a notice", async () => {
  const { ui, notes } = fakeUi();
  const { session } = await start({ ui, settings: { compaction: { keepRecentTokens: 0 } } });
  await session.prompt("hello");
  await session.prompt("again");
  await expect(session.compact()).rejects.toThrow("Compaction cancelled");
  expect(notes).toContain(
    "info: Antigravity manages its own context, so Pi's compaction is skipped for this model.",
  );
});

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

test("the mirror tool's rows reuse the component Pi already shows", async () => {
  const { session } = await start();
  const tool = session.getToolDefinition(TOOL_NAME);
  expect.assert(tool?.renderCall && tool.renderResult);
  initTheme("dark");
  const { theme } = session.extensionRunner.getUIContext();
  const args = { kind: "execute", title: "ls" };
  const context = (lastComponent?: Component): RenderContext => ({
    args,
    toolCallId: "t1",
    invalidate: () => {},
    lastComponent,
    state: {},
    cwd: "/",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 0,
    keyText: () => "",
    keyHint: () => "",
  });
  const call = tool.renderCall(args, theme, context());
  expect(stripVTControlCharacters(call.render(80).join(""))).toMatch(/\$ ls/);
  expect(tool.renderCall(args, theme, context(call))).toBe(call);

  const result = {
    content: [],
    details: { ...args, status: "completed", declined: false, diffs: [], output: "" },
  };
  const view = { expanded: false, isPartial: false };
  const row = tool.renderResult(result, view, theme, context());
  expect(stripVTControlCharacters(row.render(80).join(""))).toMatch(/done/);
  expect(tool.renderResult(result, view, theme, context(row))).toBe(row);
});

test("switching to another provider's model hides the mirror tool, the footer and the compaction guard", async () => {
  const { ui, notes, status } = fakeUi();
  const { session } = await start({ ui, settings: { compaction: { keepRecentTokens: 0 } } });
  await session.prompt("hello");
  expect(session.getActiveToolNames()).toContain(TOOL_NAME);
  const other = session.modelRuntime.getModel("other", "other-model");
  expect.assert(other);
  await session.setModel(other);
  expect(session.getActiveToolNames()).not.toContain(TOOL_NAME);
  expect(status.get("antigravity")).toBeUndefined();
  await expect(session.compact()).rejects.toThrow(/not called/);
  expect(notes.join("\n")).not.toMatch(/compaction is skipped/);
});

test("--agy-agent picks the agent to run", async () => {
  const { session, stop } = await start({ flags: { "agy-agent": "cli" } });
  await session.prompt("hello");
  expect((await stop()).argv).toStrictEqual(["acp"]);
});
