import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

// The authenticated role may read only the profiles columns granted to it (SEC-5: email and is_platform_admin are outside the grant). A select on a
// member's own client that names another column answers "permission denied for table profiles", which the service client used to hide.
const granted = new Set([...readFileSync("supabase/schema.sql", "utf8").matchAll(/GRANT ((?:SELECT|INSERT|UPDATE)\([a-z_]+\)(?:,(?:SELECT|INSERT|UPDATE)\([a-z_]+\))*) ON TABLE public\.profiles TO authenticated;/g)].flatMap((m) => [...m[1]!.matchAll(/SELECT\(([a-z_]+)\)/g)].map((c) => c[1]!)));
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(`${dir}/${n}`).isDirectory() ? files(`${dir}/${n}`) : /\.tsx?$/.test(n) ? [`${dir}/${n}`] : []));
const columnsOf = (list: string) => list.split(",").map((c) => c.trim().replace(/^.*:/, "").replace(/\(.*$/, "")).filter(Boolean);

/** Every profiles select and embed under src/ that runs on a non-service client, with the columns it names. */
export function profileReads(): { file: string; columns: string[] }[] {
  const out: { file: string; columns: string[] }[] = [];
  for (const file of files("src")) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const direct = /(\w+)\.from\("profiles"\)\.select\("([^"]*)"/.exec(line);
      if (direct && direct[1] !== "service") out.push({ file, columns: columnsOf(direct[2]!) });
      for (const embed of line.matchAll(/(\w+)\.from\("[a-z_]+"\)\.select\("[^"]*profiles!\w+\(([^)]*)\)/g)) if (embed[1] !== "service") out.push({ file, columns: columnsOf(embed[2]!) });
      const bare = /\.select\("[^"]*profiles!\w+\(([^)]*)\)/.exec(line);
      if (bare && !/service\.from/.test(line) && !/\w+\.from\("[a-z_]+"\)\.select/.test(line)) out.push({ file, columns: columnsOf(bare[1]!) });
    }
  }
  return out;
}

test("the profiles grant is read from schema.sql and every non-service select and embed under src names only granted columns", () => {
  assert.ok(granted.has("full_name") && granted.has("sector_overrides") && !granted.has("email") && !granted.has("is_platform_admin"), "the grant was parsed");
  const reads = profileReads();
  assert.ok(reads.length >= 4, `found the profile reads (${reads.length})`);
  for (const r of reads) for (const c of r.columns) assert.ok(granted.has(c), `${r.file} selects profiles.${c}, which authenticated may not read`);
});
