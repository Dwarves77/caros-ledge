// The CI database's roles, role settings, schema ACLs and platform default privileges, generated from the "shape" of scripts/ci/data/production-shape.json (read from production by scripts/cutover/read-production-shape.mjs
// with scripts/ci/data/production-shape.sql). Everything here is a pure function from the shape to SQL, so tests/ci/schema.test.mjs tries it without a database; scripts/ci/schema/base.mjs runs the SQL as the bootstrap superuser.
// After the whole chain has run, `shapeProblems` asks the CI database the same question production was asked and lists every difference: a role, a setting, an ACL or a default privilege that production has and CI lacks (or
// the reverse) is a red run, so CI cannot drift from the platform it stands in for.
const ident = (x) => `"${String(x).replace(/"/g, '""')}"`;
const literal = (x) => `'${String(x).replace(/'/g, "''")}'`;

/** An aclitem[] as text ("{a=arwdDxt/b,=U/c}") parsed to [{ grantee, privileges: [{ letter, grantOption }], grantor }]; the empty grantee is PUBLIC. */
export function parseAcl(text) {
  if (!text) return [];
  return text
    .replace(/^\{|\}$/g, "")
    .split(",")
    .filter(Boolean)
    .map((item) => {
      const m = /^(.*)=([a-zA-Z*]*)\/(.*)$/.exec(item.replace(/"/g, ""));
      if (!m) throw new Error(`unreadable aclitem ${item}`);
      const privileges = [...m[2].matchAll(/([a-zA-Z])(\*?)/g)].map((p) => ({ letter: p[1], grantOption: p[2] === "*" }));
      return { grantee: m[1] || "PUBLIC", privileges, grantor: m[3] };
    });
}

const PRIVILEGE_NAMES = {
  schema: { U: "USAGE", C: "CREATE" },
  table: { a: "INSERT", r: "SELECT", w: "UPDATE", d: "DELETE", D: "TRUNCATE", x: "REFERENCES", t: "TRIGGER" },
  sequence: { r: "SELECT", w: "UPDATE", U: "USAGE" },
  function: { X: "EXECUTE" },
};
const OBJECT_KIND = { r: "table", S: "sequence", f: "function" };
const DEFAULT_TARGET = { r: "TABLES", S: "SEQUENCES", f: "FUNCTIONS" };

/** `GRANT ... TO grantee` statements (one per grant-option class) for one aclitem; `target(privileges)` builds the text up to ` TO`. */
function grantsOf(entry, kind, target) {
  const names = PRIVILEGE_NAMES[kind];
  const out = [];
  for (const withOption of [false, true]) {
    const list = entry.privileges.filter((p) => p.grantOption === withOption).map((p) => names[p.letter]);
    if (list.length) out.push(`GRANT ${list.join(", ")} ${target} TO ${entry.grantee === "PUBLIC" ? "PUBLIC" : ident(entry.grantee)}${withOption ? " WITH GRANT OPTION" : ""};`);
  }
  return out;
}

/** CREATE or ALTER every role of the shape to its attributes, and reset then apply its settings. Run as the bootstrap superuser; `skip` are roles created elsewhere (the connection role is renamed and re-created by prod-role.mjs). */
export function roleSql(shape, skip = []) {
  const out = [];
  for (const r of shape.roles) {
    if (skip.includes(r.name)) continue;
    const attrs = `${r.super ? "SUPERUSER" : "NOSUPERUSER"} ${r.inherit ? "INHERIT" : "NOINHERIT"} ${r.createrole ? "CREATEROLE" : "NOCREATEROLE"} ${r.createdb ? "CREATEDB" : "NOCREATEDB"} ${r.login ? "LOGIN" : "NOLOGIN"} ${r.replication ? "REPLICATION" : "NOREPLICATION"} ${r.bypassrls ? "BYPASSRLS" : "NOBYPASSRLS"} CONNECTION LIMIT ${r.connlimit}`;
    out.push(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(r.name)}) THEN CREATE ROLE ${ident(r.name)}; END IF; END $$;`, `ALTER ROLE ${ident(r.name)} WITH ${attrs};`);
  }
  for (const m of shape.memberships) out.push(`GRANT ${ident(m.role)} TO ${ident(m.member)};`);
  for (const r of shape.roles) out.push(`ALTER ROLE ${ident(r.name)} RESET ALL;`); // a previous run on this cluster may have left settings a changed shape no longer carries
  for (const s of shape.roleSettings) {
    for (const setting of s.settings) {
      const [key, ...rest] = setting.split("=");
      const value = rest.join("=");
      // search_path is a list: its value is SQL list syntax (`"$user", public`), and a quoted string would be ONE schema named `"$user", public`. Every other setting here is a plain string.
      out.push(`ALTER ROLE ${s.role === "*" ? "ALL" : ident(s.role)}${s.database === "*" ? "" : ` IN DATABASE ${ident(s.database)}`} SET ${ident(key)} TO ${key === "search_path" ? value : literal(value)};`);
    }
  }
  return out;
}

/** Create each platform schema except `public` (owner, then exactly the ACL of the shape). The shape's `acl` is a sorted list of aclitem texts. */
export function schemaSql(shape) {
  const out = [];
  const everyone = ["PUBLIC", ...shape.roles.map((r) => ident(r.name))];
  for (const s of shape.schemaAcls) {
    if (s.schema === "public") continue;
    out.push(`CREATE SCHEMA IF NOT EXISTS ${ident(s.schema)} AUTHORIZATION ${ident(s.owner)};`, `ALTER SCHEMA ${ident(s.schema)} OWNER TO ${ident(s.owner)};`);
    if (!s.acl) continue;
    out.push(`REVOKE ALL ON SCHEMA ${ident(s.schema)} FROM ${everyone.join(", ")};`);
    for (const item of s.acl) for (const entry of parseAcl(`{${item}}`)) out.push(...grantsOf(entry, "schema", `ON SCHEMA ${ident(s.schema)}`));
  }
  return out;
}

/** The default privileges the platform's own roles hold (an in-schema default lists its owner's own entry, which an explicit grant makes; the global default's owner entry is implicit) (every role but `postgres` in `public` and globally: those the migrations create, and the chain's end state is compared with them). */
export function defaultAclSql(shape) {
  const out = [];
  for (const d of shape.defaultAcls) {
    const platform = d.role !== "postgres" || (d.schema !== "public" && d.schema !== "*");
    if (!platform) continue;
    const kind = OBJECT_KIND[d.objtype];
    const scope = `FOR ROLE ${ident(d.role)}${d.schema === "*" ? "" : ` IN SCHEMA ${ident(d.schema)}`}`;
    out.push(`ALTER DEFAULT PRIVILEGES ${scope} REVOKE ALL ON ${DEFAULT_TARGET[d.objtype]} FROM ${["PUBLIC", ...parseAcl(`{${d.acl.join(",")}}`).map((e) => (e.grantee === "PUBLIC" ? null : ident(e.grantee))).filter(Boolean)].join(", ")};`);
    for (const item of d.acl) for (const entry of parseAcl(`{${item}}`)) if (entry.grantee !== d.role || d.schema !== "*") out.push(...grantsOf(entry, kind, `ON ${DEFAULT_TARGET[d.objtype]}`).map((g) => g.replace(/^GRANT /, `ALTER DEFAULT PRIVILEGES ${scope} GRANT `)));
  }
  return out;
}

/** auth.users with the columns production has, and the four auth functions with production's own definitions (the CI stub used to hand-write two columns and two of the functions). The columns that are NOT NULL besides `id` are booleans that default to false. */
export function authSql(shape) {
  const columns = shape.authUsers.map((c) => {
    if (c.column === "id") return `${ident("id")} uuid PRIMARY KEY DEFAULT gen_random_uuid()`;
    if (c.nullable) return `${ident(c.column)} ${c.type}`;
    if (c.type !== "boolean") throw new Error(`auth.users.${c.column} is NOT NULL ${c.type}: the stub knows a default only for booleans`);
    return `${ident(c.column)} boolean NOT NULL DEFAULT false`;
  });
  return [`CREATE TABLE IF NOT EXISTS auth.users (${columns.join(", ")});`, ...shape.authFunctions.map((f) => `${f.definition.trimEnd()};`)];
}

const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** Differences between two shape documents, one line each: `section: key: expected X, got Y`. Order-free where the database's order is not meaningful (every section is already sorted by the query). */
export function shapeDiff(expected, actual, names = { want: "production", have: "this database" }) {
  const out = [];
  const keyed = { roles: (x) => x.name, memberships: (x) => `${x.role}<-${x.member}`, roleSettings: (x) => `${x.role}@${x.database}`, schemaAcls: (x) => x.schema, defaultAcls: (x) => `${x.role}/${x.schema}/${x.objtype}`, authUsers: (x) => x.column, authFunctions: (x) => x.name };
  for (const [section, key] of Object.entries(keyed)) {
    const [want, have] = [new Map((expected[section] ?? []).map((x) => [key(x), canon(x)])), new Map((actual[section] ?? []).map((x) => [key(x), canon(x)]))];
    for (const [k, v] of want) if (!have.has(k)) out.push(`${section}: ${k}: ${names.want} has ${v}; ${names.have} has none`);
    for (const [k, v] of have) if (!want.has(k)) out.push(`${section}: ${k}: ${names.have} has ${v}; ${names.want} has none`);
    for (const [k, v] of want) if (have.has(k) && have.get(k) !== v) out.push(`${section}: ${k}: ${names.want} ${v}; ${names.have} ${have.get(k)}`);
  }
  if (canon(expected.serverSettings) !== canon(actual.serverSettings)) out.push(`serverSettings: ${names.want} ${canon(expected.serverSettings)}; ${names.have} ${canon(actual.serverSettings)}`);
  if ((expected.databaseOwner ?? null) !== (actual.databaseOwner ?? null)) out.push(`databaseOwner: ${names.want} ${expected.databaseOwner}; ${names.have} ${actual.databaseOwner}`);
  return out;
}
