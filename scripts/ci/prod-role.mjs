// The production-shaped `postgres` role for the schema job. On Supabase the connection a migration runs on is `postgres`: LOGIN, CREATEDB,
// CREATEROLE, BYPASSRLS, NOT superuser, NOT a member of supabase_admin (P2-15d: 0001's `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` failed there
// with 42501 while the job, which ran as the container's superuser, never saw it). A container's `postgres` is the bootstrap superuser, so this module
// moves the superuser to `ci_bootstrap` (superuser on the same cluster) and creates a role named `postgres` with production's attributes and the same password.
// Callers keep one URL for the app side; the returned suUrl is for the bootstrap statements only. No fallback: if the swap fails the job fails.
import pg from "pg";

const q = async (client, sql, params) => (await client.query(sql, params)).rows;

export async function bootstrapProductionRole(databaseUrl) {
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
    await boot.query(`CREATE ROLE postgres LOGIN CREATEDB CREATEROLE BYPASSRLS NOSUPERUSER NOREPLICATION PASSWORD '${password.replace(/'/g, "''")}'`);
    await boot.end();
  } else {
    await first.end();
  }
  const check = new pg.Client({ connectionString: databaseUrl });
  await check.connect();
  const [r] = await q(check, "SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = current_user");
  const member = (await q(check, "SELECT pg_has_role(current_user, 'supabase_admin', 'member') AS m").catch(() => [{ m: false }]))[0].m;
  await check.end();
  return { appUrl: databaseUrl, suUrl: su.toString(), db, shape: { ...r, supabase_admin_member: member } };
}

// Run by the bootstrap once the stub schemas exist: what production's `postgres` holds on them.
export const PRODUCTION_ROLE_GRANTS = (db) => `
-- the auth schema USAGE for the API roles is Supabase's; the stub lacked it (0062 granted it inside its fixture)
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${db}" TO postgres;
GRANT anon, authenticated, service_role TO postgres;
GRANT SET ON PARAMETER session_replication_role TO postgres; -- supautils lets Supabase's postgres set it (seven migration self-checks' fixtures use it)
GRANT USAGE ON SCHEMA extensions, auth, vault, net TO postgres;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO postgres;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth, net TO postgres;
GRANT SELECT ON vault.decrypted_secrets TO postgres;
`;
