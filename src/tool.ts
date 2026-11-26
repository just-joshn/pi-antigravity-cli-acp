import { basename } from "node:path";

import { isRecord } from "./guards.ts";
import type { ToolView } from "./session.ts";

export const TOOL_NAME = "antigravity_tool";
const OUTPUT_LIMIT = 20_000;

export interface ToolDetails {
  kind: string;
  title: string;
  status: string;
  declined: boolean;
  diffs: { path: string; oldText: string; newText: string }[];
  output: string;
}

interface MirrorResult {
  content: { type: "text"; text: string }[];
  details: ToolDetails;
  isError: boolean;
}

/** Arguments of the mirrored Pi tool call: what the agent is doing, in its own words. */
export function toolArguments(tool: ToolView) {
  const path = tool.paths[0];
  const title = tool.title || tool.kind;
  const named = path === undefined || title.includes(basename(path));
  return { kind: tool.kind, title: named ? title : `${title} ${path}` };
}

/** Keys under which the Antigravity servers put a command's output in `rawOutput`. */
const OUTPUT_KEYS = ["output", "combinedOutput", "formatted_output"];

function outputOf(tool: ToolView): string {
  const parts = tool.content.flatMap((item) =>
    item.type === "content" && item.content.type === "text" ? [item.content.text] : [],
  );
  if (tool.terminalOutput) parts.push(tool.terminalOutput);
  const raw = tool.rawOutput;
  if (parts.length === 0 && typeof raw === "string") parts.push(raw);
  else if (parts.length === 0 && isRecord(raw)) {
    const found = OUTPUT_KEYS.map((key) => raw[key]).find((value) => typeof value === "string");
    if (typeof found === "string") parts.push(found);
  }
  const text = parts.join("\n").replaceAll("\r\n", "\n");
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n[output truncated]` : text;
}

/** The result Pi shows while a mirrored call runs and records once it is done. */
export function toolResult(tool: ToolView | undefined, state: "running" | "done"): MirrorResult {
  if (!tool) {
    return {
      content: [
        {
          type: "text",
          text: "No Antigravity tool call matches this request. The agent's session may have ended; this tool only shows the agent's own calls.",
        },
      ],
      details: {
        kind: "other",
        title: "",
        status: "failed",
        declined: false,
        diffs: [],
        output: "",
      },
      isError: true,
    };
  }
  const { title } = toolArguments(tool);
  const diffs = tool.content.flatMap((item) =>
    item.type === "diff"
      ? [{ path: item.path, oldText: item.oldText ?? "", newText: item.newText }]
      : [],
  );
  const output = outputOf(tool);
  const declined = tool.decision === "declined";
  const finished = tool.status === "completed" || tool.status === "failed";
  let text = output || diffs.map((diff) => `Edited ${diff.path}`).join("\n");
  if (declined) text = `Permission declined: ${title}`;
  else if (state === "done" && !finished) text = `${title}: stopped before it finished`;
  else if (!text) text = `${title}: ${tool.status}`;
  return {
    content: [{ type: "text", text }],
    details: { kind: tool.kind, title, status: tool.status, declined, diffs, output },
    isError: state === "done" && (declined || tool.status !== "completed"),
  };
}

/** Dialog labels for the agent's permission options, made unique when two share a name. */
export function choiceLabels(options: readonly { name: string; kind: string }[]): string[] {
  const named = new Map<string, number>();
  for (const { name } of options) named.set(name, (named.get(name) ?? 0) + 1);
  const used = new Set<string>();
  const result: string[] = [];
  for (const [index, option] of options.entries()) {
    const shared = (named.get(option.name) ?? 0) > 1;
    const label = shared ? `${option.name} [${option.kind.replaceAll("_", " ")}]` : option.name;
    const unique = used.has(label) ? `${label} #${index + 1}` : label;
    used.add(unique);
    result.push(unique);
  }
  return result;
}

type Watch = (
  signal: AbortSignal | undefined,
  onChange: (tool: ToolView) => void,
) => Promise<ToolView | undefined>;

/** Waits for the agent to finish a tool call and reports it the way a Pi tool reports its own work. */
export async function runMirror(
  watch: Watch,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: MirrorResult) => void) | undefined,
): Promise<MirrorResult> {
  const tool = await watch(signal, (running) => onUpdate?.(toolResult(running, "running")));
  return toolResult(tool, "done");
}
