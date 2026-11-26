import { expect, test } from "vitest";

import { callLine, changedLines, resultLines } from "../src/render.ts";
import { details } from "./support/views.ts";

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

test("mirrored calls render as a tool row with progress, diff and output", () => {
  expect(callLine({ kind: "execute", title: "ls -la" }, plain)).toBe("$ ls -la");
  expect(callLine({ kind: "read", title: "File a.txt" }, plain)).toBe("read File a.txt");
  expect(changedLines("a\nb\nc\n", "a\nB\nB2\nc\n")).toStrictEqual({
    removed: ["b"],
    added: ["B", "B2"],
  });
  expect(changedLines("", "x\n")).toStrictEqual({ removed: [], added: ["x"] });
  expect(changedLines("same\n", "same\n")).toStrictEqual({ removed: [], added: [] });
  expect(changedLines("x\ny\n", "")).toStrictEqual({ removed: ["x", "y"], added: [] });

  const closed = { expanded: false, isPartial: false };
  expect(
    resultLines(details({ status: "pending" }), { ...closed, isPartial: true }, plain),
  ).toStrictEqual(["waiting for approval…"]);
  expect(
    resultLines(details({ status: "in_progress" }), { ...closed, isPartial: true }, plain),
  ).toStrictEqual(["running…"]);
  expect(resultLines(details({ declined: true }), closed, plain)).toStrictEqual(["declined"]);
  expect(resultLines(details({}), closed, plain)).toStrictEqual(["done"]);
  expect(resultLines(details({ status: "failed" }), closed, plain)).toStrictEqual(["failed"]);
  expect(resultLines(details({ status: "in_progress" }), closed, plain)).toStrictEqual(["stopped"]);
  const diff = details({ diffs: [{ path: "a.txt", oldText: "a\nb\n", newText: "a\nc\n" }] });
  expect(resultLines(diff, closed, plain)).toStrictEqual(["a.txt +1 -1"]);
  expect(resultLines(diff, { ...closed, expanded: true }, plain)).toStrictEqual([
    "a.txt +1 -1",
    "- b",
    "+ c",
  ]);
  const output = details({ output: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") });
  const collapsed = resultLines(output, closed, plain);
  expect(collapsed.length).toBe(9);
  expect(collapsed.at(-1)).toBe("… 4 more lines");
  expect(resultLines(output, { ...closed, expanded: true }, plain).length).toBe(12);
});

test("a tool kind that names an object property is shown as it is", () => {
  expect(callLine({ kind: "constructor", title: "x" }, plain)).toBe("constructor x");
  expect(callLine({ kind: "toString", title: "x" }, plain)).toBe("toString x");
});
