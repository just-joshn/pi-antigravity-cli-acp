interface Placed {
	readonly label: string;
	readonly index: number;
}

/**
 * Each label, numbered when it equals one given out before it, so the user can tell them apart and
 * picking one by its label finds it. The number skips labels already used. Dialogs list few items.
 */
export function uniqueLabels(labels: readonly string[], numbered: (label: string, n: number) => string): string[] {
	const give = (rest: readonly Placed[], used: ReadonlySet<string>): string[] => {
		const [first, ...others] = rest;
		if (!first) return [];
		const label = unused(first, used, numbered);
		return [label, ...give(others, new Set([...used, label]))];
	};
	return give(
		labels.map((label, index) => ({ label, index })),
		new Set(),
	);
}

/** The label, or it numbered from its position on, the first way that is not used yet. */
function unused(
	{ label, index }: Placed,
	used: ReadonlySet<string>,
	numbered: (label: string, n: number) => string,
): string {
	if (!used.has(label)) return label;
	const from = (n: number): string => (used.has(numbered(label, n)) ? from(n + 1) : numbered(label, n));
	return from(index + 1);
}
