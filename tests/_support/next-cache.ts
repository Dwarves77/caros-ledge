// Stands in for next/cache for every source module under test (scripts/lib/ts-hooks.mjs): outside a request Next's unstable_cache has no incremental cache and refuses, so a page drawn in a node test could never read
// through cachedRead. The stand-in runs the read every time, which is what a cold cache does; the caching rules themselves (a failure is never cached) are proven on cachedRead's injectable store.
type Fn = (...args: never[]) => unknown;
export const unstable_cache = <F extends Fn>(fn: F): F => fn;
export const revalidateTag = (): void => {};
export const revalidatePath = (): void => {};
export const updateTag = (): void => {};
