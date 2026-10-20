// The one reader of supabase/migrations: file names, class (schema or data), the header declarations and the self-check id. apply-plan.mjs, migration-checks.mjs, schema-apply.mjs and dry-run.mjs
// take their view of a migration from here.
import { existsSync, readdirSync, readFileSync } from "node:fs";

export const MIGRATIONS_DIR = "supabase/migrations";
export const MIGRATION_FILE = /^(\d{4})_(.+)\.sql$/;

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
