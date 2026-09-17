export function memo1<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  let last: { args: A; value: R } | null = null;
  return (...args: A) => {
    if (
      last &&
      last.args.length === args.length &&
      last.args.every((a, i) => a === args[i])
    ) {
      return last.value;
    }
    const value = fn(...args);
    last = { args, value };
    return value;
  };
}
