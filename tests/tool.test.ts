import { expect, test } from "vitest";

import { choiceLabels, toolArguments, toolResult } from "../src/tool.ts";
import { view } from "./support/views.ts";

const raw = (rawOutput: unknown) =>
  toolResult(view({ kind: "execute", rawOutput }), "done").content[0]?.text;
const option = (name: string, kind: "allow_once" | "reject_once", optionId: string) => ({
  name,
  kind,
  optionId,
});

test("a mirrored call records what the agent did: output, edits, refusals and failures", () => {
  expect(
    toolArguments(view({ title: "Running client_view_file", paths: ["/w/a.txt"] })),
  ).toStrictEqual({
    kind: "edit",
    title: "Running client_view_file /w/a.txt",
  });
  expect(toolArguments(view({ title: "File a.txt", paths: ["/w/a.txt"] })).title).toBe(
    "File a.txt",
  );
  expect(toolArguments(view({ title: "", kind: "think" })).title).toBe("think");

  const edited = toolResult(
    view({ content: [{ type: "diff", path: "/w/a.txt", oldText: null, newText: "x\n" }] }),
    "done",
  );
  expect([edited.isError, edited.content[0]?.text, edited.details.diffs]).toStrictEqual([
    false,
    "Edited /w/a.txt",
    [{ path: "/w/a.txt", oldText: "", newText: "x\n" }],
  ]);
  expect(raw({ combinedOutput: "hi\r\nthere\r\n", exitCode: 0 })).toBe("hi\nthere\n");
  expect(raw({ output: "plain", exit_code: 0 })).toBe("plain");
  expect(raw("text")).toBe("text");
  expect([raw(null), raw(undefined), raw({ output: null })]).toStrictEqual([
    "File a.txt: completed",
    "File a.txt: completed",
    "File a.txt: completed",
  ]);
  expect(raw({}), "an output-less result is not dumped as JSON").toBe("File a.txt: completed");
  const long = toolResult(view({ rawOutput: "x".repeat(30_000) }), "done");
  expect(long.content[0]?.text.length ?? 0).toBeLessThan(21_000);
  expect(long.content[0]?.text ?? "").toMatch(/\[output truncated\]$/);
  const silent = toolResult(view({}), "done");
  expect([silent.isError, silent.content[0]?.text]).toStrictEqual([false, "File a.txt: completed"]);
  const failed = toolResult(view({ status: "failed" }), "done");
  expect([failed.isError, failed.content[0]?.text]).toStrictEqual([true, "File a.txt: failed"]);
  const waiting = toolResult(view({ status: "pending", settled: false }), "running");
  expect([waiting.isError, waiting.content[0]?.text]).toStrictEqual([false, "File a.txt: pending"]);
});

test("permission choices with the same name stay distinguishable", () => {
  expect(
    choiceLabels([option("Allow", "allow_once", "a"), option("Deny", "reject_once", "d")]),
  ).toStrictEqual(["Allow", "Deny"]);
  const twins = choiceLabels([
    option("Yes", "allow_once", "a"),
    option("Yes", "reject_once", "b"),
    option("Yes", "reject_once", "c"),
  ]);
  expect(twins).toStrictEqual(["Yes [allow once]", "Yes [reject once]", "Yes [reject once] #3"]);
  expect(choiceLabels([])).toStrictEqual([]);
  expect(
    choiceLabels([
      option("A", "allow_once", "1"),
      option("No", "reject_once", "2"),
      option("A", "allow_once", "3"),
      option("No", "reject_once", "4"),
    ]),
  ).toStrictEqual([
    "A [allow once]",
    "No [reject once]",
    "A [allow once] #3",
    "No [reject once] #4",
  ]);
});

test("a generated label never repeats another option's own label", () => {
  const labels = choiceLabels([
    option("X", "allow_once", "a"),
    option("X", "allow_once", "b"),
    option("X [allow once] #2", "reject_once", "c"),
  ]);
  expect(new Set(labels).size).toBe(3);
});

test("a numbered label never repeats one given out before it", () => {
  const labels = choiceLabels([
    option("X [allow once] #3", "reject_once", "a"),
    option("X", "allow_once", "b"),
    option("X", "allow_once", "c"),
  ]);
  expect(new Set(labels).size).toBe(3);
});
