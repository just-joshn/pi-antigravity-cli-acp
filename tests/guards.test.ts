import { expect, test } from "vitest";

import { isRecord } from "../src/guards.ts";

test("objects that are not arrays count as records; nothing else does", () => {
  expect(isRecord({})).toBe(true);
  expect(isRecord(new Date(0)), "any object, not only plain ones").toBe(true);
  expect(isRecord({ a: 1 })).toBe(true);
  for (const value of [null, undefined, [], [1], "", "text", 0, 1, true, () => {}])
    expect(isRecord(value), String(value)).toBe(false);
});
