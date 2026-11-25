import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

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
async function start(t: TestContext, options: { agy: boolean } = { agy: true }) {
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
  t.mock.method(globalThis, "fetch", () => Promise.reject(new Error("offline test")));
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
  assert.ok(model);
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
  t.after(async () => {
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

await test("an ordinary Pi prompt is answered by the agent, which Pi then knows by its models and context use", async (t) => {
  const { session, work, agentDir, stop, assistants } = await start(t);
  await session.prompt("hello there");
  const reply = assistants().at(-1);
  assert.equal(reply?.provider, PROVIDER);
  assert.equal(said(reply), "echo: hello there");
  assert.deepEqual(reply?.content[0], { type: "thinking", thinking: "hm" });
  assert.equal(session.getContextUsage()?.tokens, 2048);
  assert.deepEqual(
    ["gemini-a", "gemini-b"].map((id) => session.modelRuntime.getModel(PROVIDER, id)?.name),
    ["Gemini A", "Gemini B"],
  );
  const saved: unknown = JSON.parse(
    await readFile(join(agentDir, "antigravity", "catalog.json"), "utf8"),
  );
  assert.match(
    JSON.stringify(saved),
    /"id":"gemini-b","name":"Gemini B","efforts":\["low","high","xhigh"\]/,
  );

  const log = await stop();
  assert.deepEqual(log.argv, ["acp"]);
  assert.equal(log.cwd, work);
  assert.equal(log.initialize?.clientInfo?.name, "pi");
  assert.equal(log.sessions[0]?.cwd, work);
  assert.deepEqual(log.prompts, [[{ type: "text", text: "hello there" }]]);
});

await test("the agent's tool calls show as Pi tool calls; with nobody to ask, permission is declined", async (t) => {
  const { session, stop, assistants } = await start(t);
  await session.prompt("please read it");
  const [call, answer] = assistants();
  assert.deepEqual(
    call?.content.filter((block) => block.type === "toolCall").map((b) => [b.name, b.arguments]),
    [[TOOL_NAME, { kind: "read", title: "File notes.txt" }]],
  );
  assert.equal(said(call), "Reading.");
  assert.equal(said(answer), "It says alpha.");
  const results = () => session.messages.filter((m) => m.role === "toolResult");
  assert.deepEqual(results()[0]?.content, [{ type: "text", text: "alpha" }]);

  await session.prompt("now edit it");
  const declined = results()[1];
  assert.equal(declined?.isError, true);
  assert.deepEqual(declined?.content, [
    { type: "text", text: "Permission declined: File notes.txt" },
  ]);
  assert.deepEqual(assistants().at(-1)?.content, []);

  const log = await stop();
  assert.deepEqual(log.outcomes, [{ outcome: "selected", optionId: "deny" }]);
  assert.equal(log.prompts.length, 2);
  assert.equal(log.sessions.length, 1);
});

await test("/agy mode changes the agent's permission mode, also before the first message", async (t) => {
  const { session, stop, assistants } = await start(t);
  await session.prompt("/agy mode auto");
  await session.prompt("/agy mode bogus");
  await session.prompt("/agy status");
  assert.equal(assistants().length, 0, "commands are not sent to the agent");
  await session.prompt("hello");
  assert.equal(said(assistants().at(-1)), "echo: hello");
  const log = await stop();
  assert.deepEqual(log.config, [["mode", "auto"]]);
  assert.equal(log.sessions.length, 1);
});

await test("Pi's model and thinking level reach the agent, and Pi's compaction is left to the agent", async (t) => {
  const { session, stop } = await start(t);
  await session.prompt("hello");
  const second = session.modelRuntime.getModel(PROVIDER, "gemini-b");
  assert.ok(second);
  await session.setModel(second);
  session.setThinkingLevel("xhigh");
  await session.prompt("again");
  await assert.rejects(session.compact());
  const log = await stop();
  assert.deepEqual(log.config, [
    ["model", "gemini-b"],
    ["thought_level", "xhigh"],
  ]);
  assert.equal(log.prompts.length, 2);
});

await test("aborting in Pi cancels the agent's turn and the next prompt works", async (t) => {
  const { session, stop, assistants } = await start(t);
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
  assert.equal(assistants().at(-1)?.stopReason, "aborted");
  await session.prompt("hello");
  assert.equal(said(assistants().at(-1)), "echo: hello");
  const log = await stop();
  assert.equal(log.cancels, 1);
  assert.equal(log.sessions.length, 1);
});

await test("without an agent installed, the reply says what to install", async (t) => {
  const { session, assistants } = await start(t, { agy: false });
  await session.prompt("hello");
  const reply = assistants().at(-1);
  assert.equal(reply?.stopReason, "error");
  assert.match(reply?.errorMessage ?? "", /agy.*not found on PATH/);
});
