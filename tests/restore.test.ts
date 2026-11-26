import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vitest";

import { isRecord } from "../src/guards.ts";
import { NOT_RESENT } from "../src/stream.ts";
import { agentStore, said, start, texts } from "./support/pi.ts";

/** Runs one Pi session that talks to the agent, then quits Pi, as a user would. */
async function earlierRun(prompts: string[]) {
  const first = await start();
  // oxlint-disable-next-line no-await-in-loop -- prompts are a conversation, one after another
  for (const prompt of prompts) await first.session.prompt(prompt);
  const anchor = first.assistants().at(-1)?.responseId ?? "";
  await first.stop();
  return { home: first.home, agentSession: anchor.slice(0, anchor.indexOf("/")) };
}

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
  const saved = await agentStore(home);
  const other = [{ type: "text", text: "a prompt Pi never saw" }];
  const prompts = [...(saved[agentSession] ?? []), other];
  await writeFile(store, JSON.stringify({ ...saved, [agentSession]: prompts }));

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

test("after Pi reloads its extensions, the agent conversation continues in a new agent process", async () => {
  const { session, stop, assistants } = await start();
  await session.prompt("hello");
  const before = assistants().at(-1)?.responseId ?? "";
  await session.reload();
  await session.prompt("again");
  const after = assistants().at(-1)?.responseId ?? "";
  const log = await stop();
  const agentSession = before.slice(0, before.indexOf("/"));
  expect(after).toBe(`${agentSession}/2.1`);
  expect(log.loads, "the reloaded extension started its own agent").toStrictEqual([agentSession]);
  expect(log.prompts.map(texts)).toStrictEqual([["again"]]);
});

test("when the agent process dies mid-turn, the message is not sent again and the next one works", async () => {
  const { session, stop, assistants, home } = await start({
    settings: { retry: { baseDelayMs: 1 } },
  });
  await session.prompt("hello");
  await session.prompt("crash now");
  const failed = assistants().at(-1);
  expect(failed?.stopReason).toBe("error");
  expect(failed?.errorMessage).toBe(NOT_RESENT);
  await session.prompt("after");
  expect(said(assistants().at(-1))).toMatch(/after$/);
  const log = await stop();
  const prompts = Object.values(await agentStore(home)).flat();
  const crashes = prompts.filter(
    (prompt) =>
      Array.isArray(prompt) &&
      prompt.some((block) => isRecord(block) && block["text"] === "crash now"),
  );
  expect(crashes.length, "the agent got the crashing message once").toBe(1);
  // The dead agent saved the crashing prompt, which Pi's transcript never answered.
  expect(log.closes.length, "the reopened session went past Pi's transcript").toBe(1);
  expect(log.sessions.length).toBe(1);
  expect(log.prompts.map(texts)).toStrictEqual([["[resource]", "after"]]);
});

test("tool calls after reopening an agent session get ids the transcript has not used", async () => {
  const { home } = await earlierRun(["please read it"]);
  const { session, stop } = await start({ home });
  await session.prompt("read it again");
  await stop();
  const ids = session.messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
      : [],
  );
  expect(ids.length).toBe(2);
  expect(new Set(ids).size, JSON.stringify(ids)).toBe(2);
});
