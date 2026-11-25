import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
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

/** A real Pi session with the extension loaded and a scripted `agy` first on PATH. */
async function start(options: { agy: boolean } = { agy: true }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-acp-ext-")));
  const [work, bin, agentDir] = [join(dir, "work"), join(dir, "bin"), join(dir, "pi")];
  const logFile = join(dir, "agent-log.json");
  await Promise.all([mkdir(work), mkdir(bin)]);
  if (options.agy)
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
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: work,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [antigravityAcp],
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
  await session.bindExtensions({});
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
