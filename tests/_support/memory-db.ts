// The functional face of the one shared memory database (tests/_support/memdb.ts): `memoryDb(initial, opts)` returns the client with the tables and the read and write logs the source, producer and connect
// tests were written against. Rows live in memory, filters apply for real, writes change state, and a test can inject a failure on any (table, op).
import { MemDb, type Op, type Row } from "./memdb.ts";

export type { Row };
export interface Failure {
  table: string;
  op: Op;
  message: string;
  code?: string;
  /** Fail only when the payload or filters satisfy this (filters as `[kind:column, value]`). */
  when?: (c: { payload?: unknown; filters: Array<[string, unknown]> }) => boolean;
}
export interface Write {
  table: string;
  op: string;
  payload: unknown;
  filters: Array<[string, unknown]>;
}
const named = (filters: [string, string, unknown][]): Array<[string, unknown]> => filters.map(([kind, c, v]) => [`${kind}:${c}`, v]);

export function memoryDb(
  initial: Record<string, Row[]> = {},
  opts: { schema?: null; storageFail?: string; failures?: Failure[]; unique?: Record<string, string[]>; rpc?: (name: string, args: unknown) => { data?: unknown; error?: { message: string } | null } | undefined } = {},
) {
  const mem = new MemDb({ ids: "seq", returnRows: true, ...(opts.schema === null ? { schema: null } : {}), unique: Object.fromEntries(Object.entries(opts.unique ?? {}).map(([t, cols]) => [t, [cols]])) });
  for (const [t, rows] of Object.entries(initial)) mem.seed(t, rows);
  for (const f of opts.failures ?? []) mem.fail(f.table, f.op, f.message, { ...(f.code ? { code: f.code } : {}), ...(f.when ? { when: (c) => f.when?.({ payload: c.payload, filters: named(c.filters) }) ?? true } : {}) });
  if (opts.storageFail) mem.storageFail = opts.storageFail;
  const scripted = mem.rpc.bind(mem);
  const client = Object.assign(mem, {
    rpc: async (name: string, args?: unknown) => {
      const r = opts.rpc?.(name, args);
      if (r) return { data: null, error: null, ...r };
      return mem.rpcs[name] ? scripted(name, (args ?? {}) as Record<string, unknown>) : { data: null, error: null };
    },
  });
  const writes = (): Write[] => mem.writes().map((c) => ({ table: c.table, op: c.op, payload: c.payload, filters: named(c.filters) }));
  const reads = () => mem.reads().map((c) => ({ table: c.table, filters: named(c.filters) }));
  return {
    db: client as never,
    tables: mem.tables,
    get writes() {
      return writes();
    },
    get reads() {
      return reads();
    },
    objects: mem.objects,
    wrote: (table: string, op?: string) => writes().filter((w) => w.table === table && (!op || w.op === op)),
    mem,
  };
}
