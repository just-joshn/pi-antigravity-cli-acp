/**
 * The extension's own cost, with the model and network replaced by a scripted agent in the same
 * process. Each case is paired with the bare ACP SDK doing the same exchange, so the difference
 * is what the extension adds.
 */
import {
  type AnyMessage,
  client,
  type ContentBlock,
  methods,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk/unstable";
import { normalizeContext } from "@earendil-works/pi-ai";
import { test } from "vitest";

import { emptyCatalog, piModels } from "../src/catalog.ts";
import { Conversation } from "../src/conversation.ts";
import { createStream } from "../src/stream.ts";
import { type FakeAgentOptions, serveAgent, type Step } from "../tests/support/fake-agent.ts";
import { connect } from "../tests/support/harness.ts";

const CHUNKS = 1000;
const chunks: Step[] = Array.from({ length: CHUNKS }, (_, i) => ({ say: `word${i} ` }));
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
const model = piModels({ ...emptyCatalog, models: [{ id: "g", name: "G", efforts: [] }] }).find(
  (entry) => entry.id === "g",
);
const prompt = normalizeContext({
  systemPrompt: "",
  messages: [{ role: "user", content: "go", timestamp: 1 }],
});

/** The bare SDK: one prompt whose updates are only counted. */
async function sdkTurn(steps: Step[]) {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>();
  const toClient = new TransformStream<AnyMessage, AnyMessage>();
  const fake = serveAgent(
    { readable: toAgent.readable, writable: toClient.writable },
    { script: () => steps },
  );
  let updates = 0;
  const connection = client({ name: "bare" })
    .onNotification(methods.client.session.update, () => {
      updates += 1;
    })
    .connect({ readable: toClient.readable, writable: toAgent.writable });
  await connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
  const { sessionId } = await connection.agent.request(methods.agent.session.new, {
    cwd: "/work",
    mcpServers: [],
  });
  const blocks: ContentBlock[] = [{ type: "text", text: "go" }];
  await connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: blocks });
  connection.close();
  fake.close();
  return updates;
}

/** The extension: the same prompt through Pi's provider stream, every event consumed. */
async function extensionTurn(options: FakeAgentOptions) {
  const { client: acp, close } = await connect(options);
  let conversation: Conversation | undefined;
  const open = async () =>
    (conversation ??= new Conversation(await acp.newSession("/work"), acp.accepts));
  const stream = createStream({
    conversing: () => true,
    open,
    restart: open,
    abandon: () => {},
    noteTool: () => {},
  });
  if (!model) throw new Error("no model");
  const reply = stream(model, prompt);
  for await (const event of reply) if (event.type === "error") throw new Error("the turn failed");
  close();
}

test(`${CHUNKS} streamed text chunks`, async ({ bench }) => {
  await bench.compare(
    bench("ACP SDK alone", async () => {
      await sdkTurn(chunks);
    }),
    bench("through the extension to Pi events", async () => {
      await extensionTurn({ script: () => chunks });
    }),
  );
});

test("a tool call with 200 KB of output", async ({ bench }) => {
  await bench.compare(
    bench("ACP SDK alone", async () => {
      await sdkTurn(toolTurn);
    }),
    bench("through the extension to Pi events", async () => {
      await extensionTurn({ script: () => toolTurn });
    }),
  );
});

test("reopening a saved session of 500 turns", async ({ bench }) => {
  const saved = Array.from({ length: 500 }, (_, i): ContentBlock[] => [
    { type: "text", text: `prompt ${i}` },
  ]);
  await bench("loadSession, counting the replay", async () => {
    const { client: acp, close } = await connect({ script: () => [], history: { s: saved } });
    const session = await acp.loadSession("s", "/work");
    if (session?.turns !== 500) throw new Error(`counted ${session?.turns}`);
    close();
  }).run();
});
