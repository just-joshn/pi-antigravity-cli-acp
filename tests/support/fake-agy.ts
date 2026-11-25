/** A scripted ACP agent on stdio, started by tests in place of the real `agy acp`. */
import { readFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import { type ContentBlock, ndJsonStream } from "@agentclientprotocol/sdk/unstable";

import { serveAgent, type Step } from "./fake-agent.ts";

const entry = (content: string, status: "pending" | "in_progress" | "completed") => ({
  content,
  status,
  priority: "medium" as const,
});

function script(prompt: ContentBlock[]): Step[] {
  const text = prompt.map((block) => (block.type === "text" ? block.text : "")).join(" ");
  if (text.includes("edit")) {
    return [
      { tool: { toolCallId: "e1", kind: "edit", title: "File notes.txt", status: "pending" } },
      {
        ask: "e1",
        allowed: [{ update: { toolCallId: "e1", status: "completed" } }, { say: "Edited." }],
        declined: [{ update: { toolCallId: "e1", status: "failed" } }],
      },
    ];
  }
  if (text.includes("read")) {
    return [
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
    ];
  }
  if (text.includes("plan")) {
    return [
      { plan: [entry("Look around", "in_progress"), entry("Write it", "pending")] },
      { plan: [entry("Look around", "completed"), entry("Write it", "in_progress")] },
      { plan: [entry("Look around", "completed"), entry("Write it", "completed")] },
      { say: "Planned and done." },
    ];
  }
  if (text.includes("crash")) {
    // oxlint-disable-next-line unicorn/no-process-exit -- simulates the agent process dying mid-turn
    setImmediate(() => process.exit(3));
    return [{ say: "Working." }, { hold: new Promise(() => {}) }];
  }
  if (text.includes("name")) return [{ title: "Named" }, { say: "Named it." }];
  if (text.includes("wait")) return [{ say: "Waiting." }, { hold: "cancel" }];
  return [{ think: "hm" }, { usage: [2048, 1_000_000] }, { say: `echo: ${text}` }];
}

/** Saved conversations, kept in a file across agent processes as `agy` keeps them. */
const store = process.env["FAKE_AGY_STORE"];
const saved: unknown = store
  ? JSON.parse(readFileSync(store, { encoding: "utf8", flag: "a+" }) || "{}")
  : {};
const history: Record<string, ContentBlock[][]> = {};
if (typeof saved === "object" && saved !== null) Object.assign(history, saved);

const { log } = serveAgent(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  {
    script,
    plain: process.env["FAKE_AGY_PLAIN"] === "1",
    restore: process.env["FAKE_AGY_RESTORE"] !== "0",
    history,
    idPrefix: `p${process.pid}-`,
  },
);
const save = () => {
  if (store) writeFileSync(store, JSON.stringify(history));
  const file = process.env["FAKE_AGY_LOG"];
  if (!file) return;
  const record = JSON.stringify({ ...log, argv: process.argv.slice(2), cwd: process.cwd() });
  writeFileSync(file, record);
};
// oxlint-disable-next-line unicorn/no-process-exit -- a test double; exiting runs the handler that saves its log
const quit = () => process.exit(0);
process.on("exit", save);
process.on("SIGTERM", quit);
process.stdin.on("end", quit);
