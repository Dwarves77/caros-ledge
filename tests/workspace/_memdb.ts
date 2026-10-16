// A small in-memory stand-in for a Supabase client: real rows, real filters, unique keys, generated name keys, an updated_at that
// moves on every update, and await points between calls so two concurrent callers genuinely interleave. Used to prove behaviour
// (what was written, what was left alone) rather than to replay canned replies.
export type Row = Record<string, unknown>;
export interface DbError {
  message: string;
  code?: string;
}
interface Failure {
  table: string;
  op: string;
  error: DbError;
  /** How many matching calls fail; omitted means every one. */
  times?: number;
  /** Only calls whose filters satisfy this fail (for example "the roster read, not the membership guard"). */
  when?: (filters: [string, string, unknown][]) => boolean;
}
export interface Logged {
  table: string;
  op: string;
  payload?: unknown;
  filters: [string, string, unknown][];
}

const UNIQUE: Record<string, string[][]> = {
  workspace_tags: [["org_id", "name_key"]],
  item_workspace_tags: [["tag_id", "intelligence_item_id"]],
  portfolios: [["org_id", "name_key"]],
  portfolio_members: [["portfolio_id", "item_id"], ["portfolio_id", "entity_id"]],
  workspace_item_overrides: [["org_id", "item_id"]],
  user_item_state: [["user_id", "item_id"]],
  item_assignments: [["item_id", "assignee_user_id"]],
};
const GENERATED_KEY = new Set(["workspace_tags", "portfolios"]);
const TOUCHED = new Set(["workspace_settings"]);
/** table.related: [column on table, key on related]. */
const RELATIONS: Record<string, [string, string]> = {
  "org_memberships.profiles": ["user_id", "id"],
  "user_item_state.intelligence_items": ["item_id", "id"],
};

export class MemDb {
  tables: Record<string, Row[]> = {};
  log: Logged[] = [];
  failures: Failure[] = [];
  rpcs: Record<string, (args: unknown) => unknown> = {};
  private seq = 0;

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(seed)) this.tables[t] = rows.map((r) => ({ ...r }));
  }
  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }
  writes(table?: string): Logged[] {
    return this.log.filter((l) => l.op !== "select" && (!table || l.table === table));
  }
  fail(table: string, op: string, error: DbError = { message: "boom" }, opts: { times?: number; when?: Failure["when"] } = {}) {
    this.failures.push({ table, op, error, ...(opts.times === undefined ? {} : { times: opts.times }), ...(opts.when ? { when: opts.when } : {}) });
  }
  nextId(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }
  tick(): string {
    this.seq += 1;
    return new Date(Date.UTC(2026, 9, 15, 0, 0, 0, 0) + this.seq * 1000).toISOString();
  }
  takeFailure(table: string, op: string, filters: [string, string, unknown][]): DbError | null {
    const f = this.failures.find((x) => x.table === table && x.op === op && (x.times === undefined || x.times > 0) && (!x.when || x.when(filters)));
    if (!f) return null;
    if (f.times !== undefined) f.times -= 1;
    return f.error;
  }
}

