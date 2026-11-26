import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, onTestFinished, test } from "vitest";

import {
  effortFor,
  emptyCatalog,
  learn,
  piModels,
  readCatalog,
  writeCatalog,
} from "../src/catalog.ts";
import { connect } from "./support/harness.ts";
import { scratchDir } from "./support/scratch.ts";

test("the catalog learns every model's thinking levels from one session", async () => {
  const listed = await connect({ script: () => [] });
  onTestFinished(listed.close);
  const first = learn(emptyCatalog, await listed.client.newSession({ cwd: "/work" }));
  expect(first.models).toStrictEqual([
    { id: "gemini-a", name: "Gemini A", efforts: ["low", "medium", "high"] },
    { id: "gemini-b", name: "Gemini B", efforts: ["low", "high", "xhigh"] },
  ]);
  expect(first.modes.map((mode) => mode.value)).toStrictEqual(["default", "auto"]);
  expect(first.contextWindow).toBe(1_000_000);

  const unlisted = await connect({ script: () => [], variants: false });
  onTestFinished(unlisted.close);
  const session = await unlisted.client.newSession({ cwd: "/work" });
  const guessed = learn(emptyCatalog, session);
  expect(guessed.models[1]?.efforts, "assumed until selected").toStrictEqual([
    "low",
    "medium",
    "high",
  ]);
  await session.select("model", "gemini-b");
  expect(learn(guessed, session).models).toStrictEqual([
    { id: "gemini-a", name: "Gemini A", efforts: ["low", "medium", "high"] },
    { id: "gemini-b", name: "Gemini B", efforts: ["low", "high", "xhigh"] },
  ]);
});

test("thinking levels are read off model ids that share a prefix with another model", async () => {
  const agent = await connect({
    script: () => [],
    models: [
      { id: "g", name: "G", efforts: ["low", "high"] },
      { id: "g-pro", name: "G Pro", efforts: ["low"] },
      { id: "g-lite", name: "G Lite", efforts: [] },
    ],
  });
  onTestFinished(agent.close);
  const session = await agent.client.newSession({ cwd: "/work" });
  expect(session.variants).toStrictEqual(["g-low", "g-high", "g-pro-low", "g-lite"]);
  expect(learn(emptyCatalog, session).models.map((m) => [m.id, m.efforts])).toStrictEqual([
    ["g", ["low", "high"]],
    ["g-pro", ["low"]],
    ["g-lite", []],
  ]);
});

test("Pi models mark thinking levels the agent lacks as unsupported", () => {
  const models = piModels({
    models: [
      { id: "g", name: "G", efforts: ["low", "high"] },
      { id: "fixed", name: "Fixed", efforts: [] },
    ],
    modes: [],
    commands: [],
    contextWindow: 2000,
  });
  expect(models.map((model) => [model.id, model.reasoning, model.contextWindow])).toStrictEqual([
    ["default", false, 2000],
    ["g", true, 2000],
    ["fixed", false, 2000],
  ]);
  const [, adjustable, fixed] = models;
  expect.assert(adjustable && fixed);
  expect(adjustable.thinkingLevelMap).toStrictEqual({
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  });
  expect(effortFor(adjustable, "high")).toBe("high");
  expect(effortFor(adjustable, "medium")).toBe(undefined);
  expect(effortFor(adjustable, undefined)).toBe(undefined);
  expect(effortFor(fixed, "high")).toBe(undefined);
});

test("a saved catalog round-trips; a missing or malformed one is ignored", async () => {
  const dir = await scratchDir("catalog");
  const file = join(dir, "nested", "catalog.json");
  expect(readCatalog(file)).toStrictEqual(emptyCatalog);
  const catalog = {
    models: [{ id: "g", name: "G", efforts: ["low"] }],
    modes: [{ value: "default", name: "Default", description: "Ask first" }],
    commands: [
      { name: "goal", description: "Run to the end", hint: "the goal" },
      { name: "compact", description: "Compact now", hint: undefined },
    ],
    contextWindow: 123,
  };
  writeCatalog(file, catalog);
  expect(readCatalog(file)).toStrictEqual(catalog);
  const bad = [
    "{",
    "",
    "null",
    '"text"',
    "[]",
    '{"models":[{"id":1,"name":"x","efforts":[]}],"modes":[]}',
    '{"models":[{"id":"x","name":"x","efforts":[1]}],"modes":[]}',
    '{"models":[],"modes":[{"value":1}]}',
    '{"models":[]}',
  ];
  for (const text of bad) {
    // oxlint-disable-next-line no-await-in-loop -- each case overwrites the same file
    await writeFile(file, text);
    expect(readCatalog(file), text).toStrictEqual(emptyCatalog);
  }
  await writeFile(file, '{"models":[],"modes":[{"value":"m","name":"M"}],"contextWindow":-5}');
  expect(readCatalog(file)).toStrictEqual({
    models: [],
    modes: [{ value: "m", name: "M", description: undefined }],
    commands: [],
    contextWindow: emptyCatalog.contextWindow,
  });
});

test("saved agent commands that are missing or malformed are dropped, not the catalog", async () => {
  const file = join(await scratchDir("catalog"), "catalog.json");
  const commands = async (value: unknown) => {
    await writeFile(file, JSON.stringify({ models: [], modes: [], commands: value }));
    return readCatalog(file).commands;
  };
  expect(await commands(undefined)).toStrictEqual([]);
  expect(await commands("goal")).toStrictEqual([]);
  expect(await commands([null])).toStrictEqual([]);
  expect(await commands([{ name: "goal" }])).toStrictEqual([]);
  expect(await commands([{ name: "goal", description: "d", hint: 3 }])).toStrictEqual([
    { name: "goal", description: "d", hint: undefined },
  ]);
  expect(
    await commands([null, { name: "", description: "d" }, { name: "ok", description: "d" }]),
    "a bad entry drops only itself",
  ).toStrictEqual([{ name: "ok", description: "d", hint: undefined }]);
});

test("a saved catalog with no models or modes is valid, and its context window must be positive", async () => {
  const file = join(await scratchDir("catalog"), "catalog.json");
  const window = async (contextWindow: unknown) => {
    await writeFile(file, JSON.stringify({ models: [], modes: [], contextWindow }));
    return readCatalog(file).contextWindow;
  };
  expect(await window(undefined)).toBe(emptyCatalog.contextWindow);
  expect(await window(null)).toBe(emptyCatalog.contextWindow);
  expect(await window("2000")).toBe(emptyCatalog.contextWindow);
  expect(await window(0)).toBe(emptyCatalog.contextWindow);
  expect(await window(1)).toBe(1);
  expect(readCatalog(file)).toStrictEqual({
    models: [],
    modes: [],
    commands: [],
    contextWindow: 1,
  });
});

test("a session that has not listed its commands keeps the saved ones; an empty list replaces them", async () => {
  const saved = { ...emptyCatalog, commands: [{ name: "old", description: "d", hint: undefined }] };
  const { client, close } = await connect({ script: () => [], plain: true });
  onTestFinished(close);
  const quiet = await client.newSession({ cwd: "/work" });
  expect(learn(saved, quiet).commands).toStrictEqual(saved.commands);
  quiet.receive({ sessionUpdate: "available_commands_update", availableCommands: [] });
  expect(learn(saved, quiet).commands).toStrictEqual([]);
});
