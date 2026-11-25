import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";

import type { ToolView } from "./session.ts";
import { TOOL_NAME, toolArguments } from "./tool.ts";

/** Usage of a message the agent's tokens are not counted against. */
export function noUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

type Content = AssistantMessage["content"][number];

/**
 * Writes one Pi assistant message as the agent's events arrive. Every change makes a new message;
 * each event carries the message as it was then.
 */
export class Draft {
  readonly events = createAssistantMessageEventStream();
  #message: AssistantMessage;
  #open: "text" | "thinking" | undefined;

  constructor(model: Model<string>) {
    this.#message = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      content: [],
      usage: noUsage(),
      stopReason: "pending",
    };
  }

  get message(): AssistantMessage {
    return this.#message;
  }

  update(patch: Partial<AssistantMessage>) {
    this.#message = { ...this.#message, ...patch };
  }

  append(kind: "text" | "thinking", delta: string) {
    if (this.#open !== kind) {
      this.close();
      this.#open = kind;
      this.#add(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
      this.events.push({
        type: `${kind}_start`,
        contentIndex: this.#index,
        partial: this.#message,
      });
    }
    const block = this.#message.content[this.#index];
    if (block?.type === "text") this.#replaceLast({ ...block, text: block.text + delta });
    else if (block?.type === "thinking")
      this.#replaceLast({ ...block, thinking: block.thinking + delta });
    this.events.push({
      type: `${kind}_delta`,
      contentIndex: this.#index,
      delta,
      partial: this.#message,
    });
  }

  close() {
    const block = this.#message.content[this.#index];
    const partial = this.#message;
    if (this.#open === "text" && block?.type === "text")
      this.events.push({
        type: "text_end",
        contentIndex: this.#index,
        content: block.text,
        partial,
      });
    else if (this.#open === "thinking" && block?.type === "thinking")
      this.events.push({
        type: "thinking_end",
        contentIndex: this.#index,
        content: block.thinking,
        partial,
      });
    this.#open = undefined;
  }

  begin() {
    this.events.push({ type: "start", partial: this.#message });
  }

  finish(reason: "stop" | "length" | "toolUse") {
    this.close();
    this.update({ stopReason: reason });
    this.events.push({ type: "done", reason, message: this.#message });
  }

  fail(reason: "aborted" | "error", errorMessage: string) {
    this.update({ stopReason: reason, errorMessage });
    this.events.push({ type: "error", reason, error: this.#message });
  }

  call(id: string, tool: ToolView) {
    this.close();
    const toolCall = {
      type: "toolCall" as const,
      id,
      name: TOOL_NAME,
      arguments: toolArguments(tool),
    };
    this.#add(toolCall);
    const partial = this.#message;
    this.events.push({ type: "toolcall_start", contentIndex: this.#index, partial });
    this.events.push({ type: "toolcall_end", contentIndex: this.#index, toolCall, partial });
  }

  #add(block: Content) {
    this.update({ content: [...this.#message.content, block] });
  }

  #replaceLast(block: Content) {
    this.update({ content: [...this.#message.content.slice(0, -1), block] });
  }

  get #index() {
    return this.#message.content.length - 1;
  }
}
