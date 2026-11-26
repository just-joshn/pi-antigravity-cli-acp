import { basename } from "node:path";

import { isRecord } from "./guards.ts";
import { occurrences } from "./occurrences.ts";
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

/** The output a command reported in `rawOutput`, under one of the keys the servers use. */
function rawParts(raw: unknown): string[] {
  if (typeof raw === "string") return [raw];
  const found = isRecord(raw)
    ? OUTPUT_KEYS.map((key) => raw[key]).find((value) => typeof value === "string")
    : undefined;
  return typeof found === "string" ? [found] : [];
}

function outputOf(tool: ToolView): string {
  const texts = tool.content.flatMap((item) =>
    item.type === "content" && item.content.type === "text" ? [item.content.text] : [],
  );
  const shown = tool.terminalOutput ? [...texts, tool.terminalOutput] : texts;
  const parts = shown.length > 0 ? shown : rawParts(tool.rawOutput);
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
  const labels = occurrences(options, ({ name }) => name).map(({ item, of }, index) => ({
    index,
    label: of > 1 ? `${item.name} [${item.kind.replaceAll("_", " ")}]` : item.name,
  }));
  return distinct(labels, new Set());
}

/** Each label, numbered when an earlier one, as given out, is the same. A dialog has few options. */
function distinct(
  labels: readonly { index: number; label: string }[],
  used: ReadonlySet<string>,
): string[] {
  const [first, ...rest] = labels;
  if (!first) return [];
  const label = used.has(first.label) ? `${first.label} #${first.index + 1}` : first.label;
  return [label, ...distinct(rest, new Set([...used, label]))];
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
