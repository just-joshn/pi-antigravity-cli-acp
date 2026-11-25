import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";

import { labels } from "../src/sessions.ts";
import { fakeUi, said, start } from "./support/pi.ts";

const texts = (prompt: { type: string; text?: string }[] | undefined) =>
  (prompt ?? []).map((block) => (block.type === "text" ? block.text : `[${block.type}]`));

test("/agy sessions opens a saved agent conversation as a new Pi session that continues it", async () => {
  const first = await start();
  await first.session.prompt("hello");
  await first.session.prompt("how are you");
  const agentSession = (first.assistants().at(-1)?.responseId ?? "").split("/")[0];
  await first.stop();

  // Pi's own newSession; the test writes the new session file the way Pi would.
  const { ui, dialogs } = fakeUi(["hello — 2026-11-25 10:00"]);
  const opened: SessionManager[] = [];
  const browse = await start({
    home: first.home,
    ui,
    newSession: async (options) => {
      const manager = SessionManager.create(join(first.home, "work"), join(first.home, "sessions"));
      await options?.setup?.(manager);
      opened.push(manager);
      return { cancelled: false };
    },
  });
  await browse.session.prompt("/agy sessions");
  expect(dialogs[0]?.title).toBe("Open an Antigravity session");
  const browseLog = await browse.stop();
  expect(browseLog.closes, "the session read for its transcript is freed").toStrictEqual([
    agentSession,
  ]);
  const messages = opened[0]?.buildSessionContext().messages ?? [];
  expect(messages.map((m) => m.role)).toStrictEqual(["user", "assistant", "user", "assistant"]);
  expect(opened[0]?.getSessionName()).toBe("hello");

  const resumed = await start({ home: first.home });
  await resumed.session.prompt("again");
  expect(said(resumed.assistants().at(-1))).toBe("echo: again");
  const log = await resumed.stop();
  expect(log.loads).toStrictEqual([agentSession]);
  expect(log.sessions.length, "no new agent session").toBe(0);
  expect(log.prompts.map(texts)).toStrictEqual([["again"]]);
});

test("/agy sessions says so when there is nothing to open", async () => {
  const { ui, notes } = fakeUi();
  const { session } = await start({ ui });
  await session.prompt("/agy sessions");
  expect(notes.at(-1)).toBe("info: Antigravity has no saved sessions for this directory.");
});

test("a session the agent lists but cannot open is reported, and a dismissed list changes nothing", async () => {
  vi.stubEnv("FAKE_AGY_GHOST", "vanished");
  const { ui, notes } = fakeUi(["vanished", undefined]);
  const { session } = await start({ ui });
  await session.prompt("/agy sessions");
  expect(notes.at(-1)).toBe("warning: Antigravity no longer has that session.");
  await session.prompt("/agy sessions");
  expect(notes.length).toBe(1);
});

test("session labels are numbered when they repeat, and show what is known", () => {
  const when = "2026-11-25T10:00:00Z";
  expect(
    labels([
      { id: "a", title: "Fix", updatedAt: when },
      { id: "b", title: "Fix", updatedAt: when },
      { id: "c", title: undefined, updatedAt: undefined },
    ]),
  ).toStrictEqual(["Fix — 2026-11-25 10:00", "Fix — 2026-11-25 10:00 (2)", "Untitled"]);
});

test("/agy sessions does not reopen the session already in use", async () => {
  const { ui, notes } = fakeUi(["hello — 2026-11-25 10:00"]);
  const { session, stop } = await start({ ui });
  await session.prompt("hello");
  await session.prompt("/agy sessions");
  expect(notes.at(-1)).toBe("info: That Antigravity session is the one in use here.");
  await session.prompt("again");
  const log = await stop();
  expect([log.closes, log.loads]).toStrictEqual([[], []]);
});
