// Ported from old_repo/scripts/producers/regional/state-cost-facts-producer.mjs (lines 17-233)
// Ported from old_repo/src/lib/regional/state-cost-facts-envelope.mjs (lines 1-109)
// US state cost facts (minimum wage, industrial electricity). Each candidate is grounded verbatim in its own capture BEFORE its host is rated by the class table; an
// ungrounded or unrated candidate is refused by name. A write authors the jurisdiction entity, identifier and ref of every state touched (rule 17). HELD: enabled false.
import { z } from "zod";

import { groundCandidate } from "@/core/contracts";
import { fetchAllRows, type Db } from "@/core/db";
import { planJurisdiction, planJurisdictionRefs, regionCodes } from "@/core/entities";
import { loadRowsFile, registerCitedSource } from "@/core/producers/rows-file";
import type { ParseOut, ProducerCtx, ProducerSpec } from "@/core/producers/runner";
import { keyOf, type Rec } from "@/core/producers/upsert-plan";
import { hostOf } from "@/core/shared";
import { classTierForHost } from "@/core/sources";

const candidate = z.object({
  state_code: z.string().min(2), state_label: z.string().min(1), region_code: z.string().min(1), dimension: z.string().min(1), fact_label: z.string().min(1),
  value: z.union([z.string(), z.number()]), unit: z.string().nullish(), trend: z.string().nullish(), statute_citation: z.string().nullish(), effective_date: z.string().nullish(),
  source_url: z.string().url(), source_name: z.string().nullish(), span_text: z.string().nullish(),
});
export type StateCostCandidate = z.infer<typeof candidate>;

/** Official for tiers 1-3, verified for tier 4; a lower tier carries no origin class (null), never a promoted one. */
export const originClassForTier = (tier: unknown): "official" | "verified" | null => (typeof tier !== "number" || !Number.isFinite(tier) ? null : tier >= 1 && tier <= 3 ? "official" : tier === 4 ? "verified" : null);
export function parseNumericValue(value: unknown): number | null {
  const s = String(value ?? "").trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}
export const naturalKey = (r: Rec): string | null => keyOf([r.state_code, r.dimension, r.fact_label]);
const UPDATE_FIELDS = ["value", "value_numeric", "unit", "trend", "source_id", "statute_citation", "effective_date", "origin_class"] as const;

export function buildStateCostFactRow(c: StateCostCandidate, source: { source_id: string | null; tier: number | null }, regionId: string | null): Rec {
  return { region_id: regionId, state_code: c.state_code, state_label: c.state_label, dimension: c.dimension, fact_label: c.fact_label, value: String(c.value), value_numeric: parseNumericValue(c.value), unit: c.unit ?? null, trend: c.trend ?? null, source_id: source.source_id, statute_citation: c.statute_citation ?? null, effective_date: c.effective_date ?? null, origin_class: originClassForTier(source.tier) };
}

