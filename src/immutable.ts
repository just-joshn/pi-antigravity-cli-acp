/** A copy of `map` with `key` set to `value`; `map` is left as it was. */
export function put<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  return new Map(map).set(key, value);
}

/** A copy of `map` without `key`; `map` is left as it was. */
export function without<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  if (!map.has(key)) return map;
  const copy = new Map(map);
  copy.delete(key);
  return copy;
}

/** Values by id, shared by reference; each change replaces the map inside instead of editing it. */
export class Registry<V> {
  #entries: ReadonlyMap<string, V> = new Map();

  get(id: string): V | undefined {
    return this.#entries.get(id);
  }

  put(id: string, value: V) {
    this.#entries = put(this.#entries, id, value);
  }

  remove(id: string) {
    this.#entries = without(this.#entries, id);
  }
}
