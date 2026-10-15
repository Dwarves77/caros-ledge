// Ported from old_repo/src/lib/db/paginate.mjs (lines 15-107)
// Ported from old_repo/src/lib/supabase-server.ts (lines 2680-2705)
// The query kit: every read is bounded, timed and typed so a failure is a value, never an empty result.
export const MAX_BOUND = 200;

export interface PgError {
  message: string;
  code?: string | null;
}
type Response<T> = PromiseLike<{ data: T[] | null; error: PgError | null }>;

export class ReadTimeoutError extends Error {
  constructor(ms: number) {
    super(`Supabase read exceeded ${ms}ms`);
    this.name = "ReadTimeoutError";
  }
}

/** Race a promise against a deadline and always clear the timer. */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new ReadTimeoutError(ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface ReadError {
  message: string;
  code: string | null;
  timedOut: boolean;
}
export type ReadResult<T> =
  | { data: T[]; truncated: boolean; error: null }
  | { data: null; truncated: false; error: ReadError };

/**
 * One bounded read. `build(limit)` must apply `.limit(limit)`; a response longer than the bound is an error,
 * and `truncated` is true when the bound was reached so a cut-off list never passes for a complete one.
 * A failed read returns `{ error }`: the caller decides, nothing renders empty and nothing caches a failure.
 */
export async function boundedRead<T>(build: (limit: number) => Response<T>, opts: { limit: number; timeoutMs?: number }): Promise<ReadResult<T>> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_BOUND) throw new RangeError(`boundedRead limit must be 1..${MAX_BOUND}, got ${opts.limit}`);
  try {
    const { data, error } = await withTimeout(build(opts.limit), opts.timeoutMs ?? 10_000);
    if (error) return { data: null, truncated: false, error: { message: error.message, code: error.code ?? null, timedOut: false } };
    const rows = data ?? [];
    if (rows.length > opts.limit) return { data: null, truncated: false, error: { message: `read returned ${rows.length} rows past its ${opts.limit}-row bound`, code: null, timedOut: false } };
    return { data: rows, truncated: rows.length === opts.limit, error: null };
  } catch (e) {
    return { data: null, truncated: false, error: { message: e instanceof Error ? e.message : String(e), code: null, timedOut: e instanceof ReadTimeoutError } };
  }
}

/** For a read whose failure must reject (so a cache wrapper cannot store it). */
export function unwrap<T>(result: ReadResult<T>): T[] {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export interface Page<T> {
  rows: T[];
  next: string | null;
}

/** Keyset paging: ask for `limit + 1` rows ordered by a unique key; the extra row only proves there is a next page. */
export const keyset = {
  page<T>(rows: T[], limit: number, cursorOf: (row: T) => unknown[]): Page<T> {
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { rows: page, next: rows.length > limit && last !== undefined ? keyset.encode(cursorOf(last)) : null };
  },
  encode(parts: unknown[]): string {
    return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
  },
  decode(cursor: string | null | undefined): unknown[] | null {
    if (!cursor) return null;
    try {
      const parts: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      return Array.isArray(parts) ? parts : null;
    } catch {
      return null;
    }
  },
};

/**
 * Every row of a query, one page at a time. The builder must apply a TOTAL order (a unique column), or offset
 * paging skips and repeats rows at page boundaries. Throws on any page error: never a partial result.
 */
export async function fetchAllRows<T>(pageFactory: (from: number, to: number) => Response<T>, { pageSize = 1000, cap = Infinity } = {}): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await pageFactory(from, from + pageSize - 1);
    if (error) throw new Error(`paginated read failed at offset ${from}: ${error.message}`);
    const page = data ?? [];
    all.push(...page);
    if (all.length > cap) throw new Error(`paginated read exceeded its cap of ${cap} rows (got ${all.length})`);
    if (page.length < pageSize) return all;
  }
}

/** The exact count of a query built with `{ count: "exact", head: true }`; never the length of a fetched page. */
export async function exactCount(countQuery: PromiseLike<{ count: number | null; error: PgError | null }>): Promise<number> {
  const { count, error } = await countQuery;
  if (error) throw new Error(`exact count failed: ${error.message}`);
  if (typeof count !== "number") throw new Error("exact count failed: no count returned");
  return count;
}

/** An id-list read in URL-safe chunks (a long `.in()` list answers 400 past about 2,000 uuids). */
export async function fetchAllByIdChunks<T>(ids: Iterable<string>, readChunk: (slice: string[]) => Promise<T[]>, { chunk = 50, manyPerId = false } = {}): Promise<T[]> {
  const list = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < list.length; i += chunk) out.push(...(await readChunk(list.slice(i, i + chunk))));
  if (!manyPerId && out.length > list.length) throw new Error(`fetchAllByIdChunks: ${out.length} rows for ${list.length} ids; a primary-key filter cannot return more`);
  return out;
}
