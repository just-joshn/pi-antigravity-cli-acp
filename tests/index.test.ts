import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

import { PROVIDER, readCatalog } from "../src/catalog.ts";
import { TOOL_NAME } from "../src/tool.ts";
import { fakeUi, said, start } from "./support/pi.ts";

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
  const saved = readCatalog(join(agentDir, "antigravity", "catalog.json"));
  expect(saved.models).toContainEqual({
    id: "gemini-b",
    name: "Gemini B",
    efforts: ["low", "high", "xhigh"],
  });

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
  expect(dialogs()).toStrictEqual([
    { title: "Antigravity asks permission · edit: File notes.txt", options: ["Allow", "Deny"] },
  ]);
  expect(said(assistants().at(-1))).toBe("Edited.");
  expect(status("antigravity")).toBe("agy mode: default");
  const log = await stop();
  expect(log.outcomes).toStrictEqual([{ outcome: "selected", optionId: "allow" }]);
});

test("/agy mode without an id offers the agent's modes, and /agy status reports the session", async () => {
  const { ui, notes, dialogs, status } = fakeUi(["auto — auto", undefined]);
  const { session, stop } = await start({ ui });
  await session.prompt("/agy status");
  expect(notes().at(-1)).toMatch(/No Antigravity session yet/);
  await session.prompt("/agy mode");
  expect(dialogs()[0]?.options).toStrictEqual(["default — default", "auto — auto"]);
  expect(notes().at(-1)).toBe("info: Antigravity permission mode: auto");
  expect(status("antigravity")).toBe("agy mode: auto");
  await session.prompt("/agy mode");
  expect(dialogs().length, "a dismissed dialog changes nothing").toBe(2);
  await session.prompt("/agy status");
  expect(notes().at(-1)?.split("\n")).toStrictEqual([
    "info: Agent: Fake Agent 0.0.1",
    "Quota tier: Test Tier",
    "Model: gemini-a",
    "Thinking: high",
    "Permission mode: auto",
    "Context: 0 of 1,000,000 tokens",
    expect.stringMatching(/^Agent session: p\d+-s1$/),
  ]);
  await session.prompt("/agy bogus");
  expect(notes().at(-1)).toBe(
    "warning: Usage: /agy status, /agy mode [id], /agy sessions, /agy login, /agy logout, or /agy <agent command> [input]",
  );
  const log = await stop();
  expect(log.config).toStrictEqual([["mode", "auto"]]);
});

test("/agy reports an agent it cannot start, and completes its subcommands", async () => {
  const { ui, notes } = fakeUi();
  const { session } = await start({ agy: false, ui });
  await session.prompt("/agy mode auto");
  expect(notes().at(-1)).toMatch(/^error: .*agy.*not found on PATH/);
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
  expect(status("antigravity")).toBe("agy mode: bogus");
  await unknown.session.prompt("hello");
  expect(notes()).toContain('warning: Antigravity has no "bogus" mode. Available: default, auto.');
  expect(status("antigravity")).toBe("agy mode: default");
  expect(said(unknown.assistants().at(-1))).toBe("echo: hello");
});

test("with the mirror tool turned off, the agent's tool calls become notices", async () => {
  const { ui, notes } = fakeUi();
  const { session, assistants } = await start({ ui });
  session.setActiveToolsByName([]);
  await session.prompt("please read it");
  expect(notes()).toContain("info: Antigravity read: File notes.txt");
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
  expect(log.loads, "the rewound-from session went past this point").toStrictEqual([]);
  expect(log.closes.length, "the replaced session is freed").toBe(1);
});

test("Pi's automatic compaction is declined without a notice", async () => {
  const { ui, notes } = fakeUi();
  const settings = { compaction: { enabled: true, reserveTokens: 999_000, keepRecentTokens: 0 } };
  const { session, assistants } = await start({ ui, settings });
  await session.prompt("hello");
  await session.prompt("again");
  expect(assistants().map(said)).toStrictEqual(["echo: hello", "echo: again"]);
  expect(session.messages.some((message) => message.role === "compactionSummary")).toBe(false);
  expect(notes().join("\n")).not.toMatch(/compaction is skipped/);
});

