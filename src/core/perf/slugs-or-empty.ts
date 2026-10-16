// Ported from old_repo/src/lib/perf/static-params-fallback.mjs (lines 1-43)
import { log } from "@/core/shared/log";

const TIMED_OUT = Symbol("static-params-fallback:timed-out");

/** A build-time slug read raced against a deadline (10 s): an empty list on a timeout or a failure, with an honest warning, so a slow read never blocks a build (the route still renders on demand). The timer is always cleared. */
export async function slugsOrEmpty(read: () => Promise<string[]>, { timeoutMs = 10_000, warn = (m: string) => log.warn(m), route }: { timeoutMs?: number; warn?: (msg: string) => void; route?: string } = {}): Promise<string[]> {
  const label = route ?? "(unnamed route)";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  // A synchronous throw is caught by the same try as a rejection; a rejection after the timeout won is handled so it never surfaces as unhandled.
  const reading = Promise.resolve().then(read);
  reading.catch(() => {});
  try {
    const result = await Promise.race([reading, timeout]);
    if (result === TIMED_OUT) {
      warn(`generateStaticParams for ${label}: slug read exceeded ${timeoutMs}ms - falling back to [] for this build. The route still renders on demand via dynamicParams; only build-time pre-baking is skipped.`);
      return [];
    }
    return Array.isArray(result) ? result : [];
  } catch (err) {
    warn(`generateStaticParams for ${label}: slug read failed (${err instanceof Error ? err.message : String(err)}) - falling back to [] for this build. The route still renders on demand via dynamicParams; only build-time pre-baking is skipped.`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
