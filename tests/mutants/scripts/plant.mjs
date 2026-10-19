// A planted defect, by name (tests/mutants/registry.json: { "apply": { "script": "tests/mutants/scripts/plant.mjs", "args": ["<name>"] } }). The mutants runner applies it to a scratch copy of the tree and runs the gate that must
// catch it. A defect is built here rather than written into the registry when the text that makes it would itself trip a check of the real tree (a personal path, a mail address) or is an appended block, not an edit.
//   node tests/mutants/scripts/plant.mjs <name>
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const LOG = "src/core/shared/log.ts";
const lines = (n, make) => Array.from({ length: n }, (_, i) => make(i)).join("\n");
const append = (file, text) => appendFileSync(file, `\n${text}\n`);
const create = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** Replace the LAST occurrence of `from` in `file`; throws when it is not there, so a stale plant is an error and not a green gate. */
function replaceLast(file, from, to) {
  const text = readFileSync(file, "utf8");
  const at = text.lastIndexOf(from);
  if (at < 0) throw new Error(`${file} no longer contains ${JSON.stringify(from)}`);
  writeFileSync(file, `${text.slice(0, at)}${to}${text.slice(at + from.length)}`);
}

const lastMigration = () => readdirSync("supabase/migrations").filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().at(-1);

const PLANTS = {
  // lint: an empty catch swallows an error (eslint no-restricted-syntax)
  "empty-catch": () => create("src/core/shared/planted-swallow.ts", 'export function plantedSwallow(): void {\n  try {\n    JSON.parse("{");\n  } catch {\n  }\n}'),
  // typecheck: a number that is a string
  "type-error": () => append(LOG, 'export const plantedTypeError: number = "not a number";'),
  // build: an import of a module that does not exist
  "build-missing-import": () => writeFileSync("src/app/page.tsx", `import "@/core/shared/planted-missing-module";\n${readFileSync("src/app/page.tsx", "utf8")}`),
  // tree-checks: a person's home directory and a personal mail address in a tracked file (assembled here so this file carries neither)
  "home-path": () => append(LOG, `// ${["C:", "Users", "someone", "dev"].join("/")}`),
  "personal-mail": () => append(LOG, `// ${["someone", "@", "gmail", ".com"].join("")}`),
  // loc: src/core over its 25,000 code lines
  "loc-over-limit": () => append(LOG, lines(30000, (i) => `export const plantedPadding${i} = ${i};`)),
  // connections: an export nothing calls; a reader of a table nothing writes; a dependency member that may be left out
  "uncalled-export": () => append(LOG, "export function plantedUncalled(): number {\n  return 1;\n}"),
  "unwritten-table": () => create("src/features/market/read/planted-reader.ts", 'const plantedQuery = (db: { from: (t: string) => { select: (c: string) => unknown } }) => db.from("planted_unwritten_table").select("id");\nvoid plantedQuery;\n'),
  "optional-dep": () => append(LOG, "export interface PlantedDeps {\n  plantedDown?: () => void;\n}"),
  // columns: a write payload naming a column the table does not have
  "typo-insert": () => create("src/core/sources/planted-write.ts", 'const plantedWrite = (db: { from: (t: string) => { insert: (r: object) => unknown } }) => db.from("sources").insert({ not_a_column: 1 });\nvoid plantedWrite;\n'),
  // ui-checks: a colour literal in the kit
  "kit-hex-literal": () => append("src/ui/base.css", ".cl-planted { color: #123456; }"),
  // test (tests/ci/exports-have-tests): a new export that no test names
  "untested-export": () => append(LOG, "export const plantedUntested = 1;"),
  // migration-checks: a self-check that cannot fail (its RAISE EXCEPTION is a NOTICE); a self-check that reads a live row through a sub-select
  "migration-no-raise": () => {
    const file = `supabase/migrations/${lastMigration()}`;
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("RAISE EXCEPTION", "RAISE NOTICE"));
  },
  "migration-borrowed-subselect": () => replaceLast(`supabase/migrations/${lastMigration()}`, "END $$", "  PERFORM 1 FROM (SELECT id FROM public.profiles LIMIT 1) borrowed;\nEND $$"),
};

const name = process.argv[2];
if (!PLANTS[name]) {
  process.stderr.write(`plant: unknown plant "${name}" (${Object.keys(PLANTS).join(", ")})`);
  process.exit(1);
}
PLANTS[name]();
process.stdout.write(`planted ${name}${String.fromCharCode(10)}`);
