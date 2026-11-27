interface Occurrence<T> {
	readonly item: T;
	/** How many items have this item's key, itself included. */
	readonly of: number;
}

/** Each item of `items`, in order, with how many items share its key. */
export function occurrences<T>(items: readonly T[], key: (item: T) => string): Occurrence<T>[] {
	const indexed = items.map((item, index) => ({ item, index }));
	const groups = Map.groupBy(indexed, ({ item }) => key(item));
	const result: Occurrence<T>[] = [];
	for (const group of groups.values()) {
		for (const { item, index } of group) result[index] = { item, of: group.length };
	}
	return result;
}