export const stateCostFacts: ProducerSpec = {
  name: "state-cost-facts",
  table: "state_cost_facts",
  licenceKey: null,
  enabled: false,
  enabledRuling: "R14 hold (operator 2026-09-25 'build the producer'; no population before every layer, 2026-10-04): proven on fixtures only",
  killSwitchEnv: null,
  gap: "no state cost candidates supplied; the input is a session-authored candidates file",
  async fetchDoc() {
    return { text: "" };
  },
  async parse(doc, ctx: ProducerCtx): Promise<ParseOut<Rec>> {
    const warnings: string[] = [];
    const rows: Rec[] = [];
    const meta: Record<string, { code: string; url: string; title: string }> = {};
    for (const raw of loadRowsFile(doc.text ?? "", "state cost candidates")) {
      const p = candidate.safeParse(raw);
      if (!p.success) {
        warnings.push(`candidate refused: ${p.error.issues[0]?.message ?? "malformed"}`);
        continue;
      }
      const c = p.data;
      const id = `${c.state_code}|${c.dimension}|${c.fact_label}`;
      const g = groundCandidate({ span_text: c.span_text ?? null }, await ctx.get(c.source_url).then((r) => r.text(), () => null));
      if (!g.ok) {
        warnings.push(`${id}: refused_ungrounded: ${g.reason}`);
        continue;
      }
      const tier = classTierForHost(hostOf(c.source_url), c.source_name ?? null);
      if (tier == null) {
        warnings.push(`${id}: refused_unrated_source: host does not resolve to a codified class; ambiguous hosts are worklisted, never guessed a tier`);
        continue;
      }
      const row = buildStateCostFactRow(c, { source_id: null, tier }, null);
      rows.push(row);
      meta[naturalKey(row) as string] = { code: c.region_code, url: c.source_url, title: c.source_name ?? c.source_url };
    }
    ctx.state.meta = meta;
    return { rows, warnings };
  },
  /** Apply only: rate the source through the registry and resolve the region id; an unknown region fails the run (never guessed). */
  async resolve(ctx, rows) {
    const sb = ctx.sb as Db;
    const meta = ctx.state.meta as Record<string, { code: string; url: string; title: string }>;
    const regions = await regionCodes(sb);
    const byCode = new Map(regions.map((r) => [r.code, r.id]));
    const missing = [...new Set(Object.values(meta).map((m) => m.code))].filter((c) => !byCode.has(c));
    if (missing.length) throw new Error(`region code(s) not found in the live regions table: ${missing.join(", ")}`);
    const kept: Rec[] = [];
    const refused: string[] = [];
    for (const r of rows) {
      const m = meta[naturalKey(r) as string] as { code: string; url: string; title: string };
      const reg = await registerCitedSource({ url: m.url, title: m.title }, { sb });
      if (reg.refused) refused.push(`${naturalKey(r)}: ${reg.reason}`);
      else kept.push({ ...r, region_id: byCode.get(m.code), source_id: reg.source_id, origin_class: originClassForTier(reg.tier) });
    }
    return { rows: kept, refused };
  },
  plan: {
    read: (sb, rows) => fetchAllRows<Rec>((from, to) => sb.from("state_cost_facts").select(["id", "state_code", "dimension", "fact_label", ...UPDATE_FIELDS].join(", ")).in("state_code", [...new Set(rows.map((r) => String(r.state_code)))]).order("id", { ascending: true }).range(from, to) as never, { cap: 50_000 }),
    key: naturalKey,
    patchable: UPDATE_FIELDS,
    pk: "id",
  },
  /** Rule 17: the jurisdiction entity, identifier and ref of every state written, planned by the entity planners and inserted (idempotent against what exists). */
  async after(ctx, written) {
    const sb = ctx.sb as Db;
    const codes = [...new Set([...written.created, ...written.updated].map((r) => String(r.state_code)))];
    if (!codes.length) return { entities_written: 0, refs_written: 0 };
    const facts = await fetchAllRows<{ id: string; state_code: string }>((from, to) => sb.from("state_cost_facts").select("id, state_code").in("state_code", codes).order("id", { ascending: true }).range(from, to) as never, { cap: 50_000 });
    const asserted = "producer:state-cost-facts";
    const ids = new Set<string>();
    const idents = new Set<string>();
    const refKeys = new Set<string>();
    const have = async <T extends Rec>(table: string, cols: string): Promise<T[]> => fetchAllRows<T>((from, to) => sb.from(table).select(cols).order(cols.split(",")[0] as string, { ascending: true }).range(from, to) as never, { cap: 500_000 });
    for (const e of await have<{ entity_id: string }>("entities", "entity_id")) ids.add(e.entity_id);
    for (const i of await have<{ entity_id: string; scheme: string; value: string }>("entity_identifiers", "entity_id, scheme, value")) idents.add(`${i.entity_id}|${i.scheme}|${i.value}`);
    for (const r of await have<{ ref_table: string; ref_id: string; entity_id: string; role: string }>("entity_refs", "ref_table, ref_id, entity_id, role")) refKeys.add(`${r.ref_table}|${r.ref_id}|${r.entity_id}|${r.role}`);
    const plan = planJurisdiction(codes, { existingEntityIds: ids, existingIdentifierKeys: idents, assertedBy: asserted, now: ctx.now() });
    const refs = planJurisdictionRefs("state_cost_facts", facts.map((f) => ({ id: f.id, jurisdiction_iso: [f.state_code] })), plan.byCode, refKeys, asserted);
    for (const [table, list] of [["entities", plan.entities], ["entity_identifiers", plan.identifiers], ["entity_refs", refs]] as const) {
      if (!list.length) continue;
      const { error } = await sb.from(table).insert(list as never);
      if (error) throw new Error(`insert into ${table} failed: ${error.message}`);
    }
    return { entities_written: plan.entities.length, refs_written: refs.length };
  },
};
