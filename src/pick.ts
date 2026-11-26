import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** Shows `labels` in a select dialog; resolves with the item at the picked label's position. */
export async function pick<T>(
  ui: Pick<ExtensionUIContext, "select">,
  title: string,
  items: readonly T[],
  labels: string[],
  signal?: AbortSignal,
): Promise<T | undefined> {
  const picked = await ui.select(title, labels, signal && { signal });
  return picked === undefined ? undefined : items[labels.indexOf(picked)];
}
