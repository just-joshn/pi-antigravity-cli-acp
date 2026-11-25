import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vitest";

import { said, start } from "./support/pi.ts";

/** Runs one Pi session that talks to the agent, then quits Pi, as a user would. */
async function earlierRun(prompts: string[]) {
  const first = await start();
  // oxlint-disable-next-line no-await-in-loop -- prompts are a conversation, one after another
  for (const prompt of prompts) await first.session.prompt(prompt);
  const anchor = first.assistants().at(-1)?.responseId ?? "";
  await first.stop();
  return { home: first.home, agentSession: anchor.slice(0, anchor.indexOf("/")) };
}

const texts = (prompt: { type: string; text?: string }[] | undefined) =>
  (prompt ?? []).map((block) => (block.type === "text" ? block.text : `[${block.type}]`));

test("reopening a Pi session continues its agent conversation instead of replaying it", async () => {
  const { home, agentSession } = await earlierRun(["hello", "how are you"]);
  const { session, stop, assistants } = await start({ home });
  expect(session.messages.length, "Pi reopened the saved session").toBeGreaterThan(0);
  await session.prompt("again");
  expect(said(assistants().at(-1))).toBe("echo: again");
  const log = await stop();
  expect(log.loads).toStrictEqual([agentSession]);
  expect(log.sessions.length, "no new agent session").toBe(0);
  expect(log.prompts.map(texts)).toStrictEqual([["again"]]);
});

test("when the agent no longer has the conversation, a new one starts with Pi's history", async () => {
  const { home, agentSession } = await earlierRun(["hello"]);
  await rm(join(home, "agy-sessions.json"));
  const { session, stop } = await start({ home });
  await session.prompt("again");
  const log = await stop();
  expect(log.loads).toStrictEqual([agentSession]);
  expect(log.sessions.length).toBe(1);
  expect(log.prompts.map(texts)).toStrictEqual([["[resource]", "again"]]);
});

test("when the agent's conversation went past Pi's transcript, it is closed and a new one starts", async () => {
  const { home, agentSession } = await earlierRun(["hello"]);
  const store = join(home, "agy-sessions.json");
  const saved: unknown = JSON.parse(await readFile(store, "utf8"));
  expect.assert(typeof saved === "object" && saved !== null);
  const other = [{ type: "text", text: "a prompt Pi never saw" }];
  const found: unknown = Reflect.get(saved, agentSession);
  expect.assert(Array.isArray(found));
  const prompts: unknown[] = found;
  await writeFile(store, JSON.stringify({ ...saved, [agentSession]: [...prompts, other] }));

  const { session, stop } = await start({ home });
  await session.prompt("again");
  const log = await stop();
  expect(log.loads).toStrictEqual([agentSession]);
  expect(log.closes).toStrictEqual([agentSession]);
  expect(log.sessions.length).toBe(1);
  expect(log.prompts.map(texts)).toStrictEqual([["[resource]", "again"]]);
});

test("an agent that cannot load sessions gets a new one with Pi's history", async () => {
  const { home } = await earlierRun(["hello"]);
  const { session, stop } = await start({ home, restore: false });
  await session.prompt("again");
  const log = await stop();
  expect(log.loads).toStrictEqual([]);
  expect(log.sessions.length).toBe(1);
  expect(log.prompts.map(texts)).toStrictEqual([["[resource]", "again"]]);
});

test("a fresh Pi session never loads an agent conversation", async () => {
  const { session, stop } = await start();
  await session.prompt("hello");
  const log = await stop();
  expect(log.loads).toStrictEqual([]);
  expect(log.sessions.length).toBe(1);
});
