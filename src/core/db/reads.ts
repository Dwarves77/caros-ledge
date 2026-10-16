// The two bounded reads every pass uses: all rows of a table under a total order and a cap, and the rows whose id column is in a list, chunked under the URL budget. A read error throws; there is no partial result.
import { fetchAllByIdChunks, fetchAllRows } from "./query";
import { qb, type Qb } from "./qb";
import type { Db } from "./clients";

/** Every row of a table whose `idColumn` is in the list, chunked under the URL budget and paged under a total order (`order` must be unique); a read error throws. */
export const rowsByIds = <T>(sb: Db, table: string, columns: string, ids: Iterable<string>, idColumn = "id", order = "id"): Promise<T[]> =>
  fetchAllByIdChunks(ids, (slice) => fetchAllRows<T>((from, to) => sb.from(table).select(columns).in(idColumn, slice).order(order, { ascending: true }).range(from, to) as never, { cap: 500_000 }), { manyPerId: true });
/** Every row of a table under a total order and a cap (the order column must be unique); a read error throws. */
export const allRows = <T>(sb: Db, table: string, columns: string, opts: { order?: string; cap?: number; where?: (q: Qb<T>) => Qb<T> } = {}): Promise<T[]> =>
  fetchAllRows<T>((from, to) => (opts.where ?? ((q: Qb<T>) => q))(qb<T>(sb.from(table).select(columns))).order(opts.order ?? "id", { ascending: true }).range(from, to), { cap: opts.cap ?? 200_000 });
