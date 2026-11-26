import { diff as lineDiff } from "node:util";

import type { Theme } from "@earendil-works/pi-coding-agent";

import type { ToolDetails } from "./tool.ts";

type Paint = Pick<Theme, "fg" | "bold">;

const COLLAPSED_LINES = 8;
const LABELS: Record<string, string> = {
  execute: "$",
  switch_mode: "mode",
  other: "tool",
};

/** The lines one text removes and the other adds, from a line-by-line diff of the two. */
export function changedLines(oldText: string, newText: string) {
  const before = oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n");
  const after = newText === "" ? [] : newText.replace(/\n$/, "").split("\n");
  // util.diff marks a line only in the first text 1 and a line only in the second -1.
  const steps = lineDiff(before, after);
  return {
    removed: steps.flatMap(([op, line]) => (op === 1 ? [line] : [])),
    added: steps.flatMap(([op, line]) => (op === -1 ? [line] : [])),
  };
}

/** Header of a mirrored tool call: what the agent is doing. */
export function callLine(args: { kind: string; title: string }, theme: Paint): string {
  const label = (Object.hasOwn(LABELS, args.kind) ? LABELS[args.kind] : undefined) ?? args.kind;
  return `${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("accent", args.title)}`;
}

/** Body of a mirrored tool call: its progress, diff or output. */
export function resultLines(
  details: ToolDetails,
  view: { expanded: boolean; isPartial: boolean },
  theme: Paint,
): string[] {
  if (view.isPartial)
    return [theme.fg("muted", details.status === "pending" ? "waiting for approval…" : "running…")];
  if (details.declined) return [theme.fg("warning", "declined")];
  const failed = details.status === "failed";
  const diffs = details.diffs.flatMap((diff) => {
    const { added, removed } = changedLines(diff.oldText, diff.newText);
    const header = `${theme.fg("muted", diff.path)} ${theme.fg("toolDiffAdded", `+${added.length}`)} ${theme.fg("toolDiffRemoved", `-${removed.length}`)}`;
    if (!view.expanded) return [header];
    return [
      header,
      ...removed.map((line) => theme.fg("toolDiffRemoved", `- ${line}`)),
      ...added.map((line) => theme.fg("toolDiffAdded", `+ ${line}`)),
    ];
  });
  const trimmed = details.output.trimEnd();
  const output = trimmed === "" ? [] : trimmed.split("\n");
  const shown = view.expanded ? output : output.slice(0, COLLAPSED_LINES);
  const hidden = output.length - shown.length;
  const lines = [
    ...diffs,
    ...shown.map((line) => theme.fg(failed ? "error" : "toolOutput", line)),
    ...(hidden > 0 ? [theme.fg("muted", `… ${hidden} more lines`)] : []),
  ];
  if (lines.length > 0) return lines;
  if (failed) return [theme.fg("error", "failed")];
  return [
    details.status === "completed" ? theme.fg("muted", "done") : theme.fg("warning", "stopped"),
  ];
}
