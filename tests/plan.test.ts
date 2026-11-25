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
