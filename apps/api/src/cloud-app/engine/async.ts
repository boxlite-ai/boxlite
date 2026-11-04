/** Evaluates predicates before selecting entries; native Array.filter does not await them. */
export async function filterAsync<T>(values: T[], predicate: (value: T) => Promise<unknown>): Promise<T[]> {
  const selected = await Promise.all(values.map(predicate))
  return values.filter((_value, index) => Boolean(selected[index]))
}
