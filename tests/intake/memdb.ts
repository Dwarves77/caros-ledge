// A small STATEFUL stand-in for a Supabase client: rows live in memory, filters and writes behave like PostgREST for the subset the
// intake slice uses. Failures are injected per call (`failWhen`). tests/_support/fake-db.ts is scripted and stateless; the intake
// workflows read back what they wrote, so they need this one.
export type Row = Record<string, unknown>;
export interface MemCall { table: string; op: "select" | "insert" | "update" | "upsert" | "delete"; payload?: unknown; filters: [string, string, unknown][] }
type Err = { message: string; code?: string } | null;
type RpcFn = (args: Record<string, unknown>, db: MemDb) => { data?: unknown; error?: Err };

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const WITH_ID = new Set(["intelligence_items", "agent_run_searches", "section_claim_provenance", "claim_versions", "intelligence_item_sections", "item_timelines", "integrity_flags", "agent_runs", "staged_updates", "sources", "portal_link_candidates", "disposition_ledger", "item_cross_references", "item_forward_events", "vocabulary_terms"]);

export class MemDb {
  tables: Record<string, Row[]> = {};
  calls: MemCall[] = [];
  rpcs: Record<string, RpcFn> = {};
  rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  failWhen: ((c: MemCall) => string | null) | null = null;
  /** A database trigger stand-in: runs after every successful write. */
  afterWrite: ((c: MemCall, db: MemDb) => void) | null = null;
  now = "2026-10-15T12:00:00.000Z";

  seed(table: string, rows: Row[]): this {
    for (const r of rows) (this.tables[table] ??= []).push({ ...(WITH_ID.has(table) && r.id === undefined ? { id: uuid() } : {}), ...r });
    return this;
  }
  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }
  writes(table: string, op?: MemCall["op"]): MemCall[] {
    return this.calls.filter((c) => c.table === table && c.op !== "select" && (!op || c.op === op));
  }
  get client(): never {
    return this as unknown as never;
  }

  from(table: string) {
    return new Query(this, table) as unknown;
  }
  async rpc(name: string, args: Record<string, unknown> = {}) {
    this.rpcCalls.push({ name, args });
    const fn = this.rpcs[name];
    if (!fn) return { data: null, error: { message: `rpc ${name} is not scripted` } };
    const r = fn(args, this);
    return { data: r.data ?? null, error: r.error ?? null };
  }
  auth = { getClaims: async () => ({ data: null, error: { message: "no session" } }) };
}

class Query {
  private op: MemCall["op"] = "select";
  private payload: unknown;
  private filters: [string, string, unknown][] = [];
  private preds: ((r: Row) => boolean)[] = [];
  private orders: [string, boolean][] = [];
  private lim: number | null = null;
  private rng: [number, number] | null = null;
  private head = false;
  private count = false;
  private returning = false;
  private opts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private single_: "one" | "maybe" | null = null;
  private db: MemDb;
  private table: string;
  constructor(db: MemDb, table: string) {
    this.db = db;
    this.table = table;
  }

