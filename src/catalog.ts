import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";

import type { AcpSession, AgentCommand, Choice } from "./session.ts";

export const PROVIDER = "antigravity";
export const API = "antigravity-acp";
/** Pi model that leaves the agent on whatever model it is configured to use. */
export const AGENT_DEFAULT = "default";

interface CatalogModel {
	id: string;
	name: string;
	efforts: string[];
}

export interface Catalog {
	models: CatalogModel[];
	modes: Choice[];
	commands: readonly AgentCommand[];
	contextWindow: number;
}

const DEFAULT_CONTEXT_WINDOW = 1_048_576;
/** Output tokens Pi may budget for one reply; the agent enforces its own limit. */
const MAX_OUTPUT_TOKENS = 65_536;

export const emptyCatalog: Catalog = {
	models: [],
	modes: [],
	commands: [],
	contextWindow: DEFAULT_CONTEXT_WINDOW,
};

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type LevelMap = NonNullable<Model<Api>["thinkingLevelMap"]>;

const LEVELS = new Set<string>(PI_LEVELS);

/** Splits per-level model ids such as `gemini-x-high` into each model's levels, in listed order. */
function levelsByModel(variants: readonly string[]): ReadonlyMap<string, string[]> {
	const leveled = variants.flatMap((variant) => {
		const cut = variant.lastIndexOf("-");
		const level = variant.slice(cut + 1);
		return cut < 0 || !LEVELS.has(level) ? [] : [{ model: variant.slice(0, cut), level }];
	});
	const grouped = Map.groupBy(leveled, ({ model }) => model);
	return new Map([...grouped].map(([model, items]) => [model, items.map(({ level }) => level)]));
}

export function learn(catalog: Catalog, session: AcpSession): Catalog {
	const current = session.current("model");
	const efforts = session.choices("thought_level").map((c) => c.value);
	const known = new Map(catalog.models.map((m) => [m.id, m.efforts]));
	const listed = levelsByModel(session.variants);
	// The config options give levels for the selected model only. For the others, read them off the
	// per-level model ids when the agent lists those; otherwise keep what the catalog last knew for
	// that model, or assume the selected model's levels for one it has not seen.
	const others = (id: string) => (session.variants.length ? (listed.get(id) ?? []) : (known.get(id) ?? efforts));
	const models = session.choices("model").map((c) => ({
		id: c.value,
		name: c.name,
		efforts: c.value === current ? efforts : others(c.value),
	}));
	const modes = session.choices("mode");
	return {
		models: models.length ? models : catalog.models,
		modes: modes.length ? modes : catalog.modes,
		commands: session.commands ?? catalog.commands,
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
		maxTokens: MAX_OUTPUT_TOKENS,
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

export function effortFor(model: Model<string>, level: ThinkingLevel | undefined): string | undefined {
	return level === undefined ? undefined : (model.thinkingLevelMap?.[level] ?? undefined);
}

const optionalText = z.string().optional().catch(undefined);

const commandSchema = z
	.object({ name: z.string().min(1), description: z.string(), hint: optionalText })
	.transform(({ name, description, hint }): AgentCommand => ({ name, description, hint }));

/** Commands saved by an older version may be missing; a malformed entry is dropped. */
const commandsSchema = z
	.array(z.unknown())
	.catch([])
	.transform((listed) =>
		listed.flatMap((item) => {
			const command = commandSchema.safeParse(item);
			return command.success ? [command.data] : [];
		}),
	);

const catalogSchema = z.object({
	models: z.array(z.object({ id: z.string(), name: z.string(), efforts: z.array(z.string()) })),
	modes: z.array(
		z
			.object({ value: z.string(), name: z.string(), description: optionalText })
			.transform(({ value, name, description }): Choice => ({ value, name, description })),
	),
	commands: commandsSchema,
	contextWindow: z.number().positive().catch(DEFAULT_CONTEXT_WINDOW),
});

/** Reads a saved catalog. A missing or malformed file yields the empty catalog. */
export function readCatalog(file: string): Catalog {
	try {
		const saved = catalogSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
		return saved.success ? saved.data : emptyCatalog;
	} catch {
		return emptyCatalog;
	}
}

export function writeCatalog(file: string, catalog: Catalog) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`);
}
