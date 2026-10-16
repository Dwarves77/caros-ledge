// One minimal structural type for the PostgREST filter builder the reads chain (IMP-049). The Supabase builder's generic result types do not survive a dynamic select string, so a read casts ONCE, here, to the
// handful of methods it uses. A response is always { data, error, count } and the caller destructures `error` (a failed read is never an empty list).
export interface QbResponse<T = unknown> {
  data: T[] | null;
  error: { message: string; code?: string | null } | null;
  count: number | null;
}
export interface Qb<T = unknown> extends PromiseLike<QbResponse<T>> {
  eq(column: string, value: unknown): Qb<T>;
  neq(column: string, value: unknown): Qb<T>;
  is(column: string, value: null | boolean): Qb<T>;
  in(column: string, values: readonly unknown[]): Qb<T>;
  gt(column: string, value: unknown): Qb<T>;
  gte(column: string, value: unknown): Qb<T>;
  lt(column: string, value: unknown): Qb<T>;
  lte(column: string, value: unknown): Qb<T>;
  not(column: string, operator: string, value: unknown): Qb<T>;
  like(column: string, pattern: string): Qb<T>;
  ilike(column: string, pattern: string): Qb<T>;
  contains(column: string, values: readonly unknown[]): Qb<T>;
  overlaps(column: string, values: readonly unknown[]): Qb<T>;
  order(column: string, opts?: { ascending?: boolean }): Qb<T>;
  range(from: number, to: number): Qb<T>;
  limit(n: number): Qb<T>;
}
export const qb = <T = unknown>(builder: unknown): Qb<T> => builder as Qb<T>;
