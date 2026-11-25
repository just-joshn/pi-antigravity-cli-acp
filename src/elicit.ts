import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
} from "@agentclientprotocol/sdk/unstable";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

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
  const picked = await dialogs.select(request.message, ["Answer", "Decline"], options);
  if (picked === undefined) return CANCEL;
  if (picked === "Decline") return DECLINE;
  return fillForm(schema, dialogs, signal);
}

async function fillForm(
  schema: Record<string, unknown>,
  dialogs: Dialogs,
  signal: AbortSignal,
): Promise<CreateElicitationResponse> {
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const required = Array.isArray(schema["required"]) ? schema["required"] : [];
  const content: [string, ElicitationContentValue][] = [];
  for (const [key, property] of Object.entries(properties).slice(0, FIELD_LIMIT)) {
    if (!isRecord(property)) return DECLINE;
    const title = describe(key, property);
    const field = { title, schema: property, required: required.includes(key) };
    // oxlint-disable-next-line no-await-in-loop -- one dialog at a time, in the form's order
    const answer = await ask(field, dialogs, signal);
    if (answer === "cancel") return CANCEL;
    if (answer === "unsupported") return DECLINE;
    if (answer !== "skip") content.push([key, answer.value]);
  }
  // fromEntries defines each key as its own field, even one named __proto__.
  return { action: "accept", content: Object.fromEntries(content) };
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

function toNumber(text: string, schema: Record<string, unknown>, integer: boolean): Parsed {
  const value = Number(text);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)))
    return { problem: integer ? "a whole number" : "a number" };
  const { minimum, maximum } = schema;
  if (typeof minimum === "number" && value < minimum) return { problem: `at least ${minimum}` };
  if (typeof maximum === "number" && value > maximum) return { problem: `at most ${maximum}` };
  return { value };
}

function toText(text: string, schema: Record<string, unknown>): Parsed {
  const { minLength, maxLength } = schema;
  if (typeof minLength === "number" && text.length < minLength)
    return { problem: `at least ${minLength} characters` };
  if (typeof maxLength === "number" && text.length > maxLength)
    return { problem: `at most ${maxLength} characters` };
  return { value: text };
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