  select(_cols?: string, o?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      this.head = o?.head === true;
      this.count = o?.count !== undefined;
    } else this.returning = true;
    return this;
  }
  insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
  update(p: unknown) { this.op = "update"; this.payload = p; return this; }
  upsert(p: unknown, o?: { onConflict?: string; ignoreDuplicates?: boolean }) { this.op = "upsert"; this.payload = p; this.opts = o ?? {}; return this; }
  delete() { this.op = "delete"; return this; }
  private f(op: string, col: string, val: unknown, pred: (r: Row) => boolean) { this.filters.push([op, col, val]); this.preds.push(pred); return this; }
  eq(c: string, v: unknown) { return this.f("eq", c, v, (r) => r[c] === v || (v === null && r[c] == null)); }
  neq(c: string, v: unknown) { return this.f("neq", c, v, (r) => r[c] !== v); }
  gt(c: string, v: unknown) { return this.f("gt", c, v, (r) => (r[c] as never) > (v as never)); }
  gte(c: string, v: unknown) { return this.f("gte", c, v, (r) => (r[c] as never) >= (v as never)); }
  lt(c: string, v: unknown) { return this.f("lt", c, v, (r) => (r[c] as never) < (v as never)); }
  lte(c: string, v: unknown) { return this.f("lte", c, v, (r) => (r[c] as never) <= (v as never)); }
  in(c: string, v: unknown[]) { return this.f("in", c, v, (r) => v.includes(r[c])); }
  is(c: string, v: unknown) { return this.f("is", c, v, (r) => (v === null ? r[c] == null : r[c] === v)); }
  not(c: string, op: string, v: unknown) { return this.f(`not.${op}`, c, v, (r) => (op === "is" ? !(v === null ? r[c] == null : r[c] === v) : r[c] !== v)); }
  like(c: string, pat: string) { const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`); return this.f("like", c, pat, (r) => re.test(String(r[c] ?? ""))); }
  ilike(c: string, pat: string) { const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i"); return this.f("ilike", c, pat, (r) => re.test(String(r[c] ?? ""))); }
  order(c: string, o?: { ascending?: boolean }) { this.orders.push([c, o?.ascending !== false]); return this; }
  limit(n: number) { this.lim = n; return this; }
  range(a: number, b: number) { this.rng = [a, b]; return this; }
  maybeSingle() { this.single_ = "maybe"; return this; }
  single() { this.single_ = "one"; return this; }
  then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }

  private run(): { data: unknown; error: Err; count: number | null } {
    const call: MemCall = { table: this.table, op: this.op, payload: this.payload, filters: this.filters };
    this.db.calls.push(call);
    const fail = this.db.failWhen?.(call);
    if (fail) return { data: null, error: { message: fail }, count: null };
    const result = this.exec();
    if (call.op !== "select" && !result.error) this.db.afterWrite?.(call, this.db);
    return result;
  }

  private exec(): { data: unknown; error: Err; count: number | null } {
    const rows = this.db.rows(this.table);
    const matching = () => rows.filter((r) => this.preds.every((p) => p(r)));
    let out: Row[] = [];
    if (this.op === "insert" || this.op === "upsert") {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      for (const p of list) {
        const keys = this.opts.onConflict?.split(",").map((k) => k.trim());
        const hit = keys ? rows.find((r) => keys.every((k) => r[k] === p[k])) : undefined;
        if (hit) {
          if (!this.opts.ignoreDuplicates) Object.assign(hit, p);
          out.push(hit);
          continue;
        }
        const row = { ...(WITH_ID.has(this.table) && p.id === undefined ? { id: uuid() } : {}), ...(this.table === "agent_runs" && p.created_at === undefined ? { created_at: this.db.now } : {}), ...p };
        rows.push(row);
        out.push(row);
      }
      if (!this.returning) return { data: null, error: null, count: null };
    } else if (this.op === "update") {
      out = matching();
      for (const r of out) Object.assign(r, this.payload);
      if (!this.returning) return { data: null, error: null, count: null };
    } else if (this.op === "delete") {
      const gone = new Set(matching());
      this.db.tables[this.table] = rows.filter((r) => !gone.has(r));
      return { data: null, error: null, count: null };
    } else {
      out = matching();
      const total = out.length;
      for (const [c, asc] of [...this.orders].reverse()) out = [...out].sort((a, b) => (String(a[c] ?? "") < String(b[c] ?? "") ? -1 : String(a[c] ?? "") > String(b[c] ?? "") ? 1 : 0) * (asc ? 1 : -1));
      if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim !== null) out = out.slice(0, this.lim);
      if (this.head) return { data: null, error: null, count: total };
      out = out.map((r) => ({ ...r }));
      if (this.count) return { data: out, error: null, count: total };
    }
    if (this.single_) {
      if (out.length > 1) return { data: null, error: { message: "multiple rows returned" }, count: null };
      if (!out.length) return this.single_ === "one" ? { data: null, error: { message: "no rows returned", code: "PGRST116" }, count: null } : { data: null, error: null, count: null };
      return { data: out[0], error: null, count: null };
    }
    return { data: out, error: null, count: null };
  }
}
