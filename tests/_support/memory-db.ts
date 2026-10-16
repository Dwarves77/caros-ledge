// A stateful stand-in for a Supabase client: real rows in memory, the filters the source modules use applied for real, writes that change state.
// A test can inject a failure on any (table, op) and read back every write. Differs from fake-db.ts, which scripts replies and holds no state.
type Row = Record<string, unknown>;
export interface Failure {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  message: string;
  code?: string;
  /** Fail only when the payload or filters satisfy this. */
  when?: (c: { payload?: unknown; filters: Array<[string, unknown]> }) => boolean;
}
export interface Write {
  table: string;
  op: string;
  payload: unknown;
  filters: Array<[string, unknown]>;
}
const like = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[%*]/g, ".*")}$`, "i");

export function memoryDb(initial: Record<string, Row[]> = {}, opts: { storageFail?: string; failures?: Failure[]; unique?: Record<string, string[]>; rpc?: (name: string, args: unknown) => { data?: unknown; error?: { message: string } | null } } = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const writes: Write[] = [];
  const reads: Array<{ table: string; columns?: string; filters: Array<[string, unknown]> }> = [];
  let seq = 0;
  const objects = new Map<string, Uint8Array>();
  const failures = opts.failures ?? [];

  function from(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    const filters: Array<[string, unknown]> = [];
    let op: Failure["op"] = "select";
    let payload: unknown;
    let columns: string | undefined;
    let head = false;
    let limitN = Infinity;
    let order: [string, boolean] | null = null;
    let range: [number, number] | null = null;
    let onConflict: string | undefined;
    const add = (name: string, p: (r: Row) => boolean, v: unknown) => {
      preds.push(p);
      filters.push([name, v]);
    };
    const run = async () => {
      const fail = failures.find((f) => f.table === table && f.op === op && (!f.when || f.when({ payload, filters })));
      if (op === "select") reads.push({ table, ...(columns ? { columns } : {}), filters });
      else writes.push({ table, op, payload, filters });
      if (fail) return { data: null, error: { message: fail.message, code: fail.code }, count: null };
      const rows = (tables[table] ??= []);
      const match = () => rows.filter((r) => preds.every((p) => p(r)));
      if (op === "select") {
        let out = match();
        if (order) {
          const [col, asc] = order;
          out = [...out].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : String(a[col] ?? "") > String(b[col] ?? "") ? 1 : 0) * (asc ? 1 : -1));
        }
        if (range) out = out.slice(range[0], range[1] + 1);
        out = out.slice(0, limitN);
        return { data: head ? null : out.map((r) => ({ ...r })), error: null, count: head ? match().length : null };
      }
      if (op === "insert" || op === "upsert") {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const inserted: Row[] = [];
        for (const item of list) {
          const keys = op === "upsert" && onConflict ? onConflict.split(",") : (opts.unique?.[table] ?? []);
          const dup = keys.length ? rows.find((r) => keys.every((k) => r[k] === item[k])) : undefined;
          if (dup && op === "insert") return { data: null, error: { message: `duplicate key value violates unique constraint on ${table}`, code: "23505" }, count: null };
          if (dup) {
            Object.assign(dup, item);
            inserted.push(dup);
          } else {
            const row = { id: `${table}-${++seq}`, ...item };
            rows.push(row);
            inserted.push(row);
          }
        }
        return { data: inserted.map((r) => ({ ...r })), error: null, count: null };
      }
      if (op === "update") {
        const hit = match();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit.map((r) => ({ ...r })), error: null, count: null };
      }
      const hit = match();
      tables[table] = rows.filter((r) => !hit.includes(r));
      return { data: hit, error: null, count: null };
    };
    const b: Record<string, unknown> = {};
    const chain = (name: string, fn: (...a: never[]) => void) => (b[name] = (...a: never[]) => (fn(...a), b));
    chain("select", ((cols?: string, o?: { head?: boolean }) => ((columns ??= cols), (head = o?.head === true))) as never);
    chain("insert", ((p: unknown) => ((op = "insert"), (payload = p))) as never);
    chain("update", ((p: unknown) => ((op = "update"), (payload = p))) as never);
    chain("upsert", ((p: unknown, o?: { onConflict?: string }) => ((op = "upsert"), (payload = p), (onConflict = o?.onConflict))) as never);
    chain("delete", (() => (op = "delete")) as never);
    chain("eq", ((c: string, v: unknown) => add(`eq:${c}`, (r) => r[c] === v, v)) as never);
    chain("neq", ((c: string, v: unknown) => add(`neq:${c}`, (r) => r[c] !== v, v)) as never);
    chain("in", ((c: string, v: unknown[]) => add(`in:${c}`, (r) => v.includes(r[c]), v)) as never);
    chain("is", ((c: string, v: unknown) => add(`is:${c}`, (r) => (v === null ? r[c] == null : r[c] === v), v)) as never);
    chain("not", ((c: string, o: string, v: unknown) => add(`not:${c}`, (r) => (o === "is" && v === null ? r[c] != null : true), v)) as never);
    chain("gt", ((c: string, v: unknown) => add(`gt:${c}`, (r) => String(r[c]) > String(v), v)) as never);
    chain("gte", ((c: string, v: unknown) => add(`gte:${c}`, (r) => String(r[c]) >= String(v), v)) as never);
    chain("lt", ((c: string, v: unknown) => add(`lt:${c}`, (r) => String(r[c]) < String(v), v)) as never);
    chain("lte", ((c: string, v: unknown) => add(`lte:${c}`, (r) => String(r[c]) <= String(v), v)) as never);
    chain("ilike", ((c: string, v: string) => add(`ilike:${c}`, (r) => like(v).test(String(r[c] ?? "")), v)) as never);
    chain("like", ((c: string, v: string) => add(`like:${c}`, (r) => like(v).test(String(r[c] ?? "")), v)) as never);
    chain("contains", ((c: string, v: unknown[]) => add(`contains:${c}`, (r) => Array.isArray(r[c]) && v.every((x) => (r[c] as unknown[]).includes(x)), v)) as never);
    chain("or", ((expr: string) => {
      const parts = expr.split(/,(?=[a-z_]+\.)/).map((p) => {
        const m = /^([a-z_]+)\.(ilike|is|lt|eq)\.(.*)$/.exec(p);
        return (r: Row) => {
          if (!m) return false;
          const [, col = "", kind, val = ""] = m;
          if (kind === "ilike") return like(val).test(String(r[col] ?? ""));
          if (kind === "is") return val === "null" ? r[col] == null : String(r[col]) === val;
          if (kind === "lt") return r[col] != null && String(r[col]) < val;
          return String(r[col]) === val;
        };
      });
      add("or", (r) => parts.some((p) => p(r)), expr);
    }) as never);
    chain("order", ((c: string, o?: { ascending?: boolean }) => (order = [c, o?.ascending !== false])) as never);
    chain("limit", ((n: number) => (limitN = n)) as never);
    chain("range", ((a: number, z: number) => (range = [a, z])) as never);
    b.single = async () => {
      const r = await run();
      const list = (r.data ?? []) as Row[];
      return r.error ? r : list.length === 1 ? { ...r, data: list[0] } : { data: null, error: { message: `expected one row, got ${list.length}` }, count: null };
    };
    b.maybeSingle = async () => {
      const r = await run();
      const list = (r.data ?? []) as Row[];
      return r.error ? r : { ...r, data: list[0] ?? null };
    };
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej);
    return b;
  }
  const db = {
    from,
    rpc: async (name: string, args?: unknown) => ({ data: null, error: null, ...(opts.rpc?.(name, args) ?? {}) }),
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, body: Uint8Array) => {
          if (opts.storageFail) return { data: null, error: { message: opts.storageFail } };
          objects.set(`${bucket}/${path}`, body);
          return { data: {}, error: null };
        },
        download: async (path: string) => {
          const body = objects.get(`${bucket}/${path}`);
          return body ? { data: new Blob([body as BlobPart]), error: null } : { data: null, error: { message: "no object" } };
        },
      }),
    },
  };
  return { db: db as never, tables, writes, reads, objects, wrote: (table: string, op?: string) => writes.filter((w) => w.table === table && (!op || w.op === op)) };
}
