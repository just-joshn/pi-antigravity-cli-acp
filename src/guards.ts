/** Narrows untrusted input, such as parsed JSON or an agent's metadata, to an object that is not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