test("the mirror tool reports that no agent call matches when no agent session is open", async () => {
  const { session } = await start();
  const tool = session.getToolDefinition(TOOL_NAME);
  expect.assert(tool);
  const ctx = session.extensionRunner.createToolContext("t1", undefined);
  const result = await tool.execute("t1", { kind: "read", title: "a" }, undefined, undefined, ctx);
  const [first] = result.content;
  expect.assert(first?.type === "text");
  expect(first.text).toMatch(/^No Antigravity tool call matches/);
});

test("Pi's manual compaction is declined with a notice", async () => {
  const { ui, notes } = fakeUi();
  const { session } = await start({ ui, settings: { compaction: { keepRecentTokens: 0 } } });
  await session.prompt("hello");
  await session.prompt("again");
  await expect(session.compact()).rejects.toThrow("Compaction cancelled");
  expect(notes()).toContain(
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
  const { ui, status } = fakeUi();
  const { session } = await start({ ui, settings: { compaction: { keepRecentTokens: 0 } } });
  await session.prompt("hello");
  expect(session.getActiveToolNames()).toContain(TOOL_NAME);
  const other = session.modelRuntime.getModel("other", "other-model");
  expect.assert(other);
  await session.setModel(other);
  expect(session.getActiveToolNames()).not.toContain(TOOL_NAME);
  expect(status("antigravity")).toBeUndefined();
  await expect(session.compact()).rejects.toThrow(/not called/);
});

test("--agy-agent picks the agent to run", async () => {
  const cli = await start({ flags: { "agy-agent": "cli" } });
  await cli.session.prompt("hello");
  expect((await cli.stop()).argv).toStrictEqual(["acp"]);
  const registry = await start({ flags: { "agy-agent": "registry" } });
  await registry.session.prompt("hello");
  expect(registry.assistants().at(-1)?.errorMessage, "agy on PATH is not used").toMatch(
    /No Antigravity agent installed from Zed's ACP registry/,
  );
});

test("/agy status names the session once the agent titles it", async () => {
  const { ui, notes } = fakeUi();
  const { session } = await start({ ui });
  await session.prompt("name this chat");
  await session.prompt("/agy status");
  expect(notes().at(-1)).toMatch(/^Agent session: p\d+-s1 \(Named\)$/m);
});

test("/agy status and mode with an agent that reports no tier, settings or usage", async () => {
  const { ui, notes } = fakeUi();
  const { session } = await start({ ui, plain: true });
  await session.prompt("/agy mode auto");
  expect(notes().at(-1)).toBe('warning: Antigravity has no "auto" mode.');
  await session.prompt("/agy status");
  expect(notes().at(-1)?.split("\n")).toStrictEqual([
    "info: Agent: Fake Agent 0.0.1",
    "Model: unknown",
    "Thinking: not adjustable",
    "Permission mode: unknown",
    expect.stringMatching(/^Agent session: p\d+-s1$/),
  ]);
});

test("/agy mode without an id does nothing when there is nobody to ask", async () => {
  const { session, stop } = await start();
  await session.prompt("/agy mode");
  const log = await stop();
  expect(log.sessions.length, "the agent session still starts").toBe(1);
  expect(log.config).toStrictEqual([]);
});

test("an unknown --agy-agent falls back to auto, and an empty --agy-mode is ignored", async () => {
  const { session, stop } = await start({ flags: { "agy-agent": "bogus", "agy-mode": "" } });
  await session.prompt("hello");
  const log = await stop();
  expect(log.argv).toStrictEqual(["acp"]);
  expect(log.config).toStrictEqual([]);
});

test("/agy alone shows the status, and extra spaces around its arguments are ignored", async () => {
  const { ui, notes } = fakeUi();
  const { session, stop } = await start({ ui });
  await session.prompt("/agy");
  expect(notes().at(-1)).toMatch(/No Antigravity session yet/);
  await session.prompt("/agy   mode   auto  ");
  expect(notes().at(-1)).toBe("info: Antigravity permission mode: auto");
  expect((await stop()).config).toStrictEqual([["mode", "auto"]]);
});

test("/agy reports an unexpected failure with its reason", async () => {
  const { ui, notes } = fakeUi();
  const { session } = await start({
    ui: { ...ui, select: () => Promise.reject(new Error("dialog closed")) },
  });
  await session.prompt("/agy mode");
  expect(notes().at(-1)).toBe("error: The Antigravity agent could not be reached: dialog closed");
});
