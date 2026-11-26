import { expect, test } from "vitest";

import { uniqueLabels } from "../src/labels.ts";

const hash = (label: string, n: number) => `${label} #${n}`;

test("labels that repeat are numbered by position, skipping numbers already taken", () => {
  expect(uniqueLabels(["a", "b", "a"], hash)).toStrictEqual(["a", "b", "a #3"]);
  expect(uniqueLabels(["x #2", "x", "x"], hash)).toStrictEqual(["x #2", "x", "x #3"]);
  expect(uniqueLabels(["x #3", "x", "x"], hash)).toStrictEqual(["x #3", "x", "x #4"]);
});

test("no labels, one label and empty labels are given out like any other", () => {
  expect(uniqueLabels([], hash)).toStrictEqual([]);
  expect(uniqueLabels(["only"], hash)).toStrictEqual(["only"]);
  expect(uniqueLabels(["", ""], hash)).toStrictEqual(["", " #2"]);
});
