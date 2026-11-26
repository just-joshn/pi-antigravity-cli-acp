import type { PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk/unstable";

const PLAN_LIMIT = 100;
const TEXT_LIMIT = 500;
const MARKDOWN_LINES = 20;
const MARK = { completed: "[x]", in_progress: "[>]", pending: "[ ]" } as const;

/** The agent's current plan: a list of steps, or markdown it keeps until it removes the plan. */
export type Plan =
  | { id: string | undefined; steps: readonly PlanEntry[] }
  | { id: string; markdown: readonly string[] };

type PlanUpdate = Extract<
  SessionUpdate,
  { sessionUpdate: "plan" | "plan_update" | "plan_removed" }
>;

export function isPlanUpdate(update: SessionUpdate): update is PlanUpdate {
  return ["plan", "plan_update", "plan_removed"].includes(update.sessionUpdate);
}

function steps(entries: readonly PlanEntry[]): PlanEntry[] {
  return entries.slice(0, PLAN_LIMIT).map((entry) => ({
    content: entry.content.slice(0, TEXT_LIMIT),
    priority: entry.priority,
    status: entry.status,
  }));
}

/** The plan after an update: ACP's original `plan`, or the newer `plan_update` and `plan_removed`. */
export function nextPlan(current: Plan | undefined, update: PlanUpdate): Plan | undefined {
  if (update.sessionUpdate === "plan") return { id: undefined, steps: steps(update.entries) };
  if (update.sessionUpdate === "plan_removed")
    return current?.id === update.planId ? undefined : current;
  const { plan } = update;
  // The plan comes from the agent, which may send a kind this SDK does not know; it is ignored.
  if (plan.type === "items" && "entries" in plan)
    return { id: plan.planId, steps: steps(plan.entries) };
  if (plan.type === "markdown" && "content" in plan) {
    const lines = plan.content.split("\n").filter((line) => line.trim() !== "");
    return { id: plan.planId, markdown: lines.map((line) => line.slice(0, TEXT_LIMIT)) };
  }
  return current;
}

/** The plan widget's lines, or undefined when there is nothing left to show. */
export function planLines(plan: Plan | undefined): string[] | undefined {
  if (!plan) return undefined;
  if ("markdown" in plan) {
    const shown = plan.markdown.slice(0, MARKDOWN_LINES);
    const more = plan.markdown.length - shown.length;
    return ["Antigravity plan", ...shown, ...(more > 0 ? [`… ${more} more lines`] : [])];
  }
  if (plan.steps.every((entry) => entry.status === "completed")) return undefined;
  return [
    "Antigravity plan",
    ...plan.steps.map((entry) => `${MARK[entry.status]} ${entry.content}`),
  ];
}
