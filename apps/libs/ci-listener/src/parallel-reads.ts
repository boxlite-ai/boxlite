/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
/** Drain siblings before returning the initiating failure; the caller owns credential retirement. */
export async function parallelReads<T, R>(
  values: readonly T[],
  read: (value: T, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
  concurrency = 5,
): Promise<R[]> {
  const stop = new AbortController(),
    combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
  const results: R[] = []
  let next = 0,
    failed = false,
    failure: unknown
  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (!failed && next < values.length) {
        const index = next++
        try {
          results[index] = await read(values[index], combined)
        } catch (error) {
          if (!failed) {
            failed = true
            failure = error
            stop.abort()
          }
        }
      }
    }),
  )
  if (failed) throw failure
  return results
}
