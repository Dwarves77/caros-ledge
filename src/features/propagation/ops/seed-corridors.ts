// Ported from old_repo/scripts/entities/seed-corridors.mjs (lines 8-314)
// Ported from old_repo/scripts/entities/write-entity-scope.mjs (lines 8-150)
// Corridor entities from the confirmed seeds (data/corridor-seeds.json: the ADR-024 worked example and three Drewry WCI lanes) plus any corridor a market
// series or regional fact names by the `corridor:ORIGIN-DEST:mode` convention, a display_name backfill, and the corridor-to-jurisdiction entity_scope rows
// (the UN/LOCODE prefix is the ISO 3166-1 country). The always-empty "item jurisdictions" candidate scan is gone. The corridor-scope cache tag is invalidated
// after a write, so the Market selector and the Regulations strip see the new corridor without waiting out the TTL (B-1559). A runtime function: no CLI.
import { revalidateTag } from "next/cache";
import { z } from "zod";

import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import { CORRIDOR_SCOPE_TAG } from "@/core/entities/corridor-scope";
import { entityId, corridorSeed } from "@/core/entities/id";
import { parseCorridorName } from "@/core/entities/kinds";
import { planJurisdiction } from "@/core/entities/plan";
import { formatCorridorLabel } from "@/core/entities/unlocode-names";
import type { RunResult } from "@/core/sources/run-result";

import seedsJson from "./data/corridor-seeds.json";

const seeds = z.object({ seeds: z.array(z.object({ origin: z.string(), dest: z.string(), mode: z.string(), note: z.string(), sourceUrl: z.string() })) }).parse(seedsJson).seeds;
const RELATION_CORRIDOR_JURISDICTION = "touches_jurisdiction";
const ATTRIBUTED_BY = "rule:corridor-jurisdiction-unlocode-v1";
const CONVENTION_RE = /^corridor:([A-Za-z]{2}[A-Za-z2-9]{3})-([A-Za-z]{2}[A-Za-z2-9]{3}):([a-z_]+)$/;

export interface CorridorCandidate {
  origin: string;
  dest: string;
  mode: string;
  note?: string;
  sourceUrl?: string;
  source?: string;
}
function parseCorridorConvention(text: unknown): CorridorCandidate | null {
  const m = CONVENTION_RE.exec(String(text ?? "").trim());
  return m ? { origin: (m[1] as string).toUpperCase(), dest: (m[2] as string).toUpperCase(), mode: m[3] as string } : null;
}
/** The derived candidates (de-duplicated), or the confirmed seeds when no live data names a corridor pair. */
function resolveCorridorCandidates(input: { marketSeries?: readonly { series_key?: string }[]; regionalFacts?: readonly { fact_label?: string }[] }): { candidates: CorridorCandidate[]; usingFallback: boolean } {
  const derived: CorridorCandidate[] = [];
  for (const r of input.marketSeries ?? []) {
    const hit = parseCorridorConvention(r.series_key);
    if (hit) derived.push({ ...hit, source: `market_series:${r.series_key}` });
  }
  for (const r of input.regionalFacts ?? []) {
    const hit = parseCorridorConvention(r.fact_label);
    if (hit) derived.push({ ...hit, source: `regional_data_facts:${r.fact_label}` });
  }
  const unique = new Map<string, CorridorCandidate>();
  for (const c of derived) if (!unique.has(`${c.origin}-${c.dest}:${c.mode}`)) unique.set(`${c.origin}-${c.dest}:${c.mode}`, c);
  return unique.size ? { candidates: [...unique.values()], usingFallback: false } : { candidates: seeds.map((s) => ({ ...s })), usingFallback: true };
}

