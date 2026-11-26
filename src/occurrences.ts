/** One item's place among the items of a list that share its key. */
interface Occurrence<T> {
  readonly item: T;
  /** Which of the items with this key it is, counting from 1. */
  readonly nth: number;
  /** How many items have this key. */
  readonly of: number;
}

/** Each item of `items`, in order, with its place among the items that share its key. */
export function occurrences<T>(items: readonly T[], key: (item: T) => string): Occurrence<T>[] {
  const indexed = items.map((item, index) => ({ item, index }));
  const groups = Map.groupBy(indexed, ({ item }) => key(item));
  return [...groups.values()]
    .flatMap((group) =>
      group.map(({ item, index }, n) => ({ index, place: { item, nth: n + 1, of: group.length } })),
    )
    .toSorted((a, b) => a.index - b.index)
    .map(({ place }) => place);
}
