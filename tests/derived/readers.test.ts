// INV-R2d-2: no reader of the item or claim tables bypasses the admissible-row predicate (src/core/derived/admissible.ts). The test walks src/, finds every file that queries a governed table, and sorts each into
// exactly one of: a pipeline or operator file (readers.json `exempt`, a glob with its reason: these read unverified, archived or superseded rows on purpose), a lookup that selects identity columns only,
// a customer reader that takes the predicate (it imports the module and uses it for every governed table it reads), or an OWED reader (readers.json `owed`, with the slice that owns the fix: the test fails when
// an owed file is in fact compliant, so a fixed reader must leave the list, and when a new reader appears that is on no list). Nothing here is loosened by editing a test: the lists are data.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import registry from "./readers.json" with { type: "json" };

type Exempt = { glob: string; kind: "pipeline" | "operator" | "history"; why: string };
type Owed = { file: string; tables: string[]; owner: string; finding: string };
const REGISTRY = registry as { exempt: Exempt[]; owed: Owed[] };

/** table -> what a compliant customer reader must contain for it. */
const GOVERNED: Record<string, RegExp> = {
  intelligence_items: /\badmitItems\(|\bisAdmissibleItem\b|\bcurrentInputRow\b|\badmissibleRows\.itemIds\(/,
  section_claim_provenance: /\badmissibleClaims\(|\bisAdmissibleClaim\(|\badmissibleRows\.claims\(|\bsuppressedClaimMatcher\(|\bbuildClaimTierMap\b/,
  emission_factors: /\badmitFactors\(|\bisAdmissibleFactor\b|\.is\("superseded_by", null\)/,
  derived_values: /derived_values_admissible|derived_values_for_use|\badmissibleFor\(/,
  inference_records: /\bisCurrentInference\(|\.eq\("admissibility", "current"\)/,
};
const IDENTITY_ONLY = /^\s*(id|legacy_id|item_type|domain|title|id, legacy_id|id, legacy_id, item_type, domain, provenance_status)\s*$/;

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
const norm = (p: string): string => relative(".", p).replace(/\\/g, "/");
const globRe = (g: string): RegExp => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);

/** The governed tables a file queries: `.from("t")` and an embedded relation `t!inner(` or `:t(`. */
function tablesOf(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of Object.keys(GOVERNED)) {
    const selects: string[] = [];
    for (const m of text.matchAll(new RegExp(`\\.from\\(\\s*["'\`]${t}["'\`]\\s*\\)\\s*\\.select\\(\\s*["'\`]([^"'\`]*)["'\`]`, "g"))) selects.push(m[1] as string);
    const bare = new RegExp(`\\.from\\(\\s*["'\`]${t}["'\`]\\s*\\)`).test(text);
    const embedded = new RegExp(`(?::|\\b)${t}!inner\\(|:${t}\\(`).test(text);
    if (bare || embedded) out.set(t, selects);
  }
  return out;
}

interface Verdict { file: string; kind: "exempt" | "identity" | "compliant" | "violation"; missing: string[] }

function judge(): Verdict[] {
  const exempt = REGISTRY.exempt.map((e) => ({ ...e, re: globRe(e.glob) }));
  const out: Verdict[] = [];
  for (const path of walk("src")) {
    const file = norm(path);
    const text = readFileSync(path, "utf8");
    const tables = tablesOf(text);
    if (!tables.size) continue;
    if (exempt.some((e) => e.re.test(file))) { out.push({ file, kind: "exempt", missing: [] }); continue; }
    const missing = [...tables.entries()].filter(([t, selects]) => !(selects.length > 0 && selects.every((s) => IDENTITY_ONLY.test(s))) && !GOVERNED[t]!.test(text)).map(([t]) => t);
    const usesModule = /@\/core\/derived\//.test(text) || /from "\.\/(admissible|current-input)"/.test(text);
    out.push({ file, kind: missing.length === 0 ? (usesModule ? "compliant" : "identity") : "violation", missing });
  }
  return out;
}

test("INV-R2d-2: every file that queries a governed table is exempt by glob, an identity lookup, a compliant reader, or an owed reader with its owner; none is anything else", () => {
  const verdicts = judge();
  const owed = new Map(REGISTRY.owed.map((o) => [o.file, o]));
  const unlisted = verdicts.filter((v) => v.kind === "violation" && !owed.has(v.file)).map((v) => `${v.file}: reads ${v.missing.join(", ")} without the admissible-row predicate`);
  assert.deepEqual(unlisted, [], "a reader bypasses the predicate: use admitItems / admitFactors / admissibleClaims from @/core/derived/admissible, or (a pipeline or operator file) add an exempt glob with its reason");
  const stale = REGISTRY.owed.filter((o) => { const v = verdicts.find((x) => x.file === o.file); return !v || v.kind !== "violation"; }).map((o) => `${o.file}: owed to ${o.owner} but it no longer bypasses the predicate (or no longer reads a governed table): remove it from readers.json`);
  assert.deepEqual(stale, []);
  const wrongTables = REGISTRY.owed.flatMap((o) => { const v = verdicts.find((x) => x.file === o.file); return v && JSON.stringify([...v.missing].sort()) !== JSON.stringify([...o.tables].sort()) ? [`${o.file}: owed tables ${o.tables} but it bypasses ${v.missing}`] : []; });
  assert.deepEqual(wrongTables, []);
});

test("the registry is made of findings: every exempt glob carries a reason, every owed reader an owner and a finding, and every exempt glob matches at least one reading file", () => {
  for (const e of REGISTRY.exempt) assert.ok(e.why.length > 20 && ["pipeline", "operator", "history"].includes(e.kind), e.glob);
  for (const o of REGISTRY.owed) assert.ok(/^R[\w-]+/.test(o.owner) && o.finding.length > 20 && o.tables.length > 0, o.file);
  const reading = judge().map((v) => v.file);
  const unused = REGISTRY.exempt.filter((e) => !reading.some((f) => globRe(e.glob).test(f))).map((e) => e.glob);
  assert.deepEqual(unused, [], "an exempt glob that matches no reading file is dead weight");
});

test("a planted reader that queries intelligence_items without the predicate is reported; the same reader with admitItems is not", () => {
  const bad = 'await db.from("intelligence_items").select("id, title").eq("domain", 1);';
  const good = 'import { admitItems } from "@/core/derived/admissible"; await admitItems(db.from("intelligence_items").select("id, title")).eq("domain", 1);';
  const missing = (text: string) => [...tablesOf(text).entries()].filter(([t, s]) => !(s.length > 0 && s.every((x) => IDENTITY_ONLY.test(x))) && !GOVERNED[t]!.test(text)).map(([t]) => t);
  assert.deepEqual(missing(bad), ["intelligence_items"]);
  assert.deepEqual(missing(good), []);
  assert.deepEqual(missing('await db.from("intelligence_items").select("id, legacy_id").in("legacy_id", s);'), [], "an identity lookup is not a read of the row");
});

test("the TypeScript predicate and the SQL one say the same three things (migration 0092 item_is_admissible)", () => {
  const sql = readFileSync("supabase/migrations/0092_source_coverage.sql", "utf8");
  const body = /CREATE FUNCTION public\.item_is_admissible[\s\S]*?\$\$ ([\s\S]*?) \$\$;/.exec(sql)?.[1] ?? "";
  assert.match(body, /p_status = 'verified'/);
  assert.match(body, /p_archived = false/);
  assert.match(body, /p_replaced_by IS NULL/);
  const ts = readFileSync("src/core/derived/admissible.ts", "utf8");
  assert.match(ts, /provenance_status === "verified"/);
  assert.match(ts, /is_archived === false/);
  assert.match(ts, /replaced_by === null/);
});
