import { expect, test } from "vitest";

import { nextPlan, planLines } from "../src/plan.ts";
import { fakeUi, said, start } from "./support/pi.ts";

test("the agent's plan shows above the editor while it works and goes away when every step is done", async () => {
  const { ui, widgets } = fakeUi();
  const { session, assistants } = await start({ ui });
  await session.prompt("make a plan");
  expect(said(assistants().at(-1))).toBe("Planned and done.");
  expect(
    widgets()
      .filter(([key]) => key === "antigravity-plan")
      .map(([, lines]) => lines),
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
  const plans = widgets()
    .filter(([key]) => key === "antigravity-plan")
    .map(([, lines]) => lines);
  expect(plans).toStrictEqual([["Antigravity plan", "[>] Look around"], undefined]);
});

const step = (content: string, status: "pending" | "in_progress" | "completed") => ({
  content,
  status,
  priority: "medium" as const,
});

test("plans arrive as entry lists or markdown, and the latest replaces the last", () => {
  let plan = nextPlan(undefined, { sessionUpdate: "plan", entries: [step("a", "in_progress")] });
  expect(planLines(plan)).toStrictEqual(["Antigravity plan", "[>] a"]);
  plan = nextPlan(plan, {
    sessionUpdate: "plan_update",
    plan: { type: "items", planId: "p1", entries: [step("a", "completed"), step("b", "pending")] },
  });
  expect(planLines(plan)).toStrictEqual(["Antigravity plan", "[x] a", "[ ] b"]);
  plan = nextPlan(plan, {
    sessionUpdate: "plan_update",
    plan: { type: "markdown", planId: "p2", content: "# Steps\n\n1. Look\n2. Write\n" },
  });
  expect(planLines(plan)).toStrictEqual(["Antigravity plan", "# Steps", "1. Look", "2. Write"]);
  expect(
    nextPlan(plan, { sessionUpdate: "plan_removed", planId: "p1" }),
    "another plan's removal",
  ).toBe(plan);
  expect(nextPlan(plan, { sessionUpdate: "plan_removed", planId: "p2" })).toBeUndefined();
});

test("a finished plan and a long one are shown sensibly", () => {
  const done = nextPlan(undefined, { sessionUpdate: "plan", entries: [step("a", "completed")] });
  expect(planLines(done), "nothing left to do").toBeUndefined();
  expect(planLines(undefined)).toBeUndefined();
  const long = nextPlan(undefined, {
    sessionUpdate: "plan_update",
    plan: {
      type: "markdown",
      planId: "p",
      content: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
    },
  });
  const lines = planLines(long) ?? [];
  expect(lines.length).toBe(22);
  expect(lines.at(-1)).toBe("… 10 more lines");
  const many = nextPlan(undefined, {
    sessionUpdate: "plan",
    entries: Array.from({ length: 500 }, () => step("x".repeat(10_000), "pending")),
  });
  expect(planLines(many)?.length, "100 entries, the title and nothing more").toBe(101);
  expect(planLines(many)?.[1]?.length).toBe(504);
});

test("a markdown plan shows above the editor until the agent removes it", async () => {
  const { ui, widgets } = fakeUi();
  const { session } = await start({ ui });
  await session.prompt("a markdown plan");
  const plans = widgets()
    .filter(([key]) => key === "antigravity-plan")
    .map(([, lines]) => lines);
  expect(plans).toStrictEqual([["Antigravity plan", "1. Look", "2. Write"], undefined]);
});

test("a plan step with a status the extension does not know is shown as not started", () => {
  const odd = Object.assign({}, step("a", "pending"), { status: "constructor" });
  expect(planLines(nextPlan(undefined, { sessionUpdate: "plan", entries: [odd] }))).toStrictEqual([
    "Antigravity plan",
    "[ ] a",
  ]);
});

test("a long markdown plan keeps 100 lines and counts the rest", () => {
  const huge = nextPlan(undefined, {
    sessionUpdate: "plan_update",
    plan: {
      type: "markdown",
      planId: "p",
      content: Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join("\n"),
    },
  });
  expect.assert(huge && "markdown" in huge);
  expect(huge.markdown.length).toBe(100);
  expect(planLines(huge)?.at(-1)).toBe("… 9980 more lines");
});
