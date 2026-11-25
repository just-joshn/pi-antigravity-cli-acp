/** Items a test collects from callbacks, kept as a list that is replaced, never edited. */
export function recorder<T>() {
  let items: readonly T[] = [];
  return {
    record(item: T) {
      items = [...items, item];
    },
    all: () => items,
  };
}

/** Answers handed out in order, one per call; undefined once they run out. */
export function answering<T>(answers: readonly T[]) {
  let left = answers;
  return () => {
    const [next, ...rest] = left;
    left = rest;
    return next;
  };
}
