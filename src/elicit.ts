import type {
	CreateElicitationRequest,
	CreateElicitationResponse,
	ElicitationContentValue,
} from "@agentclientprotocol/sdk/unstable";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import { isRecord } from "./guards.ts";
import { uniqueLabels } from "./labels.ts";

export type Dialogs = Pick<ExtensionUIContext, "select" | "input">;

const FIELD_LIMIT = 20;
const TRIES = 3;
const once = (chosen: readonly string[]) => new Set(chosen).size === chosen.length;

const NO_ANSWER = "No answer";
const CANCEL: CreateElicitationResponse = { action: "cancel" };
const DECLINE: CreateElicitationResponse = { action: "decline" };

type Answer = { value: ElicitationContentValue } | "skip" | "cancel" | "unsupported";

interface Field {
	title: string;
	schema: Record<string, unknown>;
	required: boolean;
}

/** Answers the agent's structured question with Pi's dialogs. Esc anywhere cancels. */
export async function answerElicitation(
	request: CreateElicitationRequest,
	dialogs: Dialogs,
	signal: AbortSignal,
): Promise<CreateElicitationResponse> {
	if (signal.aborted) return CANCEL;
	const options = { signal };
	if (request.mode === "url" && "url" in request && typeof request.url === "string") {
		const picked = await dialogs.select(`${request.message}\n${request.url}`, ["Continue", "Decline"], options);
		if (picked === undefined) return CANCEL;
		return picked === "Continue" ? { action: "accept" } : DECLINE;
	}
	const schema = "requestedSchema" in request ? request.requestedSchema : undefined;
	if (!isRecord(schema)) return DECLINE;
	const { properties: rawProperties } = schema;
	const properties = isRecord(rawProperties) ? rawProperties : {};
	// A form with more fields than Pi asks about cannot be answered in full.
	if (Object.keys(properties).length > FIELD_LIMIT) return DECLINE;
	const picked = await dialogs.select(request.message, ["Answer", "Decline"], options);
	if (picked === undefined) return CANCEL;
	if (picked === "Decline") return DECLINE;
	const { required } = schema;
	return fillForm(properties, required, dialogs, signal);
}

async function fillForm(
	properties: Record<string, unknown>,
	listed: unknown,
	dialogs: Dialogs,
	signal: AbortSignal,
): Promise<CreateElicitationResponse> {
	const required = Array.isArray(listed) ? listed : [];
	const fields = Object.entries(properties).map(([key, property]) =>
		isRecord(property)
			? { key, title: describe(key, property), schema: property, required: required.includes(key) }
			: undefined,
	);
	if (!fields.every((field) => field !== undefined)) return DECLINE;
	const answers = await askAll(fields, dialogs, signal);
	if (answers === "cancel") return CANCEL;
	if (answers === "unsupported") return DECLINE;
	// fromEntries defines each key as its own field, even one named __proto__.
	return { action: "accept", content: Object.fromEntries(answers) };
}

async function askAll(
	fields: readonly (Field & { key: string })[],
	dialogs: Dialogs,
	signal: AbortSignal,
): Promise<[string, ElicitationContentValue][] | "cancel" | "unsupported"> {
	const [field, ...rest] = fields;
	if (!field) return [];
	const answer = await ask(field, dialogs, signal);
	if (answer === "cancel" || answer === "unsupported") return answer;
	const others = await askAll(rest, dialogs, signal);
	if (typeof others === "string") return others;
	return answer === "skip" ? others : [[field.key, answer.value], ...others];
}

function describe(key: string, property: Record<string, unknown>): string {
	const { title, description } = property;
	const heading = typeof title === "string" ? title : key;
	const detail = typeof description === "string" ? `: ${description}` : "";
	return `${heading}${detail}`;
}

