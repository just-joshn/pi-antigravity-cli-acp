/** Narrows untrusted input, such as parsed JSON or an agent's metadata, to a plain object. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
