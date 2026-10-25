// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the one paged read of the spine passes. Every row of a table under the total order given (the columns of its key), a read error throws, a result beyond the cap throws; never a partial list.
import type { Db } from "@/core/db";
import { fetchAllRows, qb, type Qb } from "@/core/db";

export type Row = Record<string, unknown>;
export const readAll = <T = Row>(sb: Db, table: string, columns: string, order: readonly string[], where: (q: Qb<T>) => Qb<T> = (q) => q): Promise<T[]> =>
  fetchAllRows<T>((from, to) => order.reduce((q, o) => q.order(o, { ascending: true }), where(qb<T>(sb.from(table).select(columns)))).range(from, to), { cap: 1_000_000 });
