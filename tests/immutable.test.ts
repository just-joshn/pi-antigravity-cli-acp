import { expect, test } from "vitest";

import { put, Registry, without } from "../src/immutable.ts";

test("put and without return new maps and leave the one given as it was", () => {
  const start: ReadonlyMap<string, number> = new Map([["a", 1]]);
  const added = put(start, "b", 2);
  const replaced = put(added, "a", 3);
  expect([...start]).toStrictEqual([["a", 1]]);
  expect([...added]).toStrictEqual([
    ["a", 1],
    ["b", 2],
  ]);
  expect(replaced.get("a")).toBe(3);
  expect([...without(replaced, "a")]).toStrictEqual([["b", 2]]);
  expect([...replaced]).toHaveLength(2);
});

test("put and without on an empty map, an absent key and an empty key", () => {
  const empty: ReadonlyMap<string, number> = new Map();
  expect(without(empty, "x"), "nothing to remove: the same map").toBe(empty);
  expect([...put(empty, "", 0)]).toStrictEqual([["", 0]]);
  expect([...without(put(empty, "", 0), "")]).toStrictEqual([]);
});

test("a registry finds what was put under an id until it is removed", () => {
  const registry = new Registry<string>();
  expect(registry.get("missing")).toBeUndefined();
  registry.put("a", "first");
  registry.put("a", "second");
  expect(registry.get("a")).toBe("second");
  registry.remove("a");
  registry.remove("never there");
  expect(registry.get("a")).toBeUndefined();
});
