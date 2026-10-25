// The one reader of supabase/migrations: file names, class (schema or data), the header declarations and the self-check id. apply-plan.mjs, migration-checks.mjs, schema-apply.mjs and dry-run.mjs
// take their view of a migration from here.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

export const MIGRATIONS_DIR = "supabase/migrations";
export const MIGRATION_FILE = /^(\d{4})_(.+)\.sql$/;
/** README.md keeps one frozen table row for each file up to this number and is never edited again (APPLY-1); a file above it describes itself on its own `-- change: <text>` line. */
export const README_FROZEN_THROUGH = "0134";
/** The migration number ledger, committed beside the files: every number above README_FROZEN_THROUGH is claimed here by a slice before its file exists. */
export const RESERVED_FILE = "RESERVED.json";

export const isData = (file) => file.includes("_data_");
/** The migration files of `dir` in name order. */
export const migrationFiles = (dir = MIGRATIONS_DIR) => readdirSync(dir).filter((f) => MIGRATION_FILE.test(f)).sort();
export const numberOf = (file) => MIGRATION_FILE.exec(file)?.[1] ?? null;
export const read = (file, dir = MIGRATIONS_DIR) => readFileSync(`${dir}/${file}`, "utf8").replace(/\r\n/g, "\n");
export const applyNotes = (dir = MIGRATIONS_DIR) => (existsSync(`${dir}/apply-notes.json`) ? JSON.parse(readFileSync(`${dir}/apply-notes.json`, "utf8")) : {});

/** The id a file declares on its `-- Self-check <id>` line, or null: the word after the marker, up to a colon or a space. */
export const selfCheckId = (text) => /^-- Self-check ([\w.-]+)/m.exec(text)?.[1] ?? null;
/** The id a file's self-check goes by: its declared `-- Self-check <id>`, else the last id its DO block prints as `<id> OK` (a file written before the header was the convention), else its number (a file with no self-check at all: migration-checks refuses it). */
export const selfCheckIdOf = (text, file) => selfCheckId(text) ?? noticeIds(text).at(-1) ?? numberOf(file);
/** The ids the file prints as `RAISE NOTICE '<id> OK'`, in order. */
export const noticeIds = (text) => [...text.matchAll(/RAISE NOTICE '([\w.-]+) OK/g)].map((m) => m[1]);
/** The `-- catalog:` classes a file declares (an empty set for `none`). */
export const declaredClasses = (text) => new Set((/^-- catalog: (.*)$/m.exec(text)?.[1] ?? "").split(",").map((x) => x.trim()).filter((x) => x && x !== "none"));

/** The one-line change a file above README_FROZEN_THROUGH declares about itself, or null. */
export const changeOf = (text) => /^-- change: (\S.*)$/m.exec(text)?.[1].trim() ?? null;
/** The frozen README table: file name (no .sql) -> its change cell. */
export const readmeRows = (dir = MIGRATIONS_DIR) =>
  new Map([...readFileSync(`${dir}/README.md`, "utf8").matchAll(/^\| (\d{4}_\S+) \|(.*)\|\s*$/gm)].map(([, f, rest]) => [f, rest.includes("|") ? rest.slice(0, rest.lastIndexOf("|")).trim() : rest.trim()]));

const gitOut = (args, cwd) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
};
/** The git ref a change is compared with: MIGRATION_BASE (`none` turns it off), else the pull request base in CI, else origin/main when the clone has it; null when there is none (a push to main, a lone fixture). */
export function defaultBase(env = process.env) {
  if (env.MIGRATION_BASE) return env.MIGRATION_BASE === "none" ? null : env.MIGRATION_BASE;
  if (env.GITHUB_ACTIONS) return env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : null;
  return gitOut(["rev-parse", "--verify", "--quiet", "origin/main"]) === null ? null : "origin/main";
}
/** The migration file names `dir` holds at git ref `base` (null when the ref cannot be read). In CI the checkout is shallow, so a missing origin/<branch> ref is fetched once. */
export function filesAtBase(dir, base, cwd = ".") {
  const branch = /^origin\/(.+)$/.exec(base)?.[1];
  if (gitOut(["rev-parse", "--verify", "--quiet", `${base}^{tree}`], cwd) === null && branch && process.env.GITHUB_ACTIONS) gitOut(["fetch", "--no-tags", "--depth=1", "origin", `+refs/heads/${branch}:refs/remotes/${base}`], cwd);
  const out = gitOut(["ls-tree", "--name-only", base, `${dir}/`], cwd);
  return out === null ? null : out.split("\n").map((p) => p.slice(p.lastIndexOf("/") + 1)).filter((f) => MIGRATION_FILE.test(f)).sort();
}
