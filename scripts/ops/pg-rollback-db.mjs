// A Db (the supabase-js builder subset the app uses) over ONE pg connection inside a transaction, for a proof that must run the real code against production and then ROLLBACK (PostgREST has no transaction). Every statement runs under a savepoint, so a refused write (a trigger, a constraint) is an {error} like PostgREST's, never an aborted transaction. A proof tool, not product code.
import pg from "pg";

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;
export async function connect(url) {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

export function makeDb(client, log = []) {
  const fkCache = [];
  let sp = 0;
  // ONE connection: the app issues reads in parallel (Promise.all), so every statement, its savepoint included, goes through one queue.
  let chain = Promise.resolve();
  const serial = (fn) => { const next = chain.then(fn, fn); chain = next.then(() => undefined, () => undefined); return next; };
  async function pk(table) {
    const r = await serial(() => client.query("select a.attname from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey) where i.indrelid=('public.'||quote_ident($1))::regclass and i.indisprimary", [table]));
    return r.rows.map((x) => x.attname);
  }
  async function fks() {
    if (!fkCache.length) {
      const r = await serial(() => client.query(`select c.conname, c.conrelid::regclass::text as t, c.confrelid::regclass::text as rt,
        (select array_agg(a.attname order by k.ord) from unnest(c.conkey) with ordinality k(n,ord) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.n) as cols,
        (select array_agg(a.attname order by k.ord) from unnest(c.confkey) with ordinality k(n,ord) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.n) as rcols
        from pg_constraint c where c.contype='f' and c.connamespace='public'::regnamespace`));
      for (const x of r.rows) fkCache.push({ ...x, t: x.t.replace(/^public\./, "").replace(/"/g, ""), rt: x.rt.replace(/^public\./, "").replace(/"/g, "") });
    }
    return fkCache;
  }
  function run(sql, params = []) {
    return serial(() => runOne(sql, params));
  }
  async function runOne(sql, params) {
    const name = `s${++sp}`;
    await client.query(`SAVEPOINT ${name}`);
    try {
      const r = await client.query(sql, params);
      await client.query(`RELEASE SAVEPOINT ${name}`);
      return { ok: true, r };
    } catch (e) {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return { ok: false, error: { message: e.message, code: e.code, details: e.detail ?? null, hint: e.hint ?? null } };
    }
  }
  function splitTop(s) {
    const out = [];
    let d = 0, cur = "";
    for (const ch of s) {
      if (ch === "(") d++;
      if (ch === ")") d--;
      if (ch === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  async function selectList(table, alias, spec, counter) {
    const items = [];
    const inner = [];
    for (const p of splitTop(spec || "*")) {
      const m = /^(?:([A-Za-z_]\w*):)?([A-Za-z_]\w*)(!([A-Za-z_]\w*))?\s*\((.*)\)$/s.exec(p);
      if (!m) {
        items.push(p === "*" ? `${alias}.*` : p.includes(":") ? `${alias}.${q(p.split(":")[1].trim())} as ${q(p.split(":")[0].trim())}` : `${alias}.${q(p)}`);
        continue;
      }
      const [, al, target, , hint, sub] = m;
      const hintInner = hint === "inner";
      const hintCol = hint && hint !== "inner" ? hint : null;
      const all = await fks();
      const toOne = all.filter((f) => f.t === table && f.rt === target && (!hintCol || f.cols.includes(hintCol) || f.conname === hintCol));
      const toMany = all.filter((f) => f.t === target && f.rt === table && (!hintCol || f.cols.includes(hintCol) || f.conname === hintCol));
      const e = `e${++counter.n}`;
      let sql;
      let isMany = false;
      if (toOne.length >= 1) {
        const f = toOne[0];
        const inside = await selectList(target, e, sub, counter);
        sql = `(select to_jsonb(x) from (select ${inside.items.join(", ")} from ${q(target)} ${e} where ${f.cols.map((c, i) => `${e}.${q(f.rcols[i])} = ${alias}.${q(c)}`).join(" and ")}${inside.inner.length ? " and " + inside.inner.join(" and ") : ""}) x)`;
      } else if (toMany.length >= 1) {
        isMany = true;
        const f = toMany[0];
        const inside = await selectList(target, e, sub, counter);
        sql = `coalesce((select jsonb_agg(to_jsonb(x)) from (select ${inside.items.join(", ")} from ${q(target)} ${e} where ${f.cols.map((c, i) => `${e}.${q(c)} = ${alias}.${q(f.rcols[i])}`).join(" and ")}${inside.inner.length ? " and " + inside.inner.join(" and ") : ""}) x), '[]'::jsonb)`;
      } else throw new Error(`pgdb: no foreign key between ${table} and ${target}`);
      items.push(`${sql} as ${q(al ?? target)}`);
      if (hintInner) inner.push(isMany ? `jsonb_array_length(${sql}) > 0` : `${sql} is not null`);
    }
    return { items, inner };
  }
  const OPS = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "like", ilike: "ilike" };
  function orClause(expr, params, a) {
    return "(" + splitTop(expr).map((p) => {
      const m = /^(\w+)\.(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.(.*)$/s.exec(p);
      if (!m) throw new Error(`pgdb: or() term ${p}`);
      return one(m[1], m[3], m[4], !!m[2], params, a);
    }).join(" or ") + ")";
  }
  function one(col, op, val, neg, params, a) {
    const c = `${a}.${q(col)}`;
    let s;
    if (op === "is") s = `${c} is ${val === null || val === "null" ? "null" : val === true || val === "true" ? "true" : "false"}`;
    else if (op === "in") {
      const list = Array.isArray(val) ? val : String(val).replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
      params.push(list);
      s = `${c} = any($${params.length})`;
    } else if (op === "contains" || op === "cs") {
      params.push(typeof val === "object" && !Array.isArray(val) ? JSON.stringify(val) : val);
      s = `${c} @> $${params.length}`;
    } else if (op === "overlaps" || op === "ov") {
      params.push(val);
      s = `${c} && $${params.length}`;
    } else {
      params.push(val);
      s = `${c} ${OPS[op]} $${params.length}`;
    }
    return neg ? `not (${s})` : s;
  }

  class Q {
    constructor(table) { this.table = table; this.op = "select"; this.sel = "*"; this.f = []; this.ord = []; this.lim = null; this.rng = null; this.ret = false; this.cnt = null; this.head = false; this.one = null; this.payload = null; this.conflict = null; this.ignoreDup = false; }
    select(c = "*", o = {}) { this.sel = c; if (this.op !== "select") this.ret = true; if (o.count) this.cnt = o.count; if (o.head) this.head = true; return this; }
    insert(p) { this.op = "insert"; this.payload = p; return this; }
    upsert(p, o = {}) { this.op = "upsert"; this.payload = p; this.conflict = o.onConflict ?? null; this.ignoreDup = !!o.ignoreDuplicates; return this; }
    update(p) { this.op = "update"; this.payload = p; return this; }
    delete() { this.op = "delete"; return this; }
    eq(c, v) { this.f.push(["eq", c, v]); return this; }
    neq(c, v) { this.f.push(["neq", c, v]); return this; }
    gt(c, v) { this.f.push(["gt", c, v]); return this; }
    gte(c, v) { this.f.push(["gte", c, v]); return this; }
    lt(c, v) { this.f.push(["lt", c, v]); return this; }
    lte(c, v) { this.f.push(["lte", c, v]); return this; }
    like(c, v) { this.f.push(["like", c, v]); return this; }
    ilike(c, v) { this.f.push(["ilike", c, v]); return this; }
    is(c, v) { this.f.push(["is", c, v]); return this; }
    in(c, v) { this.f.push(["in", c, v]); return this; }
    contains(c, v) { this.f.push(["contains", c, v]); return this; }
    overlaps(c, v) { this.f.push(["overlaps", c, v]); return this; }
    match(o) { for (const [k, v] of Object.entries(o)) this.f.push(["eq", k, v]); return this; }
    not(c, op, v) { this.f.push(["not", c, v, op]); return this; }
    or(e) { this.f.push(["or", e]); return this; }
    filter(c, op, v) { this.f.push([op, c, v]); return this; }
    order(c, o = {}) { this.ord.push([c, o.ascending === false ? "desc" : "asc", o.nullsFirst === true ? "nulls first" : o.nullsFirst === false ? "nulls last" : ""]); return this; }
    limit(n) { this.lim = n; return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    single() { this.one = "single"; return this; }
    maybeSingle() { this.one = "maybe"; return this; }
    returns() { return this; }
    abortSignal() { return this; }
    then(res, rej) { return this.exec().then(res, rej); }
    where(params, a) {
      return this.f.map((f) => (f[0] === "or" ? orClause(f[1], params, a) : f[0] === "not" ? one(f[1], f[3], f[2], true, params, a) : one(f[1], f[0], f[2], false, params, a)));
    }
    async exec() {
      try { return await this.exec_(); } catch (e) { return { data: null, error: { message: e.message, code: "PGDB" }, count: null, status: 500 }; }
    }
    async exec_() {
      const t = this.table;
      const params = [];
      log.push(`${this.op} ${t}`);
      if (this.op === "select") {
        const sl = await selectList(t, "b", this.sel, { n: 0 });
        const w = [...this.where(params, "b"), ...sl.inner];
        const where = w.length ? " where " + w.join(" and ") : "";
        const ord = this.ord.length ? " order by " + this.ord.map(([c, d, n]) => `b.${q(c)} ${d} ${n}`).join(", ") : "";
        let lim = "";
        if (this.rng) lim = ` limit ${this.rng[1] - this.rng[0] + 1} offset ${this.rng[0]}`;
        else if (this.lim != null) lim = ` limit ${this.lim}`;
        let count = null;
        if (this.cnt) {
          const cr = await run(`select count(*)::int as n from ${q(t)} b${where}`, params);
          if (!cr.ok) return { data: null, error: cr.error, count: null };
          count = cr.r.rows[0].n;
          if (this.head) return { data: null, error: null, count };
        }
        const r = await run(`select to_jsonb(x) as j from (select ${sl.items.join(", ")} from ${q(t)} b${where}${ord}${lim}) x`, params);
        if (!r.ok) return { data: null, error: r.error, count: null };
        return this.shape(r.r.rows.map((x) => x.j), count, false);
      }
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
      if (this.op === "delete") {
        const w = this.where(params, "b");
        const r = await run(`delete from ${q(t)} b${w.length ? " where " + w.join(" and ") : ""} returning to_jsonb(b) as j`, params);
        return r.ok ? this.shape(r.r.rows.map((x) => x.j), null, true) : { data: null, error: r.error, count: null };
      }
      if (this.op === "update") {
        params.push(JSON.stringify(this.payload));
        const set = Object.keys(this.payload).map((k) => `${q(k)} = (jsonb_populate_record(null::${q(t)}, $1::jsonb)).${q(k)}`).join(", ");
        const w = this.where(params, "b");
        const r = await run(`update ${q(t)} b set ${set}${w.length ? " where " + w.join(" and ") : ""} returning to_jsonb(b) as j`, params);
        return r.ok ? this.shape(r.r.rows.map((x) => x.j), null, true) : { data: null, error: r.error, count: null };
      }
      if (!rows.length) return { data: [], error: null, count: null };
      const keys = [...new Set(rows.flatMap((x) => Object.keys(x)))];
      params.push(JSON.stringify(rows));
      let sql = `insert into ${q(t)} (${keys.map(q).join(", ")}) select ${keys.map(q).join(", ")} from jsonb_populate_recordset(null::${q(t)}, $1::jsonb)`;
      if (this.op === "upsert") {
        const conf = this.conflict ? this.conflict.split(",").map((x) => x.trim()) : await pk(t);
        const upd = keys.filter((k) => !conf.includes(k));
        sql += ` on conflict (${conf.map(q).join(", ")}) ` + (this.ignoreDup || !upd.length ? "do nothing" : `do update set ${upd.map((k) => `${q(k)} = excluded.${q(k)}`).join(", ")}`);
      }
      sql += ` returning to_jsonb(${q(t)}) as j`;
      const r = await run(sql, params);
      return r.ok ? this.shape(r.r.rows.map((x) => x.j), null, true) : { data: null, error: r.error, count: null };
    }
    shape(out, count, write) {
      if (write && !this.ret) return { data: null, error: null, count, status: 201 };
      if (this.one) {
        if (out.length > 1 || (this.one === "single" && out.length === 0)) return { data: null, error: { message: `JSON object requested, multiple (or no) rows returned (${out.length})`, code: "PGRST116" }, count };
        return { data: out[0] ?? null, error: null, count };
      }
      return { data: out, error: null, count };
    }
  }
  return {
    from: (t) => new Q(t),
    async rpc(name, args = {}) {
      const keys = Object.keys(args);
      // a json argument (an object, or an array of objects) is sent as json text; an array of scalars stays an array (text[], uuid[])
      const isJson = (v) => v !== null && typeof v === "object" && (!Array.isArray(v) || v.some((x) => x !== null && typeof x === "object"));
      const params = keys.map((k) => (isJson(args[k]) ? JSON.stringify(args[k]) : args[k]));
      const r = await run(`select * from public.${q(name)}(${keys.map((k, i) => `${q(k)} => $${i + 1}`).join(", ")})`, params);
      if (!r.ok) return { data: null, error: r.error };
      const rows = r.r.rows;
      const scalar = rows.length === 1 && r.r.fields.length === 1 && r.r.fields[0].name === name;
      return { data: scalar ? rows[0][name] : rows, error: null };
    },
  };
}
