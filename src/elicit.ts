import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
} from "@agentclientprotocol/sdk/unstable";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import { isRecord } from "./guards.ts";

export type Dialogs = Pick<ExtensionUIContext, "select" | "input">;

const FIELD_LIMIT = 20;
const TRIES = 3;
const CANCEL: CreateElicitationResponse = { action: "cancel" };
const DECLINE: CreateElicitationResponse = { action: "decline" };

/** A field's answer: a value, `skip` for an empty optional field, `cancel`, or `unsupported`. */
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
    const picked = await dialogs.select(
      `${request.message}\n${request.url}`,
      ["Continue", "Decline"],
      options,
    );
    if (picked === undefined) return CANCEL;
    return picked === "Continue" ? { action: "accept" } : DECLINE;
  }
  const schema = "requestedSchema" in request ? request.requestedSchema : undefined;
  if (!isRecord(schema)) return DECLINE;
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  // A form with more fields than Pi asks about cannot be answered in full.
  if (Object.keys(properties).length > FIELD_LIMIT) return DECLINE;
  const picked = await dialogs.select(request.message, ["Answer", "Decline"], options);
  if (picked === undefined) return CANCEL;
  if (picked === "Decline") return DECLINE;
  return fillForm(properties, schema["required"], dialogs, signal);
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
  if (fields.some((field) => field === undefined)) return DECLINE;
  const answers = await askAll(
    fields.filter((field) => field !== undefined),
    dialogs,
    signal,
  );
  if (answers === "cancel") return CANCEL;
  if (answers === "unsupported") return DECLINE;
  // fromEntries defines each key as its own field, even one named __proto__.
  return { action: "accept", content: Object.fromEntries(answers) };
}

/** The form's answers, one dialog at a time in its order; a cancel or an unsupported field ends it. */
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
  const title = typeof property["title"] === "string" ? property["title"] : key;
  const detail = typeof property["description"] === "string" ? `: ${property["description"]}` : "";
  return `${title}${detail}`;
}

function titleOf(option: Record<string, unknown>): string {
  const { title, const: value } = option;
  return typeof title === "string" ? title : String(value);
}

function choices(schema: Record<string, unknown>): { value: string; label: string }[] | undefined {
  const source = isRecord(schema["items"]) ? schema["items"] : schema;
  const titled = source["oneOf"] ?? source["anyOf"];
  if (Array.isArray(titled))
    return titled.flatMap((option: unknown) =>
      isRecord(option) && typeof option["const"] === "string"
        ? [{ value: option["const"], label: titleOf(option) }]
        : [],
    );
  const listed = source["enum"];
  if (!Array.isArray(listed)) return undefined;
  return listed.flatMap((value: unknown) =>
    typeof value === "string" ? [{ value, label: value }] : [],
  );
}

async function ask(field: Field, dialogs: Dialogs, signal: AbortSignal): Promise<Answer> {
  const type = field.schema["type"];
  const listed = choices(field.schema);
  const options = { signal };
  if (type === "boolean") {
    const picked = await dialogs.select(field.title, ["Yes", "No"], options);
    return picked === undefined ? "cancel" : { value: picked === "Yes" };
  }
  if (type === "string" && listed) {
    const picked = await dialogs.select(
      field.title,
      listed.map((c) => c.label),
      options,
    );
    const chosen = listed.find((c) => c.label === picked);
    return chosen ? { value: chosen.value } : "cancel";
  }
  if (type === "array" && listed)
    return typed(field, dialogs, signal, (text) => pickMany(text, listed));
  if (type === "integer" || type === "number")
    return typed(field, dialogs, signal, (text) =>
      toNumber(text, field.schema, type === "integer"),
    );
  if (type === "string") return typed(field, dialogs, signal, (text) => toText(text, field.schema));
  return "unsupported";
}

/** A value read from text, or why the text is not one. */
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
    // oxlint-disable-next-line no-await-in-loop -- asks again only after a wrong answer
    const text = await dialogs.input(title, undefined, { signal });
    if (text === undefined) return "cancel";
    if (text.trim() === "" && !field.required) return "skip";
    const parsed = text.trim() === "" ? { problem: "an answer is required" } : parse(text.trim());
    if ("value" in parsed) return parsed;
    problem = parsed.problem;
  }
  return "cancel";
}

function rangeHint(schema: Record<string, unknown>): string {
  const { minimum, maximum } = schema;
  if (typeof minimum === "number" && typeof maximum === "number")
    return `from ${minimum} to ${maximum}`;
  const listed = choices(schema);
  return listed ? `comma-separated: ${listed.map((c) => c.label).join(", ")}` : "";
}

/** A bound the form sets, when it sets one as a number. */
const boundOf = (value: unknown) => (typeof value === "number" ? value : undefined);

/** The answer zod reads from the text, or the first problem it found, worded for the user. */
function parsedWith(schema: z.ZodType<ElicitationContentValue>, text: string): Parsed {
  const parsed = schema.safeParse(text);
  return parsed.success
    ? { value: parsed.data }
    : { problem: parsed.error.issues[0]?.message ?? "not a valid answer" };
}

function toNumber(text: string, schema: Record<string, unknown>, integer: boolean): Parsed {
  const kind = integer ? "a whole number" : "a number";
  const number = z.coerce.number({ error: kind });
  const whole = integer ? number.int({ error: kind }) : number;
  const [minimum, maximum] = [boundOf(schema["minimum"]), boundOf(schema["maximum"])];
  const atLeast =
    minimum === undefined ? whole : whole.min(minimum, { error: `at least ${minimum}` });
  const atMost =
    maximum === undefined ? atLeast : atLeast.max(maximum, { error: `at most ${maximum}` });
  return parsedWith(atMost, text);
}

function toText(text: string, schema: Record<string, unknown>): Parsed {
  const [minLength, maxLength] = [boundOf(schema["minLength"]), boundOf(schema["maxLength"])];
  const string = z.string();
  const atLeast =
    minLength === undefined
      ? string
      : string.min(minLength, { error: `at least ${minLength} characters` });
  const atMost =
    maxLength === undefined
      ? atLeast
      : atLeast.max(maxLength, { error: `at most ${maxLength} characters` });
  return parsedWith(atMost, text);
}

function pickMany(text: string, listed: { value: string; label: string }[]): Parsed {
  const picked = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const values = picked.map(
    (part) => listed.find((c) => c.label === part || c.value === part)?.value,
  );
  if (values.some((value) => value === undefined)) return { problem: "choose from the list" };
  return { value: values.filter((value) => value !== undefined) };
}
