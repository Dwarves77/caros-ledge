// Reads the shape of the production database (roles, memberships, role settings, schema ACLs, default ACLs, the few server settings that change behaviour) with ONE read-only catalog query, scripts/ci/data/production-shape.sql, and
// writes it under the "shape" key of scripts/ci/data/production-shape.json, which the schema job builds the CI database from. The same query is public.live_check_production_shape() (migration 0071), so the live check compares
// the deployed project with this file by calling it. Needs the Supabase CLI logged in and linked to the production project (run it from the directory that is linked, or pass --workdir).
//   node scripts/cutover/read-production-shape.mjs [--workdir <dir>] [--write]     without --write it prints what would change and exits 1 when the file is out of date
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { isMain } from "../lib/fs.mjs";

const FILE = "scripts/ci/data/production-shape.json";
const QUERY = resolve("scripts/ci/data/production-shape.sql");

/** The shape document out of the CLI's JSON answer (`{ rows: [{ shape }] }`). Throws on any other answer. */
export function shapeOf(answer) {
  const shape = JSON.parse(answer)?.rows?.[0]?.shape;
  if (!shape || !Array.isArray(shape.roles)) throw new Error("the answer carries no shape document (rows[0].shape.roles)");
  return shape;
}

const inline = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(", ")} }` : Array.isArray(v) ? `[${v.map(inline).join(", ")}]` : JSON.stringify(v));
/** The file as text: an object key per line, an array of objects as one compact line per element (a diff of a role or an ACL is one line), everything else JSON. Deterministic, so a re-read of an unchanged production writes the same bytes. */
export function renderFile(value, depth = 0) {
  const pad = "  ".repeat(depth + 1);
  const end = "  ".repeat(depth);
  if (Array.isArray(value) && value.some((x) => x !== null && typeof x === "object")) return `[\n${value.map((x) => `${pad}${inline(x)}`).join(",\n")}\n${end}]`;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return `{\n${Object.entries(value).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${renderFile(x, depth + 1)}`).join(",\n")}\n${end}}`;
  return inline(value);
}

export function readProduction(workdir) {
  return shapeOf(execFileSync("supabase", ["db", "query", "--linked", "-f", QUERY], { cwd: workdir, encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 }));
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { workdir: { type: "string", default: "." }, write: { type: "boolean", default: false } }, strict: true });
  const file = JSON.parse(readFileSync(FILE, "utf8"));
  const live = readProduction(values.workdir);
  const same = JSON.stringify(file.shape) === JSON.stringify(live);
  console.log(same ? "production-shape.json equals production" : "production-shape.json differs from production");
  if (values.write && !same) {
    writeFileSync(FILE, `${renderFile({ ...file, shape: live })}\n`);
    console.log(`${FILE} rewritten`);
  }
  process.exit(same || values.write ? 0 : 1);
}
