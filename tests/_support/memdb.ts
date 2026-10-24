// The ONE stateful stand-in for a Supabase client (IMP-033, IMP-048). Rows live in memory; the PostgREST subset the source modules use behaves like the real thing: filters (eq, neq, gt, gte, lt, lte, in, is, not,
// like, ilike, contains, overlaps, or), dotted columns read through an embed, multi-key order, range and limit, upsert on a conflict key, unique keys, an embedded select read through the schema's foreign
// keys or a declared relation, rpcs scripted by name, storage, failures injected per (table, op), a database-trigger stand-in after every write, and (given the generated schema) a refusal of a table or
// column the database does not have, so a fixture typo fails instead of passing. tests/_support/fake-db.ts is the scripted, stateless sibling for call-shape tests.
import schemaJson from "./schema.json" with { type: "json" };

export type Row = Record<string, unknown>;
export type Op = "select" | "insert" | "update" | "upsert" | "delete";
export interface MemCall {
  table: string;
  op: Op;
  payload?: unknown;
  filters: [string, string, unknown][];
  /** The ordering the call asked for, in the order given: [column, ascending]. */
  orders: [string, boolean][];
}
export type Err = { message: string; code?: string } | null;
export type RpcFn = (args: Record<string, unknown>, db: MemDb) => { data?: unknown; error?: Err };
export interface Failure {
  table: string;
  op: Op;
  message: string;
  code?: string;
  /** How many matching calls fail; omitted means every one. */
  times?: number;
  /** Only a call satisfying this fails. */
  when?: (c: MemCall) => boolean;
}
export interface SchemaInfo {
  tables: Record<string, { columns: string[]; uuid?: string[]; defaults?: Record<string, unknown>; fks: { column: string; table: string; ref: string }[] }>;
}
export interface MemOptions {
  /** listed: a uuid id for the tables in WITH_ID only; seq: `<table>-<n>` for every insert; uuid: a uuid id and a created_at tick for every insert. */
  ids?: "listed" | "seq" | "uuid";
  unique?: Record<string, string[][]>;
  /** Tables whose `name_key` is the lower-cased trimmed `name`. */
  generatedKey?: readonly string[];
  /** Tables whose updated_at moves on every update. */
  touched?: readonly string[];
  /** `<table>.<related>`: [column on table, key on related], for an embedded select the schema does not describe. */
  relations?: Record<string, [string, string]>;
  /** Validate table and column names against the generated schema (default on). */
  schema?: SchemaInfo | null;
  /** The server's max_rows cut on every select, a ranged one included (PostgREST applies it to both; Supabase's default is 1000). `null` turns it off for a test that needs more rows than that. */
  cap?: number | null;
  /** Answer every write with the rows it touched (the shape the scripted-world tests were written against); default only when the call asks to return them. */
  returnRows?: boolean;
}

