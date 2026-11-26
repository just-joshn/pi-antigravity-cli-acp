/* oxlint-disable no-await-in-loop -- scripted steps run strictly in order */
/** How the scripted agent plays back one prompt turn, step by step. */
import {
  type AgentContext,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  methods,
  type PermissionOption,
  type PlanEntry,
  type RequestPermissionOutcome,
  type SessionUpdate,
  type StopReason,
  type ToolCall,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk/unstable";

/** One scripted action of the fake agent during a prompt turn. */
export type Step =
  | { say: string }
  | { think: string }
  | { tool: ToolCall }
  | { update: ToolCallUpdate }
  | { ask: string; options?: PermissionOption[]; allowed?: Step[]; declined?: Step[] }
  | { usage: [used: number, size: number] }
  | { title: string }
  | { elicit: CreateElicitationRequest }
  | { run: [command: string, ...args: string[]] }
  | { plan: PlanEntry[] }
  | { raw: SessionUpdate }
  | { read: string }
  | { write: [path: string, content: string] }
  | { hold: "cancel" | Promise<unknown> }
  | { fail: string }
  | { stop: StopReason };

/** A read the agent is still running, for tests that mirror one. */
export const readCall = {
  toolCallId: "t1",
  kind: "read" as const,
  title: "File a.txt",
  status: "in_progress" as const,
};

export const allow: PermissionOption = { kind: "allow_once", optionId: "allow", name: "Allow" };
export const deny: PermissionOption = { kind: "reject_once", optionId: "deny", name: "Deny" };

interface Playback {
  client: AgentContext;
  sessionId: string;
  cancelled: Promise<void>;
  /** Records the client's answer to a permission request. */
  answered: (outcome: RequestPermissionOutcome) => void;
  /** Records the client's answer to a question. */
  replied: (reply: CreateElicitationResponse) => void;
}

function send(pb: Playback, update: SessionUpdate) {
  return pb.client.notify(methods.client.session.update, { sessionId: pb.sessionId, update });
}

function say(pb: Playback, kind: "agent_message_chunk" | "agent_thought_chunk", text: string) {
  return send(pb, { sessionUpdate: kind, content: { type: "text", text } });
}

async function ask(pb: Playback, step: Extract<Step, { ask: string }>) {
  const offered = step.options ?? [allow, deny];
  const { outcome } = await pb.client.request(methods.client.session.requestPermission, {
    sessionId: pb.sessionId,
    toolCall: { toolCallId: step.ask },
    options: offered,
  });
  pb.answered(outcome);
  if (outcome.outcome === "cancelled") return "cancelled";
  const chosen = offered.find((option) => option.optionId === outcome.optionId);
  const granted = chosen?.kind.startsWith("allow") === true;
  return play(pb, (granted ? step.allowed : step.declined) ?? []);
}

/** Runs a command in a client terminal, shown in a tool call, and says how it ended. */
async function runInTerminal(
  pb: Playback,
  [command, ...args]: Extract<Step, { run: unknown }>["run"],
) {
  const { client, sessionId } = pb;
  const { terminalId } = await client.request(methods.client.terminal.create, {
    sessionId,
    command,
    args,
  });
  const toolCallId = `run-${terminalId}`;
  const content = [{ type: "terminal" as const, terminalId }];
  await send(pb, {
    sessionUpdate: "tool_call",
    toolCallId,
    kind: "execute",
    title: command,
    content,
  });
  const exit = await client.request(methods.client.terminal.waitForExit, { sessionId, terminalId });
  const { output } = await client.request(methods.client.terminal.output, {
    sessionId,
    terminalId,
  });
  await send(pb, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
  await client.request(methods.client.terminal.release, { sessionId, terminalId });
  await say(pb, "agent_message_chunk", `exit ${exit.exitCode}: ${output}`);
}

/** Performs one step; a stop reason ends the turn. */
async function perform(pb: Playback, step: Step): Promise<StopReason | undefined> {
  const { client, sessionId } = pb;
  if ("say" in step) await say(pb, "agent_message_chunk", step.say);
  else if ("think" in step) await say(pb, "agent_thought_chunk", step.think);
  else if ("tool" in step) await send(pb, { sessionUpdate: "tool_call", ...step.tool });
  else if ("update" in step) await send(pb, { sessionUpdate: "tool_call_update", ...step.update });
  else if ("plan" in step) await send(pb, { sessionUpdate: "plan", entries: step.plan });
  else if ("raw" in step) await send(pb, step.raw);
  else if ("run" in step) await runInTerminal(pb, step.run);
  else if ("elicit" in step) {
    // A question with an empty session id is about the session being played.
    const question =
      "sessionId" in step.elicit && step.elicit.sessionId === ""
        ? { ...step.elicit, sessionId }
        : step.elicit;
    const reply = await client.request(methods.client.elicitation.create, question);
    pb.replied(reply);
    await say(pb, "agent_message_chunk", JSON.stringify(reply));
  } else if ("title" in step)
    await send(pb, { sessionUpdate: "session_info_update", title: step.title });
  else if ("usage" in step) {
    const [used, size] = step.usage;
    await send(pb, { sessionUpdate: "usage_update", used, size });
  } else if ("read" in step) {
    const file = await client.request(methods.client.fs.readTextFile, {
      sessionId,
      path: step.read,
    });
    await say(pb, "agent_message_chunk", file.content);
  } else if ("write" in step) {
    const [path, content] = step.write;
    await client.request(methods.client.fs.writeTextFile, { sessionId, path, content });
  } else if ("ask" in step) return ask(pb, step);
  else if ("hold" in step) {
    if (step.hold !== "cancel") await step.hold;
    else return pb.cancelled.then(() => "cancelled" as const);
  } else if ("fail" in step) throw new Error(step.fail);
  else return step.stop;
  return undefined;
}

export async function play(pb: Playback, steps: Step[]): Promise<StopReason | undefined> {
  for (const step of steps) {
    const stop = await perform(pb, step);
    if (stop) return stop;
  }
  return undefined;
}
