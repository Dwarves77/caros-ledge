// New file: the one paged-read helper the ops runtimes share (every read destructures its error through fetchAllRows and throws on a failed page).
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";

export interface ReadOpts {
  eq?: [string, string | boolean];
  notNull?: string;
  isNull?: string;
}
/** Every row of a table, total-ordered by `order`; a failed page throws, never an empty list. */
export function readTable<T>(sb: Db, table: string, columns: string, order: string, o: ReadOpts = {}): Promise<T[]> {
  return fetchAllRows<T>((from, to) => {
    let q = sb.from(table).select(columns);
    if (o.eq) q = q.eq(o.eq[0], o.eq[1]);
    if (o.notNull) q = q.not(o.notNull, "is", null);
    if (o.isNull) q = q.is(o.isNull, null);
    return q.order(order, { ascending: true }).range(from, to) as unknown as PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  }, { cap: 2_000_000 });
}
