import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";

import { isRecord } from "./guards.ts";
import type { AcpSession, Choice } from "./session.ts";

export const PROVIDER = "antigravity";
export const API = "antigravity-acp";
/** Pi model that leaves the agent on whatever model it is configured to use. */
export const AGENT_DEFAULT = "default";

export interface CatalogModel {
  id: string;
  name: string;
  /** Thinking levels the agent offers for this model, in the agent's own words. */
  efforts: string[];
}

/** What an agent offers, as last reported by one of its sessions. */
export interface Catalog {
  models: CatalogModel[];
  modes: Choice[];
  contextWindow: number;
}

export const emptyCatalog: Catalog = { models: [], modes: [], contextWindow: 1_048_576 };

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type LevelMap = NonNullable<Model<Api>["thinkingLevelMap"]>;

const LEVELS = new Set<string>(PI_LEVELS);

/** Splits per-level model ids such as `gemini-x-high` into each model's levels, in listed order. */
function levelsByModel(variants: readonly string[]): Map<string, string[]> {
  const levels = new Map<string, string[]>();
  for (const variant of variants) {
    const cut = variant.lastIndexOf("-");
    const level = variant.slice(cut + 1);
    if (cut < 0 || !LEVELS.has(level)) continue;
    const model = variant.slice(0, cut);
    const found = levels.get(model);
    if (found) found.push(level);
    else levels.set(model, [level]);
  }
  return levels;
}

/** Folds what a live session reports into the catalog. */
export function learn(catalog: Catalog, session: AcpSession): Catalog {
  const current = session.current("model");
  const efforts = session.choices("thought_level").map((c) => c.value);
  const known = new Map(catalog.models.map((m) => [m.id, m.efforts]));
  const listed = levelsByModel(session.variants);
  // The config options give levels for the selected model only. For the others, read them off the
  // per-level model ids when the agent lists those; otherwise assume the selected model's levels.
  const others = (id: string) =>
    session.variants.length ? (listed.get(id) ?? []) : (known.get(id) ?? efforts);
  const models = session.choices("model").map((c) => ({
    id: c.value,
    name: c.name,
    efforts: c.value === current ? efforts : others(c.value),
  }));
  const modes = session.choices("mode");
  return {
    models: models.length ? models : catalog.models,
    modes: modes.length ? modes : catalog.modes,
    contextWindow: session.usage?.size || catalog.contextWindow,
  };
}

/** Pi model entries for the catalog. Pi thinking levels the agent lacks are marked unsupported. */
export function piModels(catalog: Catalog): Model<typeof API>[] {
  const base = {
    provider: PROVIDER,
    api: API,
    baseUrl: "acp:antigravity",
    input: ["text" as const, "image" as const],
    contextWindow: catalog.contextWindow,
    maxTokens: 65_536,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } satisfies Partial<Model<typeof API>>;
  return [
    { ...base, id: AGENT_DEFAULT, name: "Antigravity (agent's current model)", reasoning: false },
    ...catalog.models.map((model) => {
      const levels: LevelMap = Object.fromEntries(
        PI_LEVELS.map((level) => [level, model.efforts.includes(level) ? level : null]),
      );
      return model.efforts.length
        ? { ...base, id: model.id, name: model.name, reasoning: true, thinkingLevelMap: levels }
        : { ...base, id: model.id, name: model.name, reasoning: false };
    }),
  ];
}

/** The agent's name for a Pi thinking level, when the model supports that level. */
export function effortFor(model: Model<string>, level: string | undefined): string | undefined {
  const levels: Record<string, string | null | undefined> = model.thinkingLevelMap ?? {};
  return (level === undefined ? undefined : levels[level]) ?? undefined;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseCatalog(value: unknown): Catalog | undefined {
  if (!isRecord(value) || !Array.isArray(value["models"]) || !Array.isArray(value["modes"]))
    return undefined;
  const models: CatalogModel[] = [];
  for (const model of value["models"]) {
    if (!isRecord(model) || typeof model["id"] !== "string" || typeof model["name"] !== "string")
      return undefined;
    if (!strings(model["efforts"])) return undefined;
    models.push({ id: model["id"], name: model["name"], efforts: model["efforts"] });
  }
  const modes: Choice[] = [];
  for (const mode of value["modes"]) {
    if (!isRecord(mode) || typeof mode["value"] !== "string" || typeof mode["name"] !== "string")
      return undefined;
    const description = typeof mode["description"] === "string" ? mode["description"] : undefined;
    modes.push({ value: mode["value"], name: mode["name"], description });
  }
  const size = value["contextWindow"];
  return {
    models,
    modes,
    contextWindow: typeof size === "number" && size > 0 ? size : emptyCatalog.contextWindow,
  };
}

/** Reads a saved catalog. A missing or malformed file yields the empty catalog. */
export function readCatalog(file: string): Catalog {
  try {
    return parseCatalog(JSON.parse(readFileSync(file, "utf8"))) ?? emptyCatalog;
  } catch {
    return emptyCatalog;
  }
}

export function writeCatalog(file: string, catalog: Catalog) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`);
}
