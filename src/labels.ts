/** Number repeated labels from their 1-based positions, skipping labels already used. */
export function uniqueLabels(labels: readonly string[], numbered: (label: string, n: number) => string): string[] {
	const used = new Set<string>();
	return labels.map((label, index) => {
		let shown = label;
		if (used.has(label)) {
			let n = index + 1;
			while (used.has(numbered(label, n))) n++;
			shown = numbered(label, n);
		}
		used.add(shown);
		return shown;
	});
}
