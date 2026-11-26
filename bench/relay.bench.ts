/**
 * The extension's own cost, with the model and network replaced by a scripted agent in the same
 * process. The paired cases run the same exchange through the bare ACP SDK, which only counts the
 * updates, and through the extension into Pi's provider events. The difference is what the
 * extension adds, including building Pi's events and assistant message, which any Pi provider does.
 */
import {
  client,
  type ContentBlock,
  methods,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk/unstable";
import { normalizeContext } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";

import { AGENT_DEFAULT, emptyCatalog, piModels } from "../src/catalog.ts";
import { Conversation } from "../src/conversation.ts";
import { createStream } from "../src/stream.ts";
import { type FakeAgentOptions, serveAgent } from "../tests/support/fake-agent.ts";
import { connect, pair } from "../tests/support/harness.ts";
import type { Step } from "../tests/support/playback.ts";

const CHUNKS = 1000;
const chunks = Array.from({ length: CHUNKS }, (_, i) => ({ say: `word${i} ` }));
const bigOutput = "x".repeat(200_000);
const toolTurn: Step[] = [
  { tool: { toolCallId: "t", kind: "read", title: "big.txt", status: "in_progress" } },
  {
    update: {
      toolCallId: "t",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: bigOutput } }],
    },
  },
  { say: "done" },
];
/** `default` leaves the agent on its own model, so the turn needs no model change. */
const model = (() => {
  const found = piModels(emptyCatalog).find((entry) => entry.id === AGENT_DEFAULT);
  if (!found) throw new Error("the catalog has no default model");
  return found;
})();
const prompt = normalizeContext({
  systemPrompt: "",
  messages: [{ role: "user", content: "go", timestamp: 1 }],
});

async function sdkTurn(steps: Step[]) {
  const { agentSide, clientSide } = pair();
  const fake = serveAgent(agentSide, { script: () => steps });
  let updates = 0;
  const connection = client({ name: "bare" })
    .onNotification(methods.client.session.update, () => {
      updates += 1;
    })
    .connect(clientSide);
  try {
    await connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const { sessionId } = await connection.agent.request(methods.agent.session.new, {
      cwd: "/work",
      mcpServers: [],
    });
    const blocks: ContentBlock[] = [{ type: "text", text: "go" }];
    await connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: blocks });
    return updates;
  } finally {
    connection.close();
    fake.close();
  }
}

async function extensionTurn(options: FakeAgentOptions): Promise<string> {
  const { client: acp, close } = await connect(options);
  let conversation: Conversation | undefined;
  const open = async () =>
    (conversation ??= new Conversation(await acp.newSession({ cwd: "/work" }), acp.accepts));
  const stream = createStream({
    conversing: () => true,
    open,
    restart: () => Promise.reject(new Error("the benchmark never restarts a session")),
    abandon: () => {},
    noteTool: () => {},
  });
  const reply = stream(model, prompt);
  try {
    for await (const event of reply)
      if (event.type === "error") throw new Error(`the turn failed: ${event.error.errorMessage}`);
  } finally {
    close();
  }
  const message = await reply.result();
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

test(`${CHUNKS} streamed text chunks`, async ({ bench }) => {
  // Both arms must do the whole exchange, or a dropped update would read as a speed-up.
  expect(await sdkTurn(chunks)).toBeGreaterThanOrEqual(CHUNKS);
  expect(await extensionTurn({ script: () => chunks })).toBe(chunks.map((c) => c.say).join(""));
  await bench.compare(
    bench("ACP SDK alone", async () => {
      await sdkTurn(chunks);
    }),
    bench("through the extension to Pi events", async () => {
      await extensionTurn({ script: () => chunks });
    }),
  );
});

test("a tool call with 200 KB of output, received but not mirrored", async ({ bench }) => {
  expect(await sdkTurn(toolTurn)).toBeGreaterThanOrEqual(toolTurn.length);
  expect(await extensionTurn({ script: () => toolTurn })).toBe("done");
  await bench.compare(
    bench("ACP SDK alone", async () => {
      await sdkTurn(toolTurn);
    }),
    bench("through the extension to Pi events", async () => {
      await extensionTurn({ script: () => toolTurn });
    }),
  );
});

// Unpaired: the SDK alone has no session to reopen. This is the client's replay counting.
test("reopening a saved session of 500 turns", async ({ bench }) => {
  const saved = Array.from({ length: 500 }, (_, i): ContentBlock[] => [
    { type: "text", text: `prompt ${i}` },
  ]);
  await bench("loadSession, counting the replay", async () => {
    const { client: acp, close } = await connect({ script: () => [], history: { s: saved } });
    try {
      const session = await acp.loadSession("s", { cwd: "/work" });
      if (session?.turns !== 500) throw new Error(`counted ${session?.turns}`);
    } finally {
      close();
    }
  }).run();
});
