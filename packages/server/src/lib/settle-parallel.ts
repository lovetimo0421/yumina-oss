/** Preserve Promise.all's ordered results and first observed rejection, but
 * drain every launched sibling before propagating a failure to the caller. */
export async function settleParallel<T extends readonly unknown[] | []>(
  values: T,
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  // Drizzle queries are lazy thenables: normalize once so draining cannot
  // execute them again after Promise.all observes a rejection.
  const pending = values.map(value => Promise.resolve(value));
  try {
    return await Promise.all(pending) as { -readonly [P in keyof T]: Awaited<T[P]> };
  } catch (error) {
    await Promise.allSettled(pending);
    throw error;
  }
}
