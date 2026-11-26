import type { CreateElicitationRequest } from "@agentclientprotocol/sdk/unstable";
import { expect, onTestFinished, test } from "vitest";

import { answerElicitation, type Dialogs } from "../src/elicit.ts";
import { connect } from "./support/harness.ts";
import { fakeUi, said, start } from "./support/pi.ts";
import { answering, recorder } from "./support/record.ts";

/** Dialogs that answer from a list and record what they showed. */
function scripted(answers: readonly (string | undefined)[]) {
  const shown = recorder<string>();
  const answer = answering(answers);
  const next = (title: string) => {
    shown.record(title);
    return Promise.resolve(answer());
  };
  const dialogs: Dialogs = { select: next, input: next };
  return { dialogs, shown: shown.all };
}

const form = (properties: Record<string, unknown>, required: string[] = []) =>
  ({
    sessionId: "s",
    mode: "form",
    message: "A few details, please",
    requestedSchema: { type: "object", properties, required },
  }) as CreateElicitationRequest;

const signal = new AbortController().signal;

test("a form is answered field by field with Pi's dialogs", async () => {
  const request = form(
    {
      color: {
        type: "string",
        oneOf: [
          { const: "r", title: "Red" },
          { const: "b", title: "Blue" },
        ],
      },
      size: { type: "string", enum: ["s", "m"] },
      count: { type: "integer", title: "How many", minimum: 1, maximum: 9 },
      ratio: { type: "number" },
      agree: { type: "boolean", description: "Proceed?" },
      tags: { type: "array", items: { type: "string", enum: ["x", "y", "z"] } },
      note: { type: "string", maxLength: 5 },
      skipped: { type: "string" },
    },
    ["count"],
  );
  const { dialogs, shown } = scripted([
    "Answer",
    "Blue",
    "m",
    "0",
    "abc",
    "3",
    "0.5",
    "Yes",
    "x, z",
    "too long",
    "ok",
    "",
  ]);
  expect(await answerElicitation(request, dialogs, signal)).toStrictEqual({
    action: "accept",
    content: {
      color: "b",
      size: "m",
      count: 3,
      ratio: 0.5,
      agree: true,
      tags: ["x", "z"],
      note: "ok",
    },
  });
  expect(shown()).toContain("How many (from 1 to 9; try again: at least 1)");
  expect(shown()).toContain("agree: Proceed?");
});

test("declining, dismissing, or a field Pi cannot ask about ends the form", async () => {
  const request = form({ name: { type: "string" } });
  expect(await answerElicitation(request, scripted(["Decline"]).dialogs, signal)).toStrictEqual({
    action: "decline",
  });
  expect(await answerElicitation(request, scripted([undefined]).dialogs, signal)).toStrictEqual({
    action: "cancel",
  });
  expect(
    await answerElicitation(request, scripted(["Answer", undefined]).dialogs, signal),
  ).toStrictEqual({ action: "cancel" });
  const odd = form({ shape: { type: "object" } });
  expect(await answerElicitation(odd, scripted(["Answer"]).dialogs, signal)).toStrictEqual({
    action: "decline",
  });
  const required = form({ name: { type: "string" } }, ["name"]);
  expect(
    await answerElicitation(required, scripted(["Answer", "", "", ""]).dialogs, signal),
    "three empty answers to a required field give up",
  ).toStrictEqual({ action: "cancel" });
});

test("a link to visit is shown with its URL; continuing accepts", async () => {
  const request = {
    sessionId: "s",
    mode: "url",
    message: "Approve in your browser",
    elicitationId: "e1",
    url: "https://example.com/approve",
  } as CreateElicitationRequest;
  const accepted = scripted(["Continue"]);
  expect(await answerElicitation(request, accepted.dialogs, signal)).toStrictEqual({
    action: "accept",
  });
  expect(accepted.shown()).toStrictEqual(["Approve in your browser\nhttps://example.com/approve"]);
  expect(await answerElicitation(request, scripted(["Decline"]).dialogs, signal)).toStrictEqual({
    action: "decline",
  });
});

test("an aborted question is cancelled without asking", async () => {
  const stop = new AbortController();
  stop.abort();
  const { dialogs, shown } = scripted(["Answer"]);
  expect(await answerElicitation(form({}), dialogs, stop.signal)).toStrictEqual({
    action: "cancel",
  });
  expect(shown()).toStrictEqual([]);
});

test("the agent's question in a turn becomes Pi dialogs, and the answer goes back to it", async () => {
  const { ui, dialogs } = fakeUi(["Answer", "red"]);
  const { session, stop, assistants } = await start({ ui });
  await session.prompt("a question for you");
  expect(dialogs().map((d) => d.title)).toStrictEqual(["Which color?", "color"]);
  expect(said(assistants().at(-1))).toBe('{"action":"accept","content":{"color":"red"}}');
  expect((await stop()).answers).toStrictEqual([{ action: "accept", content: { color: "red" } }]);
});

test("without a UI the question is cancelled; one for an unknown session too", async () => {
  const headless = await start();
  await headless.session.prompt("a question for you");
  expect((await headless.stop()).answers).toStrictEqual([{ action: "cancel" }]);

  const asked = recorder<string>();
  const { client, close } = await connect(
    {
      script: () => [
        {
          elicit: {
            requestId: 7,
            mode: "form",
            message: "Outside",
            requestedSchema: { type: "object" },
          },
        },
        {
          elicit: {
            sessionId: "elsewhere",
            mode: "form",
            message: "About another session",
            requestedSchema: { type: "object" },
          },
        },
      ],
    },
    {
      elicit: (request) => {
        asked.record(request.message);
        return Promise.resolve({ action: "decline" });
      },
    },
  );
  onTestFinished(close);
  const turn = (await client.newSession({ cwd: "/work" })).startTurn([{ type: "text", text: "x" }]);
  const replies: string[] = [];
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- reads the turn in order
    const event = await turn.next();
    if (event.type === "text") replies.push(event.text);
    if (event.type === "end" || event.type === "failed") break;
  }
  expect(asked.all(), "a question outside any session is asked as well").toStrictEqual(["Outside"]);
  expect(replies).toStrictEqual(['{"action":"decline"}', '{"action":"cancel"}']);
});

test("only url mode is a link, and a field named __proto__ is kept as an answer", async () => {
  const odd = {
    requestId: 1,
    mode: "custom",
    message: "?",
    url: "https://x.example",
  } as CreateElicitationRequest;
  expect(await answerElicitation(odd, scripted(["Continue"]).dialogs, signal)).toStrictEqual({
    action: "decline",
  });
  const proto = form({ ["__proto__"]: { type: "string" } });
  const reply = await answerElicitation(proto, scripted(["Answer", "x"]).dialogs, signal);
  expect(reply.action).toBe("accept");
  expect(Object.entries(("content" in reply && reply.content) || {})).toStrictEqual([
    ["__proto__", "x"],
  ]);
});

test("a form with more fields than Pi asks is declined, not sent back half answered", async () => {
  const fields = Object.fromEntries(
    Array.from({ length: 21 }, (_, i) => [`f${i}`, { type: "string" }]),
  );
  const { dialogs, shown } = scripted([]);
  expect(await answerElicitation(form(fields), dialogs, signal)).toStrictEqual({
    action: "decline",
  });
  expect(shown()).toStrictEqual([]);
});
