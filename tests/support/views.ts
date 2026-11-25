import type { ToolView } from "../../src/session.ts";
import { type ToolDetails, toolResult } from "../../src/tool.ts";

/** A settled edit the agent made, with fields replaced by `patch`. */
export function view(patch: Partial<ToolView>): ToolView {
  return {
    id: "t1",
    kind: "edit",
    title: "File a.txt",
    paths: [],
    status: "completed",
    content: [],
    rawOutput: undefined,
    terminalOutput: "",
    decision: undefined,
    settled: true,
    ...patch,
  };
}

/** The mirror tool's details for a finished call, with fields replaced by `patch`. */
export const details = (patch: Partial<ToolDetails>): ToolDetails => ({
  ...toolResult(view({}), "done").details,
  ...patch,
});