const matches = (row: Row, [kind, col, val]: [string, string, unknown]): boolean => {
  const v = row[col];
  switch (kind) {
    case "eq":
      return v === val || (v == null && val == null);
    case "neq":
      return v !== val;
    case "in":
      return Array.isArray(val) && val.includes(v);
    case "is":
      return val === null ? v == null : v === val;
    case "ilike":
      return typeof v === "string" && new RegExp(`^${String(val).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i").test(v);
    case "gt":
      return (v as number) > (val as number);
    case "lt":
      return (v as number) < (val as number);
    default:
      return false;
  }
};

class Query implements PromiseLike<unknown> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: unknown;
  private filters: [string, string, unknown][] = [];
  private orders: [string, boolean][] = [];
  private limitN: number | null = null;
  private rangeN: [number, number] | null = null;
  private columns = "";
  private head = false;
  private returning = false;
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private mode: "many" | "maybe" | "single" = "many";

  private db: MemDb;
  private table: string;
  constructor(db: MemDb, table: string) {
    this.db = db;
    this.table = table;
  }

  select(cols?: string, opts?: { head?: boolean }) {
    if (this.op === "select") this.columns = cols ?? "";
    else this.returning = true;
    this.head = opts?.head === true;
    return this;
  }
  insert(p: unknown) {
    this.op = "insert";
    this.payload = p;
    return this;
  }
  update(p: unknown) {
    this.op = "update";
    this.payload = p;
    return this;
  }
  upsert(p: unknown, opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = "upsert";
    this.payload = p;
    this.upsertOpts = opts;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(c: string, v: unknown) { return this.f("eq", c, v); }
  neq(c: string, v: unknown) { return this.f("neq", c, v); }
  in(c: string, v: unknown) { return this.f("in", c, v); }
  is(c: string, v: unknown) { return this.f("is", c, v); }
  ilike(c: string, v: unknown) { return this.f("ilike", c, v); }
  gt(c: string, v: unknown) { return this.f("gt", c, v); }
  lt(c: string, v: unknown) { return this.f("lt", c, v); }
  private f(kind: string, c: string, v: unknown) {
    this.filters.push([kind, c, v]);
    return this;
  }
  order(c: string, opts?: { ascending?: boolean }) {
    this.orders.push([c, opts?.ascending !== false]);
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  range(a: number, b: number) {
    this.rangeN = [a, b];
    return this;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }
  then<A, B>(ok?: ((v: unknown) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return Promise.resolve().then(() => this.exec()).then(ok, bad);
  }

  private matching(): Row[] {
    return this.db.rows(this.table).filter((r) => this.filters.every((f) => matches(r, f)));
  }
  private violates(candidate: Row, ignore?: Row): boolean {
    return (UNIQUE[this.table] ?? []).some((cols) => cols.every((c) => candidate[c] != null) && this.db.rows(this.table).some((r) => r !== ignore && cols.every((c) => r[c] === candidate[c])));
  }
  private embed(row: Row): Row {
    const out = { ...row };
    for (const m of this.columns.matchAll(/(?:(\w+):)?(\w+)(?:!\w+)?\(([^)]*)\)/g)) {
      const [, alias, related] = m;
      const rel = RELATIONS[`${this.table}.${related}`];
      if (!related || !rel) continue;
      const hit = this.db.rows(related).find((r) => r[rel[1]] === row[rel[0]]);
      out[alias ?? related] = hit ? { ...hit } : null;
    }
    return out;
  }
  private shape(rows: Row[]): { data: unknown; error: DbError | null } {
    if (this.mode === "many") return { data: rows, error: null };
    if (rows.length === 0) return this.mode === "single" ? { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } } : { data: null, error: null };
    return { data: rows[0], error: null };
  }

  private exec(): { data: unknown; error: DbError | null; count?: number | null } {
    const db = this.db;
    db.log.push({ table: this.table, op: this.op, payload: this.payload, filters: [...this.filters] });
    const failure = db.takeFailure(this.table, this.op, this.filters);
    if (failure) return { data: null, error: failure, count: null };
    if (this.op === "select") {
      let rows = this.matching();
      for (const [col, asc] of [...this.orders].reverse()) rows = [...rows].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : String(a[col] ?? "") > String(b[col] ?? "") ? 1 : 0) * (asc ? 1 : -1));
      if (this.head) return { data: null, error: null, count: rows.length };
      if (this.rangeN) rows = rows.slice(this.rangeN[0], this.rangeN[1] + 1);
      if (this.limitN !== null) rows = rows.slice(0, this.limitN);
      return this.shape(rows.map((r) => this.embed(r)));
    }
    const finish = (rows: Row[]) => (this.returning || this.mode !== "many" ? this.shape(rows) : { data: null, error: null });
    if (this.op === "delete") {
      const gone = this.matching();
      db.tables[this.table] = db.rows(this.table).filter((r) => !gone.includes(r));
      return { data: null, error: null };
    }
    if (this.op === "update") {
      const rows = this.matching();
      const next = rows.map((r) => {
        const merged: Row = { ...r, ...(this.payload as Row), ...(TOUCHED.has(this.table) ? { updated_at: db.tick() } : {}) };
        if (GENERATED_KEY.has(this.table)) merged.name_key = String(merged.name ?? "").trim().toLowerCase();
        return merged;
      });
      for (const [i, r] of rows.entries()) if (this.violates(next[i] as Row, r)) return { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } };
      for (const [i, r] of rows.entries()) Object.assign(r, next[i]);
      return finish(rows);
    }
    const written: Row[] = [];
    for (const item of Array.isArray(this.payload) ? (this.payload as Row[]) : [this.payload as Row]) {
      const row: Row = { id: db.nextId(), created_at: db.tick(), ...item };
      if (GENERATED_KEY.has(this.table)) row.name_key = String(row.name ?? "").trim().toLowerCase();
      if (this.op === "upsert") {
        const cols = (this.upsertOpts.onConflict ?? "id").split(",");
        const existing = db.rows(this.table).find((r) => cols.every((c) => r[c] === row[c]));
        if (existing) {
          if (!this.upsertOpts.ignoreDuplicates) Object.assign(existing, item);
          written.push(existing);
          continue;
        }
      }
      if (this.violates(row)) return { data: null, error: { message: `duplicate key value violates unique constraint on ${this.table}`, code: "23505" } };
      db.rows(this.table).push(row);
      written.push(row);
    }
    return finish(written);
  }
}

export interface Who {
  claims: { sub: string; email: string } | null;
  admin?: boolean;
}

/** A client over `db`. `who` decides what getClaims answers (null is signed out) and what is_platform_admin answers. */
export function memClient(db: MemDb, who: Who | null = null) {
  return {
    from: (table: string) => new Query(db, table),
    async rpc(name: string, args?: unknown) {
      if (name === "is_platform_admin") return { data: who?.admin === true, error: null };
      const fn = db.rpcs[name];
      return fn ? { data: fn(args), error: null } : { data: null, error: { message: `no rpc ${name}` } };
    },
    auth: {
      async getClaims() {
        return who?.claims ? { data: { claims: who.claims }, error: null } : { data: null, error: { name: "AuthSessionMissingError", message: "Auth session missing" } };
      },
    },
  } as never;
}
