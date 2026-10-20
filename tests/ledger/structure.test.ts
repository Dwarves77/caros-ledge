// INV-R2b-2: no writer of a claim's attribution (source_id, tier, search_result_id, source_span) exists outside the ledger module. The structure test reads every file under src, finds each place that writes the claim
// table, and fails on one that is not listed in claim-writers.json; the entries there are the named exceptions with their reason. The staged-patch allowlist in migration 0076 is pinned to the application's.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import staged from "../../src/features/intake/data/staged.json" with { type: "json" };

import allowed from "./claim-writers.json" with { type: "json" };

const ATTRIBUTION = /\b(source_id|source_span|search_result_id|source_tier_at_grounding)\b/;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = `${dir}/${f}`; return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : []; });
const SRC = walk("src").map((p) => p.replace(/\\/g, "/"));

interface Site { file: string; op: string; payload: string }
/** Every statement in a file that writes the claim table: a direct write on its from(), or a bulk helper handed the table name. */
function claimWriteSites(file: string, text: string): Site[] {
  const out: Site[] = [];
  for (const m of text.matchAll(/["'`]section_claim_provenance["'`]/g)) {
    const at = m.index ?? 0;
    const tail = text.slice(at, at + 700);
    const statement = tail.slice(0, tail.search(/;\s*\n|\n\s*\n/) >= 0 ? tail.search(/;\s*\n|\n\s*\n/) : tail.length);
    const before = text.slice(Math.max(0, at - 40), at);
    const direct = /\.(insert|update|upsert|delete)\(/.exec(statement);
    if (/from\(\s*$/.test(before) && direct) out.push({ file, op: direct[1] as string, payload: statement.slice(direct.index) });
    else if (/insertMany\(\s*\w+,\s*$/.test(before)) out.push({ file, op: "insert", payload: "(rows built elsewhere)" });
  }
  return out;
}

test("INV-R2b-2: no writer of a claim's source, tier, capture or span exists outside the ledger module; the only listed exceptions are the ones in claim-writers.json, and a listed file that no longer writes is removed from the list", () => {
  const found = new Map<string, Site[]>();
  for (const file of SRC) {
    const sites = claimWriteSites(file, readFileSync(file, "utf8"));
    if (sites.length) found.set(file, sites);
  }
  const listed = new Set(Object.keys(allowed.writers));
  for (const [file, sites] of found) {
    if (listed.has(file)) continue;
    assert.fail(`${file} writes the claim table (${sites.map((s) => s.op).join(", ")}) outside the ledger module: route it through src/core/grounding/ledger.ts (the ledger_* database functions)`);
  }
  for (const file of listed) assert.ok(found.has(file), `${file} is listed in claim-writers.json but no longer writes the claim table: remove the entry`);
  // the listed file that is allowed only for a non-attribution column really writes nothing else
  const ground = found.get("src/core/grounding/ground.ts") ?? [];
  assert.ok(ground.length > 0 && ground.every((s) => s.op === "update" && /mint_hold_reason/.test(s.payload) && !ATTRIBUTION.test(s.payload.split(".in(")[0] ?? "")), "ground.ts writes the S-CONFLATE hold and nothing else");
  assert.ok(!SRC.includes("src/core/grounding/ledger.ts") || !found.has("src/core/grounding/ledger.ts"), "the ledger module reaches the table only through the database functions");
});

test("INV-R2b-2: the ledger functions are called from the ledger module alone (one door); every other module calls its exports", () => {
  const callers = SRC.filter((f) => /["'`]ledger_(write_claim|remove_claim|apply_ops|reconcile_sections|erase_item)["'`]/.test(readFileSync(f, "utf8")));
  assert.deepEqual(callers, ["src/core/grounding/ledger.ts"]);
  const live = SRC.filter((f) => /\.update\(\s*\{[^}]*\b(source_tier_at_grounding|search_result_id)\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(live, [], "no update names a tier or a capture column");
});

test("the planted writers are caught: the old heal's patchClaim, an update naming a tier, and a bulk insert of claims", () => {
  const planted = [
    'await sb.from("section_claim_provenance").update(patch).eq("id", c.id);',
    'await sb.from("section_claim_provenance").update({ source_tier_at_grounding: 4 }).eq("id", c.id);',
    'const claims = await insertMany(sb, "section_claim_provenance", claimRows, "id");',
  ];
  for (const text of planted) assert.equal(claimWriteSites("src/planted.ts", text).length, 1, text);
  assert.equal(claimWriteSites("src/ok.ts", 'const r = await sb.from("section_claim_provenance").select("id").eq("intelligence_item_id", id);').length, 0, "a read is not a writer");
});

test("migration 0076's staged-patch allowlist is the application's: the same columns as intake/data/staged.json, in either list", () => {
  const sql = readFileSync("supabase/migrations/0076_apply_staged_item_patch.sql", "utf8");
  const list = (name: string) => [...(new RegExp(`${name} constant text\\[\\] := ARRAY\\[([^\\]]*)\\]`).exec(sql)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(list("c_content"), [...staged.contentColumns].sort());
  assert.deepEqual(list("c_book"), [...staged.nonSubstantive].sort());
  assert.deepEqual(list("c_archive"), [...staged.archiveColumns].sort());
  assert.deepEqual(list("c_source_dates"), [...staged.columnTypes.sourceDate].sort());
});