function planCorridorEntities(candidates: readonly CorridorCandidate[], existing: ReadonlySet<string>): { entities: { entity_id: string; kind: "corridor"; canonical_name: string; display_name: string; status: "active" }[]; skipped: { candidate: CorridorCandidate; reason: string }[] } {
  const entities: ReturnType<typeof planCorridorEntities>["entities"] = [];
  const skipped: ReturnType<typeof planCorridorEntities>["skipped"] = [];
  for (const c of candidates) {
    try {
      const seed = corridorSeed(c);
      const id = entityId("corridor", seed);
      if (!existing.has(id) && !entities.some((e) => e.entity_id === id)) entities.push({ entity_id: id, kind: "corridor", canonical_name: seed, display_name: formatCorridorLabel(c), status: "active" });
    } catch (e) {
      skipped.push({ candidate: c, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { entities, skipped };
}
function planDisplayNameBackfill(rows: readonly { entity_id: string; canonical_name: string; display_name?: string | null }[]): { entity_id: string; display_name: string }[] {
  const out: { entity_id: string; display_name: string }[] = [];
  for (const r of rows) {
    const p = r.display_name ? null : parseCorridorName(r.canonical_name);
    if (p) out.push({ entity_id: r.entity_id, display_name: formatCorridorLabel(p) });
  }
  return out;
}
/** Corridor-to-country pairs: the first two letters of each UN/LOCODE endpoint are the ISO 3166-1 country. */
function deriveCorridorJurisdictionCodes(corridors: readonly { entity_id: string; canonical_name: string }[]): { isoCodes: string[]; pairs: { corridorEntityId: string; iso: string }[]; skipped: { entity_id: string; reason: string }[] } {
  const isoSet = new Set<string>();
  const seen = new Set<string>();
  const pairs: { corridorEntityId: string; iso: string }[] = [];
  const skipped: { entity_id: string; reason: string }[] = [];
  for (const c of corridors) {
    const p = parseCorridorName(c.canonical_name);
    if (!p) {
      skipped.push({ entity_id: c.entity_id, reason: "canonical_name does not match the ORIGIN-DEST:mode convention" });
      continue;
    }
    for (const locode of [p.origin, p.dest]) {
      const iso = locode.slice(0, 2);
      isoSet.add(iso);
      if (!seen.has(`${c.entity_id}|${iso}`)) {
        seen.add(`${c.entity_id}|${iso}`);
        pairs.push({ corridorEntityId: c.entity_id, iso });
      }
    }
  }
  return { isoCodes: [...isoSet].sort(), pairs, skipped };
}

const all = <T>(sb: Db, table: string, columns: string, order: string, kind?: string) =>
  fetchAllRows<T>((from, to) => {
    const base = sb.from(table).select(columns);
    return (kind ? base.eq("kind", kind) : base).order(order, { ascending: true }).range(from, to) as unknown as PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  }, { cap: 500_000 });

export async function seedCorridors(deps: { sb: Db; now: () => Date }, input: { dry: boolean }): Promise<RunResult> {
  const { sb } = deps;
  const [marketSeries, regionalFacts, corridors] = await Promise.all([
    all<{ series_key: string }>(sb, "market_series", "series_key", "series_key"),
    all<{ fact_label: string }>(sb, "regional_data_facts", "fact_label", "fact_label"),
    all<{ entity_id: string; canonical_name: string; display_name: string | null }>(sb, "entities", "entity_id, canonical_name, display_name", "entity_id", "corridor"),
  ]);
  const { candidates, usingFallback } = resolveCorridorCandidates({ marketSeries, regionalFacts });
  const { entities, skipped } = planCorridorEntities(candidates, new Set(corridors.map((c) => c.entity_id)));
  const backfill = planDisplayNameBackfill(corridors);
  const notes: string[] = skipped.map((s) => `skipped ${JSON.stringify(s.candidate)}: ${s.reason}`);
  if (usingFallback) notes.push("no live data names a corridor pair: the confirmed seeds are used");
  const counts: Record<string, number> = { candidates: candidates.length, to_create: entities.length, skipped: skipped.length, display_name_backfill: backfill.length, created: 0, labelled: 0, scope_rows: 0, jurisdictions_created: 0, failed: 0 };
  if (!input.dry) {
    if (entities.length) {
      const { error } = await sb.from("entities").insert(entities);
      if (error) {
        counts.failed = (counts.failed ?? 0) + 1;
        notes.push(`corridor insert failed: ${error.message}`);
      } else counts.created = entities.length;
    }
    for (const b of backfill) {
      const { error } = await sb.from("entities").update({ display_name: b.display_name }).eq("entity_id", b.entity_id);
      if (error) {
        counts.failed = (counts.failed ?? 0) + 1;
        notes.push(`display_name backfill failed for ${b.entity_id}: ${error.message}`);
      } else counts.labelled = (counts.labelled ?? 0) + 1;
    }
  }
  // Scope: every active corridor (the ones just seeded included when applying) to its two countries.
  const live = input.dry ? corridors.concat(entities.map((e) => ({ entity_id: e.entity_id, canonical_name: e.canonical_name, display_name: e.display_name }))) : await all<{ entity_id: string; canonical_name: string; display_name: string | null }>(sb, "entities", "entity_id, canonical_name, display_name", "entity_id", "corridor");
  const { isoCodes, pairs, skipped: parseSkipped } = deriveCorridorJurisdictionCodes(live);
  notes.push(...parseSkipped.map((s) => `corridor ${s.entity_id}: ${s.reason}`));
  const [jurisdictions, identifiers, scope] = await Promise.all([
    all<{ entity_id: string }>(sb, "entities", "entity_id", "entity_id", "jurisdiction"),
    all<{ entity_id: string; scheme: string; value: string }>(sb, "entity_identifiers", "entity_id, scheme, value", "entity_id"),
    all<{ subject_id: string; scope_id: string; relation: string }>(sb, "entity_scope", "subject_id, scope_id, relation", "subject_id"),
  ]);
  const plan = planJurisdiction(isoCodes, { existingEntityIds: new Set(jurisdictions.map((j) => j.entity_id)), existingIdentifierKeys: new Set(identifiers.map((r) => `${r.entity_id}|${r.scheme}|${r.value}`)), assertedBy: "ops/seed-corridors", now: deps.now() });
  const have = new Set(scope.map((r) => `${r.subject_id}|${r.scope_id}|${r.relation}`));
  const scopeRows = pairs.flatMap(({ corridorEntityId, iso }) => {
    const scope_id = plan.byCode.get(iso) ?? entityId("jurisdiction", iso);
    const key = `${corridorEntityId}|${scope_id}|${RELATION_CORRIDOR_JURISDICTION}`;
    if (have.has(key)) return [];
    have.add(key);
    return [{ subject_id: corridorEntityId, scope_id, relation: RELATION_CORRIDOR_JURISDICTION, confidence: 1.0, attributed_to: ATTRIBUTED_BY }];
  });
  counts.scope_rows_planned = scopeRows.length;
  if (!input.dry) {
    const writes: [string, unknown[]][] = [["entities", plan.entities], ["entity_identifiers", plan.identifiers], ["entity_scope", scopeRows]];
    for (const [table, rows] of writes) {
      if (!rows.length) continue;
      const { error } = await sb.from(table).insert(rows);
      if (error) {
        counts.failed = (counts.failed ?? 0) + 1;
        notes.push(`${table} insert failed: ${error.message}`);
      } else if (table === "entity_scope") counts.scope_rows = rows.length;
      else if (table === "entities") counts.jurisdictions_created = rows.length;
    }
    if (counts.created || counts.labelled || counts.scope_rows) {
      try {
        revalidateTag(CORRIDOR_SCOPE_TAG, "max");
      } catch {
        notes.push("corridor-scope cache tag not flushed (no request scope); the cache expires on its TTL");
      }
    }
  }
  return { counts, outcome: counts.failed ? ((counts.created ?? 0) + (counts.scope_rows ?? 0) > 0 ? "partial" : "failed") : "ok", notes: input.dry ? [...notes, "dry: nothing written"] : notes };
}
