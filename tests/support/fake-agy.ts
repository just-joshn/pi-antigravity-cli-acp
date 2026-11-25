/** A scripted ACP agent on stdio, started by tests in place of the real `agy acp`. */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import { type ContentBlock, ndJsonStream } from "@agentclientprotocol/sdk/unstable";

import { isRecord } from "../../src/guards.ts";
import { defaultCommands, serveAgent } from "./fake-agent.ts";
import type { Step } from "./playback.ts";

const entry = (content: string, status: "pending" | "in_progress" | "completed") => ({
  content,
  status,
  priority: "medium" as const,
});

/** Exits the agent process shortly, as if it crashed. */
function dieSoon(delayMs: number) {
  // oxlint-disable-next-line unicorn/no-process-exit -- simulates the agent process dying mid-turn
  setTimeout(() => process.exit(3), delayMs);
}

const never = new Promise(() => {});

const colorQuestion = {
  sessionId: "",
  mode: "form" as const,
  message: "Which color?",
  requestedSchema: {
    type: "object" as const,
    properties: { color: { type: "string" as const, enum: ["red", "blue"] } },
    required: ["color"],
  },
};

/** What the scripted agent does for a prompt containing a keyword, checked in this order. */
const SCRIPTS: [keyword: string, steps: () => Step[]][] = [
  [
    "die planning",
    () => {
      dieSoon(50);
      return [{ plan: [entry("Look around", "in_progress")] }, { hold: never }];
    },
  ],
  [
    "edit",
    () => [
      { tool: { toolCallId: "e1", kind: "edit", title: "File notes.txt", status: "pending" } },
      {
        ask: "e1",
        allowed: [{ update: { toolCallId: "e1", status: "completed" } }, { say: "Edited." }],
        declined: [{ update: { toolCallId: "e1", status: "failed" } }],
      },
    ],
  ],
  [
    "read",
    () => [
      { say: "Reading." },
      { tool: { toolCallId: "r1", kind: "read", title: "File notes.txt", status: "in_progress" } },
      {
        update: {
          toolCallId: "r1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "alpha" } }],
        },
      },
      { say: "It says alpha." },
    ],
  ],
  [
    "markdown plan",
    () => [
      {
        raw: {
          sessionUpdate: "plan_update",
          plan: { type: "markdown", planId: "m1", content: "1. Look\n2. Write" },
        },
      },
      { raw: { sessionUpdate: "plan_removed", planId: "m1" } },
      { say: "Done." },
    ],
  ],
  [
    "plan",
    () => [
      { plan: [entry("Look around", "in_progress"), entry("Write it", "pending")] },
      { plan: [entry("Look around", "completed"), entry("Write it", "in_progress")] },
      { plan: [entry("Look around", "completed"), entry("Write it", "completed")] },
      { say: "Planned and done." },
    ],
  ],
  [
    "crash",
    () => {
      dieSoon(0);
      return [{ say: "Working." }, { hold: never }];
    },
  ],
  ["question", () => [{ elicit: colorQuestion }]],
  [
    "run",
    () => [{ run: [process.execPath, "-e", "process.stdout.write('ran in ' + process.cwd())"] }],
  ],
  ["name", () => [{ title: "Named" }, { say: "Named it." }]],
  ["wait", () => [{ say: "Waiting." }, { hold: "cancel" }]],
];

function script(prompt: ContentBlock[]): Step[] {
  const text = prompt.map((block) => (block.type === "text" ? block.text : "")).join(" ");
  const found = SCRIPTS.find(([keyword]) => text.includes(keyword));
  if (found) return found[1]();
  return [{ think: "hm" }, { usage: [2048, 1_000_000] }, { say: `echo: ${text}` }];
}

/** Saved conversations, kept in a file across agent processes as `agy` keeps them. */
const store = process.env["FAKE_AGY_STORE"];
const saved: unknown = store
  ? JSON.parse(readFileSync(store, { encoding: "utf8", flag: "a+" }) || "{}")
  : {};

const isBlock = (item: unknown) => isRecord(item) && typeof item["type"] === "string";

/** A saved store: prompts by session id, each prompt a list of content blocks. */
const isPrompt = (item: unknown) => Array.isArray(item) && item.every(isBlock);
const isPrompts = (item: unknown) => Array.isArray(item) && item.every(isPrompt);

function isHistory(value: unknown): value is Record<string, ContentBlock[][]> {
  return isRecord(value) && Object.values(value).every(isPrompts);
}

const { log, history } = serveAgent(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  {
    script,
    commands: [...defaultCommands, { name: "status", description: "The agent's own status." }],
    plain: process.env["FAKE_AGY_PLAIN"] === "1",
    restore: process.env["FAKE_AGY_RESTORE"] !== "0",
    signedOut: process.env["FAKE_AGY_SIGNED_OUT"] === "1",
    ghosts: process.env["FAKE_AGY_GHOST"] ? [process.env["FAKE_AGY_GHOST"]] : [],
    history: isHistory(saved) ? saved : {},
    idPrefix: `p${process.pid}-`,
  },
);
/** Each process marks itself running; the log of the newest-started process is kept. */
const logFile = process.env["FAKE_AGY_LOG"];
const startedAt = process.hrtime.bigint();
const running = `${logFile}.running.${process.pid}`;
if (logFile) writeFileSync(running, "");
const save = () => {
  if (store) writeFileSync(store, JSON.stringify(history()));
  if (!logFile) return;
  const previous: unknown = JSON.parse(
    readFileSync(logFile, { encoding: "utf8", flag: "a+" }) || "{}",
  );
  const newer =
    typeof previous !== "object" ||
    previous === null ||
    BigInt(String(Reflect.get(previous, "startedAt") ?? 0)) < startedAt;
  const record = {
    ...log,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    startedAt: String(startedAt),
  };
  if (newer) writeFileSync(logFile, JSON.stringify(record));
  rmSync(running, { force: true });
};
// oxlint-disable-next-line unicorn/no-process-exit -- a test double; exiting runs the handler that saves its log
const quit = () => process.exit(0);
process.on("exit", save);
process.on("SIGTERM", quit);
process.stdin.on("end", quit);
