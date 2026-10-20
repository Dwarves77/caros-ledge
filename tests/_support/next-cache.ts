// Stands in for next/cache for every source module under test (scripts/lib/ts-hooks.mjs): outside a request Next's unstable_cache and revalidateTag have no incremental cache and refuse, so a module drawn in a node test could never run.
// The stand-in runs the function every time, which is what a cold cache does; no page or reader keeps a cached read (tests/derived/readers-behaviour.test.ts proves it).
/** A test sets `flush.fails` to make the next flushes throw, as Next does when a tag is flushed with no request store (the corrections route reports it). */
export const flush = { fails: false };
export const revalidateTag = (): void => {
  if (flush.fails) throw new Error("Invariant: static generation store missing in revalidateTag");
};
export const revalidatePath = (): void => {};
export const updateTag = (): void => {};
