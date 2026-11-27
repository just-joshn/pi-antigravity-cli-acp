/** A copy of `map` with `key` set to `value`; `map` is left as it was. */
export function put<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
	const copy = new Map(map);
	copy.set(key, value);
	return copy;
}

/** A copy of `map` without `key`; `map` is left as it was. */
export function without<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
	if (!map.has(key)) return map;
	const copy = new Map(map);
	copy.delete(key);
	return copy;
}