/** The ceiling rank migration 0090 gives each stored admissibility (the view derived_values_admissible). */
const CEILING_RANK: Record<string, number> = { display_only: 0, analysis_ok: 1, calculation_ok: 2, filing_ok: 3 };
const WITH_ID = new Set(["intelligence_items", "agent_run_searches", "section_claim_provenance", "claim_versions", "intelligence_item_sections", "item_timelines", "integrity_flags", "agent_runs", "staged_updates", "sources", "portal_link_candidates", "disposition_ledger", "item_cross_references", "item_forward_events", "vocabulary_terms", "monitoring_queue", "pending_first_fetch", "propagation_events"]);
export const SCHEMA: SchemaInfo = schemaJson as SchemaInfo;
const likeRe = (pat: string, flags = "") => new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[%*]/g, ".*")}$`, flags);
const col = (r: Row, c: string): unknown => (c.includes("->>") ? String(((r[c.split("->>")[0] as string] as Row | undefined) ?? {})[c.split("->>")[1] as string] ?? "") : c.includes(".") ? c.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Row)[k] : undefined), r) : r[c]);
const cmp = (a: unknown, b: unknown): number => (typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0);

/** record_host_worklist (migration 0064): one upsert that counts each call once, as the SQL does; its attacks are proven by the migration's own self-check. */
const recordHostWorklist: RpcFn = (a, d) => {
  const rows = d.rows("host_worklist");
  const name = typeof a.p_name === "string" && a.p_name.trim() ? a.p_name.trim() : null;
  const hit = rows.find((r) => r.host === a.p_host);
  if (hit) Object.assign(hit, { seen_count: Number(hit.seen_count) + 1, last_seen_at: d.now, reason: a.p_reason, last_name: name ?? hit.last_name ?? null });
  else rows.push({ host: a.p_host, reason: a.p_reason, first_seen_at: d.now, last_seen_at: d.now, seen_count: 1, last_name: name });
  return { data: Number((hit ?? rows[rows.length - 1])?.seen_count) };
};

/** The fields register_source_once (migration 0081) reads from its row object: a closed list, anything else is ignored. */
const SOURCE_BIRTH_FIELDS = ["name", "url", "base_tier", "tier_at_creation", "effective_tier", "status", "admin_only", "source_role", "description", "domains", "jurisdictions", "transport_modes", "access_method", "update_frequency", "intelligence_types", "vertical_tags", "topic_tags", "auto_run_enabled", "notes", "reuse_terms"];
/** register_source_once (migration 0081): the row for the key, or the one that already holds it; its attacks (two callers, two institutions on a host, a bad key, a duplicate key) are proven by the migration's own self-check. */
const registerSourceOnce: RpcFn = (a, d) => {
  const key = String(a.p_key ?? "");
  const row = (a.p_row ?? {}) as Row;
  const bad = (message: string) => ({ error: { message, code: "22023" } });
  if (!key.trim() || key !== key.toLowerCase()) return bad("register_source_once: the institution key must be a non-empty lower-case key");
  if (!row.url || row.base_tier == null) return bad("register_source_once: the row needs a url and a base_tier");
  const rows = d.rows("sources");
  const hit = rows.find((r) => r.institution_key === key);
  if (hit) return { data: [{ r_source_id: hit.id, r_created: false, r_status: hit.status }] };
  const defaults = Object.fromEntries(Object.entries(d.opts.schema?.tables.sources?.defaults ?? {}).map(([k, v]) => [k, v === "__now" ? d.now : Array.isArray(v) ? [] : v !== null && typeof v === "object" ? { ...(v as object) } : v]));
  const fresh: Row = { ...defaults, id: d.opts.ids === "seq" ? d.autoId("sources") : d.nextId() };
  for (const f of SOURCE_BIRTH_FIELDS) if (row[f] !== undefined) fresh[f] = row[f];
  for (const f of ["domains", "jurisdictions", "transport_modes", "intelligence_types", "vertical_tags", "topic_tags"]) fresh[f] ??= [];
  fresh.status ??= "active";
  fresh.access_method ??= "manual";
  fresh.update_frequency ??= "weekly";
  fresh.name = row.name ?? row.url;
  fresh.tier_at_creation = row.tier_at_creation ?? row.base_tier;
  fresh.institution_key = key;
  rows.push(fresh);
  return { data: [{ r_source_id: fresh.id, r_created: true, r_status: fresh.status ?? "active" }] };
};

export class MemDb {
  tables: Record<string, Row[]> = {};
  calls: MemCall[] = [];
  rpcs: Record<string, RpcFn> = { record_host_worklist: recordHostWorklist, register_source_once: registerSourceOnce };
  rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  /** An rpc refused by name (the page sweep): every call answers this error. */
  rpcFail = new Map<string, { message: string; code?: string }>();
  failWhen: ((c: MemCall) => string | null) | null = null;
  failures: Failure[] = [];
  /** A database-trigger stand-in: runs after every successful write. */
  afterWrite: ((c: MemCall, db: MemDb) => void) | null = null;
  now = "2026-10-15T12:00:00.000Z";
  objects = new Map<string, Uint8Array>();
  storageFail: string | null = null;
  readonly opts: Required<Pick<MemOptions, "ids">> & MemOptions;
  private seq = 0;
  private autoN = 0;

  constructor(opts: MemOptions = {}, seed: Record<string, Row[]> = {}) {
    this.opts = { ids: "listed", schema: SCHEMA, cap: 1000, ...opts };
    for (const [t, rows] of Object.entries(seed)) this.seed(t, rows);
  }
  seed(table: string, rows: Row[]): this {
    this.check(table);
    this.tables[table] ??= [];
    for (const r of rows) {
      this.checkColumns(table, r);
      // A row that was inserted has the column defaults the schema gives the columns it left out (a NOT NULL column with a default is never null): the constants only, not the clock.
      const constants = Object.fromEntries(Object.entries(this.opts.schema?.tables[table]?.defaults ?? {}).filter(([, v]) => v !== "__now" && v !== "__today").map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
      (this.tables[table] ??= []).push({ ...constants, ...(this.opts.ids === "listed" && WITH_ID.has(table) && r.id === undefined ? { id: this.nextId() } : {}), ...r });
    }
    return this;
  }
  /** Read-only relations computed from the tables (the SQL views): a read of the name answers the computed rows. */
  views: Record<string, () => Row[]> = {
    // derived_values_admissible (migration 0090): live lifecycles and not stale, with the ceiling rank of the stored admissibility.
    derived_values_admissible: () => this.rows("derived_values").filter((v) => !["falsified", "obsolete", "superseded"].includes(String(v.lifecycle)) && v.admissibility !== "stale").map((v) => ({ ...v, ceiling_rank: CEILING_RANK[String(v.admissibility)] ?? null })),
  };
  rows(table: string): Row[] {
    const view = this.views[table];
    return view ? view() : (this.tables[table] ??= []);
  }
  /** Every write call to a table (optionally one op). */
  writes(table?: string, op?: Op): MemCall[] {
    return this.calls.filter((c) => c.op !== "select" && (!table || c.table === table) && (!op || c.op === op));
  }
  reads(table?: string): MemCall[] {
    return this.calls.filter((c) => c.op === "select" && (!table || c.table === table));
  }
  fail(table: string, op: Op, message = "boom", o: { times?: number; code?: string; when?: Failure["when"] } = {}): this {
    this.failures.push({ table, op, message, ...(o.code ? { code: o.code } : {}), ...(o.times === undefined ? {} : { times: o.times }), ...(o.when ? { when: o.when } : {}) });
    return this;
  }
  /** The next `<table>-<n>` id of the seq style. */
  autoId(table: string): string {
    this.autoN += 1;
    return `${table}-${this.autoN}`;
  }
  nextId(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }
  tick(): string {
    this.seq += 1;
    return new Date(Date.UTC(2026, 9, 15, 0, 0, 0, 0) + this.seq * 1000).toISOString();
  }
  /** The next injected failure matching a call, consuming one use. */
  takeFailure(c: MemCall): Err {
    const f = this.failures.find((x) => x.table === c.table && x.op === c.op && (x.times === undefined || x.times > 0) && (!x.when || x.when(c)));
    if (!f) return null;
    if (f.times !== undefined) f.times -= 1;
    return { message: f.message, ...(f.code ? { code: f.code } : {}) };
  }
  get client(): never {
    return this as unknown as never;
  }
  /** A schema refusal for an unknown table, or null. */
  check(table: string): string | null {
    const s = this.opts.schema;
    if (s && !s.tables[table]) throw new Error(`memdb: relation "${table}" does not exist in the generated schema (a fixture or query typo)`);
    return null;
  }
  checkColumns(table: string, row: Row): void {
    const cols = this.opts.schema?.tables[table]?.columns;
    if (!cols) return;
    // A key holding an object is an embedded related row a fixture carries inline (what a PostgREST embed returns); only scalar keys are checked.
    for (const [k, v] of Object.entries(row)) if (!k.startsWith("__") && !cols.includes(k) && !(v !== null && typeof v === "object" && !Array.isArray(v))) throw new Error(`memdb: column "${k}" of relation "${table}" does not exist in the generated schema (a fixture or query typo)`);
  }
  from(table: string) {
    this.check(table);
    return new Query(this, table) as unknown;
  }
  async rpc(name: string, args: Record<string, unknown> = {}) {
    this.rpcCalls.push({ name, args });
    const refused = this.rpcFail.get(name);
    if (refused) return { data: null, error: refused };
    const fn = this.rpcs[name];
    if (!fn) return { data: null, error: { message: `rpc ${name} is not scripted` } };
    const r = fn(args, this);
    return { data: r.data ?? null, error: r.error ?? null };
  }
  auth = { getClaims: async () => ({ data: null, error: { message: "no session" } }) };
  storage = {
    from: (bucket: string) => ({
      upload: async (path: string, body: Uint8Array) => {
        if (this.storageFail) return { data: null, error: { message: this.storageFail } };
        this.objects.set(`${bucket}/${path}`, body);
        return { data: {}, error: null };
      },
      download: async (path: string) => {
        const body = this.objects.get(`${bucket}/${path}`);
        return body ? { data: new Blob([body as BlobPart]), error: null } : { data: null, error: { message: "no object" } };
      },
    }),
  };
}

class Query {
  private op: Op = "select";
  private payload: unknown;
  private filters: [string, string, unknown][] = [];
  private preds: ((r: Row) => boolean)[] = [];
  private orders: [string, boolean][] = [];
  private lim: number | null = null;
  private rng: [number, number] | null = null;
  private columns = "";
  private head = false;
  private count = false;
  private returning = false;
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private single_: "one" | "maybe" | null = null;
  private db: MemDb;
  private table: string;
  constructor(db: MemDb, table: string) {
    this.db = db;
    this.table = table;
    if (db.opts.cap) this.lim = db.opts.cap;
  }

  /** Every plain column a select list names must be a column of the table (an embed, a star, a cast and a json path are not checked). */
  private checkSelect(list: string): void {
    const known = this.db.opts.schema?.tables[this.table]?.columns;
    if (!known) return;
    let depth = 0;
    let token = "";
    const tokens: string[] = [];
    for (const ch of list) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        tokens.push(token);
        token = "";
      } else token += ch;
    }
    tokens.push(token);
    for (const raw of tokens) {
      const t = raw.trim();
      const bare = (t.includes(":") && !t.includes("::") ? t.split(":").slice(1).join(":") : t).trim();
      if (!bare || bare.includes("(") || bare.includes("*") || bare.includes("::") || bare.includes("->") || bare.includes(".") || bare.includes("!")) continue;
      if (!known.includes(bare)) throw new Error(`memdb: column "${bare}" of relation "${this.table}" does not exist in the generated schema (a select list names a column the table does not have)`);
    }
  }
  select(cols?: string, o?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      if (cols) this.checkSelect(cols);
      this.columns = cols ?? "";
      this.head = o?.head === true;
      this.count = o?.count !== undefined;
    } else this.returning = true;
    return this;
  }
  insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
  update(p: unknown) { this.op = "update"; this.payload = p; return this; }
  upsert(p: unknown, o?: { onConflict?: string; ignoreDuplicates?: boolean }) { this.op = "upsert"; this.payload = p; this.upsertOpts = o ?? {}; return this; }
  delete() { this.op = "delete"; return this; }
  private f(kind: string, c: string, val: unknown, pred: (r: Row) => boolean) {
    const cols = this.db.opts.schema?.tables[this.table]?.columns;
    const base = (c.split("->>")[0] as string).split(".")[0] as string;
    if (cols && kind !== "or" && !c.includes(".") && !cols.includes(base)) throw new Error(`memdb: column "${c}" of relation "${this.table}" does not exist in the generated schema (a fixture or query typo)`);
    this.filters.push([kind, c, val]);
    this.preds.push(pred);
    return this;
  }
  eq(c: string, v: unknown) {
    // supabase-js sends `col=eq.null`, which compares with the text "null" and matches no row: it is never IS NULL (conformance: scripts/ci/checks/memdb-conformance.mjs).
    if (v === null) throw new Error("memdb: .eq(\"" + c + "\", null) is `" + c + " = 'null'` on the database, not IS NULL: use .is(\"" + c + "\", null)");
    return this.f("eq", c, v, (r) => col(r, c) === v);
  }
  neq(c: string, v: unknown) {
    if (v === null) throw new Error("memdb: .neq(\"" + c + "\", null) is `" + c + " <> 'null'` on the database, not IS NOT NULL: use .not(\"" + c + "\", \"is\", null)");
    // SQL `<>` is unknown for a NULL column, so the row is not returned.
    return this.f("neq", c, v, (r) => col(r, c) != null && col(r, c) !== v);
  }
  gt(c: string, v: unknown) { return this.f("gt", c, v, (r) => col(r, c) != null && cmp(col(r, c), v) > 0); }
  gte(c: string, v: unknown) { return this.f("gte", c, v, (r) => col(r, c) != null && cmp(col(r, c), v) >= 0); }
  lt(c: string, v: unknown) { return this.f("lt", c, v, (r) => col(r, c) != null && cmp(col(r, c), v) < 0); }
  lte(c: string, v: unknown) { return this.f("lte", c, v, (r) => col(r, c) != null && cmp(col(r, c), v) <= 0); }
  in(c: string, v: unknown[]) { return this.f("in", c, v, (r) => col(r, c) != null && v.includes(col(r, c))); }
  is(c: string, v: unknown) { return this.f("is", c, v, (r) => (v === null ? col(r, c) == null : col(r, c) === v)); }
  not(c: string, op: string, v: unknown) { return this.f(`not.${op}`, c, v, (r) => (op === "is" ? !(v === null ? col(r, c) == null : col(r, c) === v) : op === "in" ? !String(v).replace(/[()]/g, "").split(",").includes(String(col(r, c))) : col(r, c) !== v)); }
  like(c: string, pat: string) { return this.f("like", c, pat, (r) => likeRe(pat).test(String(col(r, c) ?? ""))); }
  ilike(c: string, pat: string) { return this.f("ilike", c, pat, (r) => likeRe(pat, "i").test(String(col(r, c) ?? ""))); }
  contains(c: string, v: unknown[]) { return this.f("contains", c, v, (r) => Array.isArray(col(r, c)) && v.every((x) => (col(r, c) as unknown[]).includes(x))); }
  overlaps(c: string, v: unknown[]) { return this.f("overlaps", c, v, (r) => Array.isArray(col(r, c)) && (col(r, c) as unknown[]).some((x) => v.includes(x))); }
  or(expr: string) {
    const tests = expr.split(/,(?=[a-z_.]+\.(?:eq|neq|is|ilike|like|lt|lte|gt|gte)\.)/).map((p) => {
      const m = /^([a-z_.]+)\.(eq|neq|is|ilike|like|lt|lte|gt|gte)\.(.*)$/.exec(p);
      return (r: Row): boolean => {
        if (!m) return false;
        const [, c = "", kind = "", v = ""] = m;
        const x = col(r, c);
        if (kind === "is") return v === "null" ? x == null : String(x) === v;
        if (kind === "ilike") return likeRe(v, "i").test(String(x ?? ""));
        if (kind === "like") return likeRe(v).test(String(x ?? ""));
        if (kind === "neq") return x != null && String(x) !== v;
        if (kind === "eq") return String(x) === v;
        if (x == null) return false;
        return kind === "lt" ? cmp(x, v) < 0 : kind === "lte" ? cmp(x, v) <= 0 : kind === "gt" ? cmp(x, v) > 0 : cmp(x, v) >= 0;
      };
    });
    this.filters.push(["or", "or", expr]);
    this.preds.push((r) => tests.some((t) => t(r)));
    return this;
  }
  order(c: string, o?: { ascending?: boolean }) { this.orders.push([c, o?.ascending !== false]); return this; }
  limit(n: number) { this.lim = this.db.opts.cap ? Math.min(n, this.db.opts.cap) : n; return this; }
  range(a: number, b: number) { this.rng = [a, b]; this.lim = this.db.opts.cap ?? null; return this; }
  maybeSingle() { this.single_ = "maybe"; return this; }
  single() { this.single_ = "one"; return this; }
  then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
    return Promise.resolve().then(() => this.run()).then(resolve, reject);
  }

  private run(): { data: unknown; error: Err; count: number | null } {
    const call: MemCall = { table: this.table, op: this.op, payload: this.payload, filters: this.filters, orders: this.orders };
    this.db.calls.push(call);
    const message = this.db.failWhen?.(call);
    if (message) return { data: null, error: { message }, count: null };
    const injected = this.db.takeFailure(call);
    if (injected) return { data: null, error: injected, count: null };
    const result = this.exec();
    if (call.op !== "select" && !result.error) this.db.afterWrite?.(call, this.db);
    return result;
  }

  private embed(row: Row): Row {
    const out = { ...row };
    for (const m of this.columns.matchAll(/(?:(\w+):)?(\w+)(?:!\w+)?\(([^()]*)\)/g)) {
      const [, alias, related] = m;
      if (!related || out[alias ?? related] !== undefined) continue; // an embedded row the fixture carries inline stands
      const rel = this.db.opts.relations?.[`${this.table}.${related}`];
      const fk = this.db.opts.schema?.tables[this.table]?.fks.find((f) => f.table === related);
      const back = this.db.opts.schema?.tables[related]?.fks.find((f) => f.table === this.table);
      if (rel) out[alias ?? related] = this.db.rows(related).find((r) => r[rel[1]] === row[rel[0]]) ?? null;
      else if (fk) out[alias ?? related] = this.db.rows(related).find((r) => r[fk.ref] === row[fk.column]) ?? null;
      else if (back) out[alias ?? related] = this.db.rows(related).filter((r) => r[back.column] === row[back.ref]);
    }
    return out;
  }
  private violates(candidate: Row, ignore?: Row): boolean {
    return (this.db.opts.unique?.[this.table] ?? []).some((cols) => cols.every((c) => candidate[c] != null) && this.db.rows(this.table).some((r) => r !== ignore && cols.every((c) => r[c] === candidate[c])));
  }
  private newRow(item: Row): Row {
    const ids = this.db.opts.ids;
    const base: Row = ids === "seq" ? { id: this.db.autoId(this.table) } : ids === "uuid" ? { id: this.db.nextId(), created_at: this.db.tick() } : WITH_ID.has(this.table) ? { id: this.db.nextId() } : {};
    // The database fills a uuid default for a column the insert left out.
    for (const c of this.db.opts.schema?.tables[this.table]?.uuid ?? []) if (item[c] === undefined && base[c] === undefined) base[c] = this.db.nextId();
    const defaults = Object.fromEntries(Object.entries(this.db.opts.schema?.tables[this.table]?.defaults ?? {}).map(([k, v]) => [k, v === "__now" ? this.db.now : v === "__today" ? this.db.now.slice(0, 10) : Array.isArray(v) ? [] : v !== null && typeof v === "object" ? {} : v]));
    const row: Row = { ...defaults, ...base, ...(this.table === "agent_runs" && item.created_at === undefined ? { created_at: this.db.now } : {}), ...item };
    if (this.db.opts.generatedKey?.includes(this.table)) row.name_key = String(row.name ?? "").trim().toLowerCase();
    return row;
  }

  private exec(): { data: unknown; error: Err; count: number | null } {
    const db = this.db;
    const rows = db.rows(this.table);
    const matching = () => rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op !== "select") for (const item of Array.isArray(this.payload) ? (this.payload as Row[]) : [this.payload as Row]) if (item && typeof item === "object") db.checkColumns(this.table, item);
    let out: Row[] = [];
    if (this.op === "insert" || this.op === "upsert") {
      for (const p of Array.isArray(this.payload) ? (this.payload as Row[]) : [this.payload as Row]) {
        const keys = this.upsertOpts.onConflict?.split(",").map((k) => k.trim());
        const hit = this.op === "upsert" ? rows.find((r) => (keys ?? ["id"]).every((k) => r[k] === p[k])) : undefined;
        if (hit) {
          if (!this.upsertOpts.ignoreDuplicates) Object.assign(hit, p);
          out.push(hit);
          continue;
        }
        const row = this.newRow(p);
        if (this.violates(row)) return { data: null, error: { message: `duplicate key value violates unique constraint on ${this.table}`, code: "23505" }, count: null };
        rows.push(row);
        out.push(row);
      }
      if (!this.returning && !this.single_ && !db.opts.returnRows) return { data: null, error: null, count: null };
    } else if (this.op === "update") {
      out = matching();
      const next = out.map((r) => {
        const merged: Row = { ...r, ...(this.payload as Row), ...(db.opts.touched?.includes(this.table) ? { updated_at: db.tick() } : {}) };
        if (db.opts.generatedKey?.includes(this.table)) merged.name_key = String(merged.name ?? "").trim().toLowerCase();
        return merged;
      });
      for (const [i, r] of out.entries()) if (this.violates(next[i] as Row, r)) return { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" }, count: null };
      for (const [i, r] of out.entries()) Object.assign(r, next[i]);
      if (!this.returning && !this.single_ && !db.opts.returnRows) return { data: null, error: null, count: null };
    } else if (this.op === "delete") {
      const gone = new Set(matching());
      db.tables[this.table] = rows.filter((r) => !gone.has(r));
      return { data: this.returning || db.opts.returnRows ? [...gone].map((r) => ({ ...r })) : null, error: null, count: null };
    } else {
      // A select that embeds resolves the join BEFORE it filters, the way PostgREST does, so a filter on `embed.column` sees the related row; `!inner` drops a row with no related row.
      const inner = [...this.columns.matchAll(/(?:(\w+):)?(\w+)!inner\(/g)].map((m) => m[1] ?? m[2] ?? "");
      out = /\(/.test(this.columns) ? rows.map((r) => this.embed({ ...r })).filter((r) => this.preds.every((p) => p(r)) && inner.every((a) => r[a] != null)) : matching();
      const total = out.length;
      for (const [c, asc] of [...this.orders].reverse()) out = [...out].sort((a, b) => cmp(col(a, c), col(b, c)) * (asc ? 1 : -1));
      if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim !== null) out = out.slice(0, this.lim);
      if (this.head) return { data: null, error: null, count: total };
      out = out.map((r) => this.embed({ ...r }));
      if (this.count) return { data: out, error: null, count: total };
    }
    if (this.op !== "select") out = out.map((r) => ({ ...r }));
    if (this.single_) {
      if (out.length > 1) return { data: null, error: { message: "multiple rows returned" }, count: null };
      if (!out.length) return this.single_ === "one" ? { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" }, count: null } : { data: null, error: null, count: null };
      return { data: out[0], error: null, count: null };
    }
    return { data: out, error: null, count: null };
  }
}

/** The rpcs the propagation core calls, behaving like the database's for the rows a test holds: invalidate_dependents marks dependents stale, register_derived_value supersedes, fire_signpost stamps and moves the lifecycle. */
export function installPropagationRpcs(db: MemDb): MemDb {
  let n = 0;
  db.rpcs.invalidate_dependents = (a, d) => {
    const edges = d.rows("derivation_edges").filter((e) => e.from_table === a.p_table && e.from_pk === a.p_pk && e.to_table === "derived_values");
    const hit = d.rows("derived_values").filter((v) => edges.some((e) => e.to_value_id === v.value_id) && v.admissibility !== "stale" && !d.rows("derived_values").some((n) => n.supersedes === v.value_id));
    if (a.p_apply) for (const v of hit) Object.assign(v, { admissibility: "stale", invalidated_by_event: a.p_event });
    return { data: hit.length };
  };
  db.rpcs.register_derived_value = (a, d) => {
    const id = `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`;
    d.rows("derived_values").push({ value_id: id, method_id: a.p_method_id, method_version: a.p_method_version, value: a.p_value, value_low: a.p_value_low, value_high: a.p_value_high, unit: a.p_unit, currency: a.p_currency, derivation: a.p_derivation, origin_class: a.p_origin_class, lifecycle: a.p_lifecycle, admissibility: a.p_admissibility, base_confidence: a.p_base_confidence, asserted_at: a.p_asserted_at, supersedes: a.p_supersedes, inputs: a.p_inputs, entity_id: a.p_entity_id, computed_by: a.p_computed_by });
    for (const ref of (a.p_inputs ?? []) as { table: string; pk: string }[]) d.rows("derivation_edges").push({ from_table: ref.table, from_pk: ref.pk, to_table: "derived_values", to_value_id: id });
    return { data: id };
  };
  /** author_derived_value (migration 0091): one call checks for a value of the method with an edge from any input and registers otherwise; the database serialises two callers with an advisory lock. */
  db.rpcs.author_derived_value = (a, d) => {
    const inputs = (a.p_inputs ?? []) as { table: string; pk: string }[];
    if (!Array.isArray(a.p_inputs) || inputs.length === 0) return { error: { message: "author_derived_value: inputs must name at least one input", code: "22023" } };
    const have = d.rows("derived_values").find((v) => v.method_id === a.p_method_id && v.method_version === a.p_method_version && d.rows("derivation_edges").some((e) => e.to_value_id === v.value_id && inputs.some((i) => i.table === e.from_table && i.pk === e.from_pk)));
    if (have) return { data: [{ value_id: have.value_id, authored: false }] };
    const made = d.rpcs.register_derived_value!({ ...a, p_supersedes: null }, d);
    return { data: [{ value_id: made.data, authored: true }] };
  };
  db.rpcs.fire_signpost = (a, d) => {
    const sp = d.rows("signposts").find((s) => s.entity_id === a.p_entity_id);
    if (!sp) return { error: { message: "signpost not found" } };
    const first = sp.fired_at == null;
    sp.fired_at ??= a.p_at;
    return { data: { fired: true, first_firing: first, signpost_entity_id: sp.entity_id, previous_lifecycle_state: "emerging", new_lifecycle_state: "strengthening" } };
  };
  return db;
}

/** next_uncensused_portal_candidates: the ledger's candidates the census does not already hold, in (first_seen_at, id) order, a keyset page, with their source's name, category and tier. */
export function installPortalLedgerRpc(db: MemDb): MemDb {
  db.rpcs.next_uncensused_portal_candidates = (a, d) => {
    const census = new Set(d.rows("census_worklist").map((r) => r.document_url));
    const after = a.p_after_first_seen ? [String(a.p_after_first_seen), String(a.p_after_id)] : null;
    const key = (r: Row) => [String(r.first_seen_at ?? ""), String(r.id)] as const;
    let rows = d.rows("portal_link_candidates").filter((r) => (r.status ?? "candidate") === "candidate" && !census.has(r.url) && (!a.p_source_id || r.source_id === a.p_source_id));
    rows = rows.sort((x, y) => (key(x)[0] === key(y)[0] ? key(x)[1].localeCompare(key(y)[1]) : key(x)[0].localeCompare(key(y)[0])) * (a.p_newest ? -1 : 1));
    if (after) rows = rows.filter((r) => (a.p_newest ? key(r)[0] < after[0]! || (key(r)[0] === after[0] && key(r)[1] < after[1]!) : key(r)[0] > after[0]! || (key(r)[0] === after[0] && key(r)[1] > after[1]!)));
    return { data: rows.slice(0, Number(a.p_limit)).map((r) => { const s = d.rows("sources").find((x) => x.id === r.source_id); return { ...r, source_name: s?.name ?? null, source_category: s?.category ?? null, source_base_tier: s?.base_tier ?? null }; }) };
  };
  return db;
}
