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

/** Answers handed out in order, one per call. Asking once they run out fails the test. */
export function answering<T>(answers: readonly T[]) {
  let left = answers;
  return () => {
    const [next, ...rest] = left;
    if (left.length === 0)
      throw new Error(`asked more than the ${answers.length} scripted answers`);
    left = rest;
    return next;
  };
}
