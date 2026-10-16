// Installs the repo's git hooks (IMP-021): a pre-commit that runs the schema property checks (scripts/ci/properties.mjs) before a commit that stages a file under supabase/, where a local Postgres exists
// (DATABASE_URL set and psql on the path). Without them it prints why it skipped and lets the commit through: CI's schema job is the gate, this only saves the one CI run. Usage: npm run install-hooks
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const PRE_COMMIT = `#!/bin/sh
# Installed by scripts/install-hooks.mjs. The schema property checks, before a commit that stages a supabase/ file.
git diff --cached --name-only | grep -q '^supabase/' || exit 0
[ -n "$DATABASE_URL" ] || { echo "pre-commit: DATABASE_URL is not set, so the schema property checks are skipped (CI runs them)"; exit 0; }
command -v psql >/dev/null 2>&1 || { echo "pre-commit: psql is not on the path, so the schema property checks are skipped (CI runs them)"; exit 0; }
exec node scripts/ci/properties.mjs
`;

/** Write the pre-commit hook into the repository's hooks directory; returns its path. */
export function installHooks(cwd = process.cwd()) {
  const hooks = resolve(cwd, execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd, encoding: "utf8" }).trim());
  const file = resolve(hooks, "pre-commit");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, PRE_COMMIT, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) console.log(`installed ${installHooks()}`);
