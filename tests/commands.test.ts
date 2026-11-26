import { expect, test, vi } from "vitest";

import { fakeUi, said, start } from "./support/pi.ts";

const completions = async (session: Awaited<ReturnType<typeof start>>["session"], prefix: string) =>
  session.extensionRunner.getCommand("agy")?.getArgumentCompletions?.(prefix);

test("the agent's own commands complete under /agy and run as an ordinary prompt", async () => {
  const { session, stop, assistants } = await start();
  await session.prompt("hello");
  expect(await completions(session, "go")).toStrictEqual([
    { value: "goal", label: "goal", description: "Run until the goal is done. (the goal)" },
  ]);
  await session.prompt("/agy goal ship it");
  await vi.waitFor(() => expect(said(assistants().at(-1))).toBe("echo: /goal ship it"));
  const log = await stop();
  expect(log.prompts.at(-1)).toStrictEqual([{ type: "text", text: "/goal ship it" }]);
});

test("the agent's commands are known in the next Pi session before any message", async () => {
  const first = await start();
  await first.session.prompt("hello");
  await first.stop();
  const { session } = await start({ home: first.home });
  expect(await completions(session, "comp")).toStrictEqual([
    { value: "compact", label: "compact", description: "Compact the conversation now." },
  ]);
});

test("an agent command needs an antigravity model selected", async () => {
  const { ui, notes } = fakeUi();
  const { session, stop } = await start({ ui });
  await session.prompt("hello");
  const other = session.modelRuntime.getModel("other", "other-model");
  expect.assert(other);
  await session.setModel(other);
  await session.prompt("/agy goal ship it");
  expect(notes().at(-1)).toBe(
    "warning: /agy goal runs in the Antigravity agent. Select an antigravity model with /model first.",
  );
  expect((await stop()).prompts.length).toBe(1);
});

test("an agent command named like an /agy subcommand is not offered under /agy", async () => {
  const { session } = await start();
  await session.prompt("hello");
  const offered = await completions(session, "");
  expect(
    offered?.filter((option) => option.value === "status" || option.value === "mode").length,
  ).toBe(2);
});

test("/agy with a name only an object has, like constructor, shows the usage", async () => {
  const { ui, notes } = fakeUi();
  const { session } = await start({ ui });
  for (const name of ["constructor", "__proto__", "toString"]) {
    // oxlint-disable-next-line no-await-in-loop -- one command at a time, as typed
    await session.prompt(`/agy ${name}`);
    expect(notes().at(-1), name).toMatch(/^warning: Usage: \/agy status/);
  }
});