function choices(schema: Record<string, unknown>): { value: string; label: string }[] | undefined {
	const { items } = schema;
	const { oneOf, anyOf, enum: enumerated } = isRecord(items) ? items : schema;
	const titled = oneOf ?? anyOf;
	const found = Array.isArray(titled)
		? titled.flatMap((option: unknown) => {
				if (!isRecord(option)) return [];
				const { const: value, title } = option;
				return typeof value === "string" ? [{ value, label: typeof title === "string" ? title : value }] : [];
			})
		: Array.isArray(enumerated)
			? enumerated.flatMap((value: unknown) => (typeof value === "string" ? [{ value, label: value }] : []))
			: undefined;
	if (!found) return undefined;
	// Two choices with the same title must stay tellable apart, and picking one must return its value.
	const labels = uniqueLabels(
		found.map(({ label }) => label),
		(label, n) => `${label} (${n})`,
	);
	return found.map(({ value, label }, index) => ({ value, label: labels[index] ?? label }));
}

async function ask(field: Field, dialogs: Dialogs, signal: AbortSignal): Promise<Answer> {
	const { type } = field.schema;
	const listed = choices(field.schema);
	if (type === "boolean") {
		const yesNo = [
			{ value: true, label: "Yes" },
			{ value: false, label: "No" },
		];
		return selectOne(field, yesNo, dialogs, signal);
	}
	if (type === "string" && listed) return selectOne(field, listed, dialogs, signal);
	if (type === "array" && listed) return typed(field, dialogs, signal, (text) => pickMany(text, listed, field.schema));
	if (type === "integer" || type === "number")
		return typed(field, dialogs, signal, (text) => toNumber(text, field.schema, type === "integer"));
	if (type === "string") return typed(field, dialogs, signal, (text) => toText(text, field.schema));
	return "unsupported";
}

/** Picks one choice; an optional field also offers to leave it unanswered. Esc cancels the form. */
async function selectOne(
	field: Field,
	listed: readonly { value: ElicitationContentValue; label: string }[],
	dialogs: Dialogs,
	signal: AbortSignal,
): Promise<Answer> {
	const offered = field.required ? listed : [...listed, { value: "", label: NO_ANSWER }];
	const labels = uniqueLabels(
		offered.map(({ label }) => label),
		(label, n) => `${label} (${n})`,
	);
	const picked = await dialogs.select(field.title, labels, { signal });
	if (picked === undefined) return "cancel";
	const chosen = listed[labels.indexOf(picked)];
	return chosen ? { value: chosen.value } : "skip";
}

type Parsed = { value: ElicitationContentValue } | { problem: string };

/** Asks for text until it parses, at most three times. An empty optional field is skipped. */
async function typed(
	field: Field,
	dialogs: Dialogs,
	signal: AbortSignal,
	parse: (text: string) => Parsed,
): Promise<Answer> {
	const hint = rangeHint(field.schema);
	let problem: string | undefined;
	for (let attempt = 0; attempt < TRIES; attempt++) {
		const notes = [hint, problem && `try again: ${problem}`].filter(Boolean).join("; ");
		const title = notes ? `${field.title} (${notes})` : field.title;
		const text = await dialogs.input(title, undefined, { signal });
		if (text === undefined) return "cancel";
		const answer = text.trim();
		if (answer === "" && !field.required) return "skip";
		const parsed = answer === "" ? { problem: "an answer is required" } : parse(answer);
		if ("value" in parsed) return parsed;
		problem = parsed.problem;
	}
	return "cancel";
}

function rangeHint(schema: Record<string, unknown>): string {
	const { minimum, maximum } = schema;
	if (typeof minimum === "number" && typeof maximum === "number") return `from ${minimum} to ${maximum}`;
	const listed = choices(schema);
	return listed ? `comma-separated: ${listed.map((c) => c.label).join(", ")}` : "";
}

const boundOf = (value: unknown) => (typeof value === "number" ? value : undefined);

function parsedWith(schema: z.ZodType<ElicitationContentValue>, answer: unknown): Parsed {
	const parsed = schema.safeParse(answer);
	return parsed.success
		? { value: parsed.data }
		: { problem: parsed.error.issues[0]?.message ?? "not a valid answer" };
}

function toNumber(text: string, schema: Record<string, unknown>, integer: boolean): Parsed {
	const kind = integer ? "a whole number" : "a number";
	const number = z.coerce.number({ error: kind });
	const whole = integer ? number.int({ error: kind }) : number;
	const { minimum: rawMinimum, maximum: rawMaximum } = schema;
	const minimum = boundOf(rawMinimum);
	const maximum = boundOf(rawMaximum);
	const atLeast = minimum === undefined ? whole : whole.min(minimum, { error: `at least ${minimum}` });
	const atMost = maximum === undefined ? atLeast : atLeast.max(maximum, { error: `at most ${maximum}` });
	return parsedWith(atMost, text);
}

