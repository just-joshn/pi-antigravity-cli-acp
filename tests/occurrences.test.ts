import { expect, test } from "vitest";

import { occurrences } from "../src/occurrences.ts";

const same = (value: string) => value;

test("each item, in the list's order, with how many items share its key", () => {
  expect(occurrences(["a", "b", "a"], same)).toStrictEqual([
    { item: "a", of: 2 },
    { item: "b", of: 1 },
    { item: "a", of: 2 },
  ]);
  const people = [
    { name: "Ann", team: "x" },
    { name: "Bo", team: "x" },
  ];
  expect(occurrences(people, ({ team }) => team).map(({ of }) => of)).toStrictEqual([2, 2]);
});

test("an empty list, one item and empty keys are counted like any other", () => {
  expect(occurrences([], same)).toStrictEqual([]);
  expect(occurrences(["x"], same)).toStrictEqual([{ item: "x", of: 1 }]);
  expect(occurrences(["", ""], same)).toStrictEqual([
    { item: "", of: 2 },
    { item: "", of: 2 },
  ]);
});
