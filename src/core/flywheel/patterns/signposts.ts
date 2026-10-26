// New in CONNECT-2 PR B (scripts/ci/new-files/connect-2b.txt): the signposts of the patterns (C6). A mandate-capacity, lead-lag or penalty-abatement pattern is a forward claim: the dated step it rests on (the ratchet, the trigger) is still there on the day it falls due, and while its evidence holds. Each such pattern writes
// an inference record (the claim under test, HYPOTHESIS, citing the items its evidence rows belong to) and a signpost (watching the pattern's entity; the falsification condition is in its predicate) that tracks the inference record and no research assessment (migration 0141). The pattern step is the only observer of a pattern, so it scores
// its own signposts, in one update, the way the deadline path of the scorer does. A pattern with a key date is falsified when its key row is gone or its date has moved (refuted) and has held when the key row stands on the key date (fired and scored held); it is not falsified by ageing out of a detector's window (P3 drops a
// trigger inside 60 days, P2 a ratchet that has fallen due). A pattern with no key date (penalty-abatement) is falsified when it is no longer found. The scorer's own paths (events, deadlines, repair) never read these signposts: they read signposts that track an assessment. Scoring is evidence of a pattern kind's record, never a tier (INV-246).
import type { Db } from "@/core/db";
import { allRows, fetchAllByIdChunks } from "@/core/db";
import { entityId } from "@/core/entities/id";
import { PATTERN_METHODS } from "@/core/propagation/methods";

import { PATTERNS } from "./config";
import { patternSeed, type Fact, type Pattern } from "./types";

const COMPUTED_BY = "pattern-signpost:";
const ok = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what} failed: ${r.error.message}`);
  return r.data as T;
};

/** Write the signposts of the patterns found and score the ones a pattern's fall or key date decides. `facts` is the evidence rows by `table/pk`. Returns the counts. */
export async function trackPatterns(deps: { sb: Db; now: () => Date }, input: { dry: boolean; found: readonly Pattern[]; facts: ReadonlyMap<string, Fact> }): Promise<Record<string, number>> {
  const { sb } = deps;
  const now = deps.now();
  const counts = { signposts_new: 0, signposts_no_item: 0, signposts_held: 0, signposts_refuted: 0, signposts_open: 0 };
  const kinds = PATTERNS.signposts.kinds;
  const ids = kinds.map((k) => PATTERN_METHODS[k].id);
  const found = new Map(input.found.filter((p) => kinds.includes(p.kind)).map((p) => [patternSeed(p), p]));
  const standing = (row: string, due: string): boolean => [...input.facts.values()].some((f) => `${f.table}/${f.pk}` === row && f.due === due);
  const records = await allRows<{ inference_id: string; computed_by: string }>(sb, "inference_records", "inference_id,computed_by", { order: "inference_id", where: (q) => q.in("method_id", ids).like("computed_by", `${COMPUTED_BY}%`) });
  const rows = await fetchAllByIdChunks(records.map((r) => r.inference_id), async (slice) => ok(await sb.from("signposts").select("entity_id,inference_record_id,outcome,predicate").in("inference_record_id", slice), "reading the pattern signposts") as Array<{ entity_id: string; inference_record_id: string; outcome: string | null; predicate: { key_date?: string; key_row?: string } }>, { manyPerId: true });
  const seedOf = new Map(records.map((r) => [r.inference_id, r.computed_by.slice(COMPUTED_BY.length)]));
  const tracked = new Set(rows.map((r) => seedOf.get(r.inference_record_id)));
  for (const [seed, p] of found) {
    if (tracked.has(seed)) continue;
    const items = [...new Set(p.evidence.map((e) => input.facts.get(`${e.table}/${e.pk}`)?.item).filter((x): x is string => !!x))].sort();
    if (!items.length) {
      counts.signposts_no_item += 1;
      continue;
    }
    counts.signposts_new += 1;
    if (input.dry) continue;
    const [keyDate, keyRow] = [p.keyDue, p.evidence.find((e) => e.kind === "key") && `${p.evidence.find((e) => e.kind === "key")?.table}/${p.evidence.find((e) => e.kind === "key")?.pk}`];
    const sid = entityId("signpost", seed);
    ok(await sb.from("entities").upsert({ entity_id: sid, kind: "signpost", canonical_name: `pattern signpost ${seed}`, status: "active" } as never, { onConflict: "entity_id" }), "writing the signpost entity");
    const rec = ok(await sb.from("inference_records").insert({ subject_id: p.entity, claim_text: `${seed} stands${keyDate ? ` on ${keyDate}` : " while its evidence holds"}`, status_token: "HYPOTHESIS", confidence: PATTERNS[p.kind].confidence, cited_item_ids: items, origin_class: "derived", method_id: PATTERN_METHODS[p.kind].id, method_version: PATTERN_METHODS[p.kind].version, computed_by: `${COMPUTED_BY}${seed}` } as never).select("inference_id").single(), "writing the inference record") as { inference_id: string };
    ok(await sb.from("signposts").insert({ entity_id: sid, watches: p.entity, direction: PATTERNS.signposts.direction, inference_record_id: rec.inference_id, predicate: { op: "date_passed", field: "pattern_key_date", pattern: seed, ...(keyDate && keyRow ? { key_date: keyDate, key_row: keyRow } : {}) } } as never), "writing the signpost");
  }
  for (const r of rows.filter((x) => !x.outcome)) {
    const seed = seedOf.get(r.inference_record_id) as string;
    const { key_date: due, key_row: row } = r.predicate;
    const fell = due && row ? !standing(row, due) : !found.has(seed);
    const held = !fell && !!due && due <= now.toISOString().slice(0, 10);
    if (!fell && !held) {
      counts.signposts_open += 1;
      continue;
    }
    counts[fell ? "signposts_refuted" : "signposts_held"] += 1;
    if (!input.dry) ok(await sb.from("signposts").update({ ...(held ? { fired_at: now.toISOString(), lifecycle_applied_at: now.toISOString() } : {}), outcome: fell ? "refuted" : "held", outcome_assessed_at: now.toISOString(), scored_by: PATTERNS.signposts.scoredBy }).eq("entity_id", r.entity_id).is("outcome", null), "scoring the pattern signpost");
  }
  return counts;
}
