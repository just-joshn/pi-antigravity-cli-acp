import type { PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk/unstable";

const PLAN_LIMIT = 100;
const TEXT_LIMIT = 500;
const MARKDOWN_LINES = 20;
/** Marks by step status; the agent may send a status this extension does not know. */
const MARK: ReadonlyMap<string, string> = new Map([
	["completed", "[x]"],
	["in_progress", "[>]"],
	["pending", "[ ]"],
]);

export type Plan =
	| { id: string | undefined; steps: readonly PlanEntry[]; finished: boolean }
	| { id: string; markdown: readonly string[]; total: number };

type PlanUpdate = Extract<SessionUpdate, { sessionUpdate: "plan" | "plan_update" | "plan_removed" }>;

export function isPlanUpdate(update: SessionUpdate): update is PlanUpdate {
	return ["plan", "plan_update", "plan_removed"].includes(update.sessionUpdate);
}

/** The first steps of a plan, and whether every step, shown or not, is done. */
function steps(id: string | undefined, entries: readonly PlanEntry[]): Plan {
	const shown = entries.slice(0, PLAN_LIMIT).map((entry) => ({
		content: entry.content.slice(0, TEXT_LIMIT),
		priority: entry.priority,
		status: entry.status,
	}));
	return { id, steps: shown, finished: entries.every((entry) => entry.status === "completed") };
}

export function nextPlan(current: Plan | undefined, update: PlanUpdate): Plan | undefined {
	if (update.sessionUpdate === "plan") return steps(undefined, update.entries);
	if (update.sessionUpdate === "plan_removed") return current?.id === update.planId ? undefined : current;
	const { plan } = update;
	// The plan comes from the agent, which may send a kind this SDK does not know; it is ignored.
	if (plan.type === "items" && "entries" in plan) return steps(plan.planId, plan.entries);
	if (plan.type === "markdown" && "content" in plan) {
		const lines = plan.content.split("\n").filter((line) => line.trim() !== "");
		const markdown = lines.slice(0, PLAN_LIMIT).map((line) => line.slice(0, TEXT_LIMIT));
		return { id: plan.planId, markdown, total: lines.length };
	}
	return current;
}

export function planLines(plan: Plan | undefined): string[] | undefined {
	if (!plan) return undefined;
	if ("markdown" in plan) {
		const shown = plan.markdown.slice(0, MARKDOWN_LINES);
		const more = plan.total - shown.length;
		return ["Antigravity plan", ...shown, ...(more > 0 ? [`… ${more} more lines`] : [])];
	}
	if (plan.finished) return undefined;
	return ["Antigravity plan", ...plan.steps.map((entry) => `${MARK.get(entry.status) ?? "[ ]"} ${entry.content}`)];
}
