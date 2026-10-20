// Stands in for next/cache for every source module under test (scripts/lib/ts-hooks.mjs): outside a request Next's unstable_cache has no incremental cache and refuses, so a page drawn in a node test could never read
// through cachedRead. The stand-in runs the read every time, which is what a cold cache does; the caching rules themselves (a failure is never cached) are proven on cachedRead's injectable store.
type Fn = (...args: never[]) => unknown;
export const unstable_cache = <F extends Fn>(fn: F): F => fn;
/** A test sets `flush.fails` to make the next flushes throw, as Next does when a tag is flushed with no request store (the corrections route reports it). */
export const flush = { fails: false };
export const revalidateTag = (): void => {
  if (flush.fails) throw new Error("Invariant: static generation store missing in revalidateTag");
};
export const revalidatePath = (): void => {};
export const updateTag = (): void => {};
