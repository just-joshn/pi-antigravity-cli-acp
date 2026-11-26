import { expect, test } from "vitest";

import { isRecord } from "../src/guards.ts";

test("only plain objects count as records", () => {
  expect(isRecord({})).toBe(true);
  expect(isRecord({ a: 1 })).toBe(true);
  for (const value of [null, undefined, [], [1], "", "text", 0, 1, true, () => {}])
    expect(isRecord(value), String(value)).toBe(false);
});
