// Writes supabase/migrations/APPLIED.json after the window (P2-15 PART B step 2): the migrations production carries, as the 4-digit numbers the parity waivers name. The input is the run artifact's list of the files
// the window applied, one file name per line (cutover-run/applied.txt). A name that is not a migration file is refused, so the list cannot claim a file that is not there. Once the file exists the
// until-migration waivers it lists fail the tree check until they are deleted (scripts/ci/waiver-check.mjs), and zero may remain.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DIR = "supabase/migrations";

/** The applied document for the listed file names, or the problems. Pure. */
export function appliedDocument(names, files) {
  const problems = [];
  const numbers = [];
  for (const raw of names) {
    const name = raw.trim().replace(/\.sql$/, "");
    if (!name) continue;
    if (!files.includes(`${name}.sql`)) problems.push(`${raw.trim()} is not a file in ${DIR}`);
    else numbers.push(name.slice(0, 4));
  }
  if (!numbers.length && !problems.length) problems.push("the list names no migration");
  return { problems, doc: { applied: [...new Set(numbers)].sort() } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const list = process.argv[2];
  if (!list || !existsSync(list)) {
    console.error("usage: node scripts/cutover/write-applied.mjs <cutover-run/applied.txt>");
    process.exit(2);
  }
  const { problems, doc } = appliedDocument(readFileSync(list, "utf8").split("\n"), readdirSync(DIR));
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  writeFileSync(`${DIR}/APPLIED.json`, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`APPLIED.json lists ${doc.applied.length} migration(s)`);
}
