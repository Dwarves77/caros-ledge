// The read helpers over the one structural builder type (@/core/db): rows or a thrown Error naming the read, and a count.
import type { QbResponse } from "@/core/db";

/** A read result: rows, or a thrown Error naming the read (the route turns it into a 503). */
export function rowsOf<T>(what: string, r: QbResponse): T[] {
  if (r.error) throw new Error(`${what} read failed: ${r.error.message}`);
  return (r.data ?? []) as T[];
}
export function countOf(what: string, r: QbResponse): number {
  if (r.error) throw new Error(`${what} count failed: ${r.error.message}`);
  if (typeof r.count !== "number") throw new Error(`${what} count failed: no count returned`);
  return r.count;
}
