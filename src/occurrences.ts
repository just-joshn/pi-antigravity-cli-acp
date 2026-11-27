interface Occurrence<T> {
	readonly item: T;
	/** How many items have this item's key, itself included. */
	readonly of: number;
}

/** Each item of `items`, in order, with how many items share its key. */
export function occurrences<T>(items: readonly T[], key: (item: T) => string): Occurrence<T>[] {
	const indexed = items.map((item, index) => ({ item, index }));
	return [...Map.groupBy(indexed, ({ item }) => key(item)).values()]
		.flatMap((group) => group.map(({ item, index }) => ({ index, item, of: group.length })))
		.toSorted((a, b) => a.index - b.index)
		.map(({ item, of }) => ({ item, of }));
}
