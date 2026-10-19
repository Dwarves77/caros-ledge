// The base of the schema job: an empty Postgres (DATABASE_URL) turned into the empty Supabase project the migrations are written for, then supabase/schema.sql applied on top. Everything platform-specific (roles and their
// attributes, memberships, role settings, schema owners and ACLs, the platform's default privileges, auth.users and the auth functions, the database owner) is generated from the production shape,
// scripts/ci/data/production-shape.json, by scripts/ci/schema/shape.mjs; what is typed here is only what no catalog query records (the vault and net stubs, the grants `postgres` holds on them).
// DATABASE_URL names the cluster's bootstrap superuser (`postgres`). The bootstrap runs as the superuser `ci_bootstrap` (suUrl); everything from schema.sql onward runs as `postgres`, shaped like production's
// (scripts/ci/prod-role.mjs): LOGIN, not superuser, not a member of supabase_admin, the database owner. A statement that needs more than production's role fails here, as it would there.
import { readFileSync } from "node:fs";

import { bootstrapProductionRole, PRODUCTION_ROLE_GRANTS, roleProblems } from "../prod-role.mjs";
import { psql as runSql } from "../psql.mjs";

import { authSql, defaultAclSql, parseAcl, roleSql, schemaSql, shapeDiff } from "./shape.mjs";

const NL = "\n";
const ident = (x) => `"${x.replace(/"/g, '""')}"`;
export const SHAPE_FILE = JSON.parse(readFileSync("scripts/ci/data/production-shape.json", "utf8"));

const imageExtensions = (inPublic) => SHAPE_FILE.extensions.filter((e) => e.source === "image" && (e.schema === "public") === inPublic);

/** The bootstrap script for the platform's schemas, roles and stubs (run as the superuser, before supabase/schema.sql). Every extension the Postgres image provides is created in production's schema; the Supabase-only ones (pg_cron, pg_net, pgjwt, pgsodium, supabase_vault) have no image build and stand as the empty schemas the shape lists. */
export function stubSql(db) {
  const shape = SHAPE_FILE.shape;
  const publicAcl = shape.schemaAcls.find((s) => s.schema === "public");
  const everyone = ["PUBLIC", ...shape.roles.map((r) => ident(r.name))];
  return [
    ...roleSql(shape, ["postgres"]),
    `ALTER DATABASE ${ident(db)} OWNER TO postgres;`,
    ...schemaSql(shape),
    ...imageExtensions(false).map((e) => `CREATE EXTENSION IF NOT EXISTS ${ident(e.name)} WITH SCHEMA ${ident(e.schema)};`),
    ...SHAPE_FILE.extensions.filter((e) => e.source === "supabase").map((e) => `-- ${e.name} ${e.version} (${e.schema}): Supabase-only, not in the Postgres image; its schema is the stub.`),
    ...authSql(shape),
    "ALTER TABLE auth.users OWNER TO supabase_auth_admin;",
    "CREATE OR REPLACE VIEW vault.decrypted_secrets AS SELECT NULL::uuid AS id, NULL::text AS name, NULL::text AS decrypted_secret WHERE false;",
    "CREATE TABLE IF NOT EXISTS net._http_response (id bigint, status_code int, content text);",
    "CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}', headers jsonb DEFAULT '{}', timeout_milliseconds int DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $f$ SELECT 0::bigint $f$;",
    "DROP SCHEMA IF EXISTS public CASCADE;",
    "CREATE SCHEMA public AUTHORIZATION pg_database_owner;",
    `REVOKE ALL ON SCHEMA public FROM ${everyone.join(", ")};`,
    ...publicAcl.acl.flatMap((item) => parseAcl(`{${item}}`)).filter((e) => e.grantee !== "pg_database_owner").map((e) => `GRANT USAGE ON SCHEMA public TO ${e.grantee === "PUBLIC" ? "PUBLIC" : ident(e.grantee)};`),
    ...imageExtensions(true).map((e) => `CREATE EXTENSION IF NOT EXISTS ${ident(e.name)} WITH SCHEMA public;`),
    // After the schema public is recreated: dropping a schema drops the default privileges set in it.
    ...defaultAclSql(shape),
  ].join(NL);
}

/** Bootstrap the role, then return the runner every later step uses: `psql(opts, asSuperuser)`, the app URL and the database name. Exits 1 when the role is not what production's postgres is. */
export async function openDatabase(databaseUrl) {
  const { appUrl, suUrl, db, shape } = await bootstrapProductionRole(databaseUrl, SHAPE_FILE.shape);
  const wrong = roleProblems(SHAPE_FILE.shape, shape);
  if (wrong.length) throw new Error(`schema job role is not production-shaped: ${wrong.join("; ")}`);
  console.log(`schema job role: postgres ${JSON.stringify(shape)}`);
  const psql = (opts, asSuperuser = false) => {
    const r = runSql(asSuperuser ? suUrl : appUrl, opts);
    return { code: r.status, err: r.stderr, out: r.stdout };
  };
  return { url: appUrl, suUrl, db, psql };
}

export const errorsOf = (text) => text.split(NL).filter((l) => /ERROR|FATAL/.test(l));

/** Apply the stubs and supabase/schema.sql. Returns { code, errors }. `stopOnError` false lists every failure instead of the first. */
export function applyBase({ psql, db }, stopOnError) {
  const stub = psql({ sql: stubSql(db) }, true);
  if (stub.code !== 0) return { code: stub.code, errors: errorsOf(stub.err) };
  const grants = psql({ sql: PRODUCTION_ROLE_GRANTS(db) }, true);
  if (grants.code !== 0) return { code: grants.code, errors: errorsOf(grants.err) };
  // schema.sql opens with CREATE SCHEMA public; the stub already made it (so the extensions can live there, as on production). The dump stays unedited on disk.
  const dump = readFileSync("supabase/schema.sql", "utf8").split(String.fromCharCode(13, 10)).join(NL);
  const OPEN = `${NL}CREATE SCHEMA public;${NL}`;
  if (!dump.includes(OPEN)) throw new Error("schema.sql no longer opens with CREATE SCHEMA public;");
  const r = psql({ sql: dump.replace(OPEN, `${NL}CREATE SCHEMA IF NOT EXISTS public;${NL}`), stopOnError });
  const errors = errorsOf(r.err);
  return { code: r.code !== 0 || errors.length ? 1 : 0, errors };
}

/** The shape of THIS database, asked with the function production is asked (public.live_check_production_shape(), migration 0071: the text of scripts/ci/data/production-shape.sql), and every difference from the production shape. */
export function shapeProblems({ psql }) {
  const r = psql({ sql: "SELECT public.live_check_production_shape()", tuples: true });
  if (r.code !== 0) return [`the shape query failed: ${r.err.trim()}`];
  return shapeDiff(SHAPE_FILE.shape, JSON.parse(r.out.trim()));
}
