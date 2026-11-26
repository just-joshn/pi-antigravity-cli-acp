import { expect, test } from "vitest";

import { isRecord, isStringArray } from "../src/guards.ts";

test("only plain objects count as records", () => {
  expect(isRecord({})).toBe(true);
  expect(isRecord({ a: 1 })).toBe(true);
  for (const value of [null, undefined, [], [1], "", "text", 0, 1, true, () => {}])
    expect(isRecord(value), String(value)).toBe(false);
});

test("only arrays of nothing but strings count as string arrays", () => {
  expect(isStringArray([])).toBe(true);
  expect(isStringArray(["", "a"])).toBe(true);
  for (const value of [null, undefined, "a", {}, { 0: "a", length: 1 }, [1], ["a", null], [["a"]]])
    expect(isStringArray(value), JSON.stringify(value)).toBe(false);
});
