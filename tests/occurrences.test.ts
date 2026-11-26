import { expect, test } from "vitest";

import { occurrences } from "../src/occurrences.ts";

const same = (value: string) => value;

test("each item is placed among the items that share its key, in the list's order", () => {
  expect(occurrences(["a", "b", "a", "a"], same)).toStrictEqual([
    { item: "a", nth: 1, of: 3 },
    { item: "b", nth: 1, of: 1 },
    { item: "a", nth: 2, of: 3 },
    { item: "a", nth: 3, of: 3 },
  ]);
  const people = [
    { name: "Ann", team: "x" },
    { name: "Bo", team: "x" },
  ];
  expect(occurrences(people, ({ team }) => team).map(({ nth, of }) => [nth, of])).toStrictEqual([
    [1, 2],
    [2, 2],
  ]);
});

test("an empty list, one item and empty keys are placed like any other", () => {
  expect(occurrences([], same)).toStrictEqual([]);
  expect(occurrences(["x"], same)).toStrictEqual([{ item: "x", nth: 1, of: 1 }]);
  expect(occurrences(["", ""], same)).toStrictEqual([
    { item: "", nth: 1, of: 2 },
    { item: "", nth: 2, of: 2 },
  ]);
});
