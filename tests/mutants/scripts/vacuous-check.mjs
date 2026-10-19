// The mutation behind every `property:<key>` entry: make the check vacuous. The check's leading comment lines (its label) stay; its query is wrapped so it can never return a row. A property check that is run on the
// database with this change must go red on its own planted violation (scripts/ci/properties.mjs: "ATTACK FAILED <key>: the planted violation did not produce a row"), because a check that passes everything is the
// failure the attack exists to catch.
//   node tests/mutants/scripts/vacuous-check.mjs <key>
import { readFileSync, writeFileSync } from "node:fs";

const key = process.argv[2];
const file = `scripts/ci/checks/${key}.sql`;
const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const all = text.split("\n");
const head = all.findIndex((l) => !l.startsWith("--"));
const comments = all.slice(0, head).join("\n");
const query = all.slice(head).join("\n").trim().replace(/;$/, "");
writeFileSync(file, `${comments}\nSELECT * FROM (\n${query}\n) AS vacuous(finding) WHERE false;\n`);
process.stdout.write(`${key}: the check can no longer return a row${String.fromCharCode(10)}`);
