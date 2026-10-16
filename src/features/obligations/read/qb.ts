// A minimal structural type for the PostgREST filter builder the two customer reads chain. The Supabase builder's generic result types do not survive a
// dynamic select string, so the reads cast once, here, to the handful of methods they use; a response is always { data, error, count } and the caller
// destructures `error` (a failed read is never an empty list).
export interface QbResponse {
  data: unknown[] | null;
  error: { message: string; code?: string | null } | null;
  count: number | null;
}
export interface Qb extends PromiseLike<QbResponse> {
  eq(column: string, value: unknown): Qb;
  neq(column: string, value: unknown): Qb;
  is(column: string, value: null | boolean): Qb;
  in(column: string, values: readonly unknown[]): Qb;
  gt(column: string, value: unknown): Qb;
  gte(column: string, value: unknown): Qb;
  lt(column: string, value: unknown): Qb;
  lte(column: string, value: unknown): Qb;
  overlaps(column: string, values: readonly unknown[]): Qb;
  order(column: string, opts?: { ascending?: boolean }): Qb;
  range(from: number, to: number): Qb;
  limit(n: number): Qb;
}
export const qb = (builder: unknown): Qb => builder as Qb;

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