const FORMATS: Readonly<Record<string, z.ZodType<string, string>>> = {
	email: z.email({ error: "an email address" }),
	uri: z.url({ error: "a URL" }),
	date: z.iso.date({ error: "a date such as 2026-11-25" }),
	"date-time": z.iso.datetime({
		offset: true,
		error: "a date and time such as 2026-11-25T10:00:00Z",
	}),
};

/** The form's pattern as a regular expression, or undefined when it has none it can use. */
function patternOf(schema: Record<string, unknown>): RegExp | undefined {
	const { pattern } = schema;
	if (typeof pattern !== "string") return undefined;
	try {
		return new RegExp(pattern, "u");
	} catch {
		// A pattern JavaScript cannot read is not checked; the agent checks the answer itself.
		return undefined;
	}
}

function toText(text: string, schema: Record<string, unknown>): Parsed {
	const { minLength: rawMinLength, maxLength: rawMaxLength, pattern: rawPattern, format: rawFormat } = schema;
	const minLength = boundOf(rawMinLength);
	const maxLength = boundOf(rawMaxLength);
	const string = z.string();
	const atLeast =
		minLength === undefined ? string : string.min(minLength, { error: `at least ${minLength} characters` });
	const atMost =
		maxLength === undefined ? atLeast : atLeast.max(maxLength, { error: `at most ${maxLength} characters` });
	const pattern = patternOf(schema);
	const shaped =
		pattern === undefined ? atMost : atMost.regex(pattern, { error: `in the form ${String(rawPattern)}` });
	const format = typeof rawFormat === "string" ? rawFormat : "";
	const known = Object.hasOwn(FORMATS, format) ? FORMATS[format] : undefined;
	return parsedWith(known ? shaped.pipe(known) : shaped, text);
}

type Listed = readonly { value: string; label: string }[];

/**
 * The values of the choices named in `text`, separated by commas, with undefined for a name that is
 * not a choice. A choice may itself contain a comma, so the longest name that fits is read first.
 */
function readChoices(text: string, listed: Listed): (string | undefined)[] {
	const rest = text.trim();
	if (rest === "") return [];
	// A label the user sees wins over another choice's value when both are spelled the same.
	const named = [
		...listed.map(({ value, label }) => ({ name: label, value })),
		...listed.map(({ value }) => ({ name: value, value })),
	];
	const after = (name: string) => rest.slice(name.length).trimStart();
	const [best] = named
		.filter(({ name }) => name !== "" && rest.startsWith(name) && /^(,|$)/.test(after(name)))
		.toSorted((a, b) => b.name.length - a.name.length);
	// toSorted is stable, so among names of the same length the labels, listed first, stay first.
	if (best) return [best.value, ...readChoices(after(best.name), listed)];
	// Commas with no name between them are skipped in one step, however many there are.
	if (rest.startsWith(",")) return readChoices(rest.replace(/^[\s,]+/, ""), listed);
	const comma = rest.indexOf(",");
	return [undefined, ...(comma < 0 ? [] : readChoices(rest.slice(comma), listed))];
}

function pickMany(text: string, listed: Listed, schema: Record<string, unknown>): Parsed {
	const values = readChoices(text, listed);
	if (values.some((value) => value === undefined)) return { problem: "choose from the list" };
	const { minItems: rawMinItems, maxItems: rawMaxItems, uniqueItems } = schema;
	const minItems = boundOf(rawMinItems);
	const maxItems = boundOf(rawMaxItems);
	const array =
		uniqueItems === true ? z.array(z.string()).refine(once, { error: "each choice once" }) : z.array(z.string());
	const atLeast = minItems === undefined ? array : array.min(minItems, { error: `at least ${minItems}` });
	const atMost = maxItems === undefined ? atLeast : atLeast.max(maxItems, { error: `at most ${maxItems}` });
	return parsedWith(atMost, values);
}
