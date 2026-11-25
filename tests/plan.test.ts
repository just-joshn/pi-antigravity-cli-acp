import { expect, test } from "vitest";

import { fakeUi, said, start } from "./support/pi.ts";

test("the agent's plan shows above the editor while it works and goes away when every step is done", async () => {
  const { ui, widgets } = fakeUi();
  const { session, assistants } = await start({ ui });
  await session.prompt("make a plan");
  expect(said(assistants().at(-1))).toBe("Planned and done.");
  expect(
    widgets.filter(([key]) => key === "antigravity-plan").map(([, lines]) => lines),
  ).toStrictEqual([
    ["Antigravity plan", "[>] Look around", "[ ] Write it"],
    ["Antigravity plan", "[x] Look around", "[>] Write it"],
    undefined,
  ]);
});

test("the plan goes away when the agent process dies", async () => {
  const { ui, widgets } = fakeUi();
  const { session } = await start({ ui, settings: { retry: { baseDelayMs: 1 } } });
  await session.prompt("hello");
  await session.prompt("die planning");
  const plans = widgets.filter(([key]) => key === "antigravity-plan").map(([, lines]) => lines);
  expect(plans).toStrictEqual([["Antigravity plan", "[>] Look around"], undefined]);
});
