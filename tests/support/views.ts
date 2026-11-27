import type { ToolView } from "../../src/session.ts";
import type { ToolDetails } from "../../src/tool.ts";

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

export const details = (patch: Partial<ToolDetails>): ToolDetails => ({
	kind: "edit",
	title: "File a.txt",
	status: "completed",
	declined: false,
	diffs: [],
	output: "",
	...patch,
});
