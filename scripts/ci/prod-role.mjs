// The production-shaped `postgres` role for the schema job. On Supabase the connection a migration runs on is `postgres`: LOGIN, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS, NOT superuser, NOT a member of supabase_admin, and
// the owner of the database (P2-15d: 0001's `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` failed there with 42501 while the job, which ran as the container's superuser, never saw it). A container's `postgres` is the
// bootstrap superuser, so this module moves the superuser to `ci_bootstrap` (superuser on the same cluster) and creates a role named `postgres` with the attributes the production shape records
// (scripts/ci/data/production-shape.json) and the same password. Callers keep one URL for the app side; the returned suUrl is for the bootstrap statements only. No fallback: if the swap fails the job fails.
import pg from "pg";

const q = async (client, sql, params) => (await client.query(sql, params)).rows;

/** The CREATE ROLE attribute list of a shape role. */
const attributesOf = (r) => `${r.createdb ? "CREATEDB" : "NOCREATEDB"} ${r.createrole ? "CREATEROLE" : "NOCREATEROLE"} ${r.bypassrls ? "BYPASSRLS" : "NOBYPASSRLS"} ${r.replication ? "REPLICATION" : "NOREPLICATION"} ${r.inherit ? "INHERIT" : "NOINHERIT"} ${r.login ? "LOGIN" : "NOLOGIN"} NOSUPERUSER`;

export async function bootstrapProductionRole(databaseUrl, shape) {
  const want = shape.roles.find((r) => r.name === "postgres");
  if (!want || want.super) throw new Error("prod-role: the production shape has no non-superuser `postgres` role");
  const u = new URL(databaseUrl);
  if (decodeURIComponent(u.username) !== "postgres") throw new Error("prod-role: DATABASE_URL must name the bootstrap superuser `postgres`");
  const password = decodeURIComponent(u.password);
  const su = new URL(databaseUrl);
  su.username = "ci_bootstrap";
  su.password = "ci_bootstrap";
  const db = decodeURIComponent(u.pathname.slice(1)) || "postgres";

  const first = new pg.Client({ connectionString: databaseUrl });
  await first.connect();
  const [{ rolsuper }] = await q(first, "SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
  if (rolsuper) {
    // First run on this cluster: stand up the second superuser, then swap the names from its session.
    await first.query("CREATE ROLE ci_bootstrap SUPERUSER LOGIN PASSWORD 'ci_bootstrap'");
    await first.end();
    const boot = new pg.Client({ connectionString: su.toString() });
    await boot.connect();
    await boot.query("ALTER ROLE postgres RENAME TO ci_bootstrap_old");
    await boot.query("ALTER ROLE ci_bootstrap_old NOLOGIN");
    await boot.query(`CREATE ROLE postgres ${attributesOf(want)} PASSWORD '${password.replace(/'/g, "''")}'`);
    await boot.end();
  } else {
    await first.end();
  }
  const check = new pg.Client({ connectionString: databaseUrl });
  await check.connect();
  const [r] = await q(check, "SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = current_user");
  const member = (await q(check, "SELECT pg_has_role(current_user, 'supabase_admin', 'member') AS m").catch(() => [{ m: false }]))[0].m;
  await check.end();
  return { appUrl: databaseUrl, suUrl: su.toString(), db, shape: { ...r, supabase_admin_member: member } };
}

/** Is the connected role what the shape says `postgres` is? Returns the differences (an empty list when it matches). */
export function roleProblems(shape, got) {
  const want = shape.roles.find((r) => r.name === "postgres");
  const pairs = [["rolsuper", want.super], ["rolcreatedb", want.createdb], ["rolcreaterole", want.createrole], ["rolbypassrls", want.bypassrls], ["rolreplication", want.replication], ["rolcanlogin", want.login], ["supabase_admin_member", false]];
  return pairs.filter(([k, v]) => got[k] !== v).map(([k, v]) => `the schema job role has ${k}=${got[k]}, production's postgres has ${v}`);
}

// Run by the bootstrap once the platform schemas exist: what production's `postgres` holds on the objects the stubs create (the schema ACLs and default privileges come from the shape, schema/shape.mjs).
export const PRODUCTION_ROLE_GRANTS = (db) => `
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${db}" TO postgres;
GRANT SET ON PARAMETER session_replication_role TO postgres; -- supautils lets Supabase's postgres set it (seven migration self-checks' fixtures use it)
GRANT ALL ON ALL TABLES IN SCHEMA auth TO postgres;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth, net TO postgres;
GRANT SELECT ON vault.decrypted_secrets TO postgres;
`;
