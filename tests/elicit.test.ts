import type { CreateElicitationRequest } from "@agentclientprotocol/sdk/unstable";
import { expect, onTestFinished, test } from "vitest";

import { answerElicitation, type Dialogs } from "../src/elicit.ts";
import { collect, connect } from "./support/harness.ts";
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
  const replies = (await collect(turn)).flatMap((event) =>
    event.type === "text" ? [event.text] : [],
  );
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

test("typed answers are checked against the form's type and bounds before they are sent", async () => {
  const integer = scripted(["Answer", "abc", "1.5", "9"]);
  const n = { type: "integer", title: "N", minimum: 1, maximum: 9 };
  expect(await answerElicitation(form({ n }, ["n"]), integer.dialogs, signal)).toStrictEqual({
    action: "accept",
    content: { n: 9 },
  });
  expect(integer.shown().slice(1)).toStrictEqual([
    "N (from 1 to 9)",
    "N (from 1 to 9; try again: a whole number)",
    "N (from 1 to 9; try again: a whole number)",
  ]);

  const number = scripted(["Answer", "Infinity", "-0.5"]);
  const x = { type: "number", title: "X", minimum: -0.5 };
  expect(await answerElicitation(form({ x }), number.dialogs, signal)).toStrictEqual({
    action: "accept",
    content: { x: -0.5 },
  });
  expect(number.shown().at(-1)).toBe("X (try again: a number)");

  const text = scripted(["Answer", "a", "abcd", "abc"]);
  const s = { type: "string", title: "S", minLength: 2, maxLength: 3 };
  expect(await answerElicitation(form({ s }, ["s"]), text.dialogs, signal)).toStrictEqual({
    action: "accept",
    content: { s: "abc" },
  });
  expect(text.shown().slice(2)).toStrictEqual([
    "S (try again: at least 2 characters)",
    "S (try again: at most 3 characters)",
  ]);
});

test("a multiple choice answer must pick as many options as the form allows", async () => {
  const colors = {
    type: "array",
    title: "Colors",
    minItems: 2,
    maxItems: 2,
    items: { enum: ["red", "blue", "green"] },
  };
  const { dialogs, shown } = scripted(["Answer", "red", "red, blue, green", "red, blue"]);
  expect(await answerElicitation(form({ colors }, ["colors"]), dialogs, signal)).toStrictEqual({
    action: "accept",
    content: { colors: ["red", "blue"] },
  });
  expect(shown().slice(2)).toStrictEqual([
    "Colors (comma-separated: red, blue, green; try again: at least 2)",
    "Colors (comma-separated: red, blue, green; try again: at most 2)",
  ]);
});

test("choices with the same title stay distinguishable and return their own value", async () => {
  const pickSecond = scripted(["Answer", "Same (2)"]);
  const same = {
    type: "string",
    title: "Pick",
    oneOf: [
      { const: "a", title: "Same" },
      { const: "b", title: "Same" },
    ],
  };
  expect(
    await answerElicitation(form({ same }, ["same"]), pickSecond.dialogs, signal),
  ).toStrictEqual({
    action: "accept",
    content: { same: "b" },
  });
});

test("an optional choice can be left unanswered without dropping the form", async () => {
  const optional = scripted(["Answer", "No answer", "No answer"]);
  const fields = {
    flag: { type: "boolean", title: "Flag" },
    color: { type: "string", title: "Color", enum: ["red"] },
  };
  expect(await answerElicitation(form(fields), optional.dialogs, signal)).toStrictEqual({
    action: "accept",
    content: {},
  });
});

test("a multiple choice answer that must be unique cannot repeat a choice", async () => {
  const colors = { type: "array", title: "Colors", uniqueItems: true, items: { enum: ["a", "b"] } };
  const { dialogs, shown } = scripted(["Answer", "a, a", "a, b"]);
  expect(await answerElicitation(form({ colors }, ["colors"]), dialogs, signal)).toStrictEqual({
    action: "accept",
    content: { colors: ["a", "b"] },
  });
  expect(shown().at(-1)).toBe("Colors (comma-separated: a, b; try again: each choice once)");
});

test("a multiple choice option with a comma in it can be picked", async () => {
  const pairs = { type: "array", title: "Pairs", items: { enum: ["red, blue", "green"] } };
  const { dialogs } = scripted(["Answer", "red, blue, green"]);
  expect(await answerElicitation(form({ pairs }, ["pairs"]), dialogs, signal)).toStrictEqual({
    action: "accept",
    content: { pairs: ["red, blue", "green"] },
  });
});

test("a typed name matching one choice's label and another's value picks the labelled choice", async () => {
  const items = {
    oneOf: [
      { const: "b", title: "A" },
      { const: "c", title: "b" },
    ],
  };
  const letters = { type: "array", title: "Letters", items };
  const { dialogs } = scripted(["Answer", "b"]);
  expect(await answerElicitation(form({ letters }, ["letters"]), dialogs, signal)).toStrictEqual({
    action: "accept",
    content: { letters: ["c"] },
  });
});
