// Ported from old_repo/scripts/turns/needs-search/data.mjs (lines 1-165)
// Ported from old_repo/scripts/turns/needs-search/schema.mjs (lines 12-52)
// Ported from old_repo/scripts/turns/export-needs-for-search.mjs (lines 14-118)
// The needs a session finds source URLs for: open flags of four kinds (term need, holdings need, flywheel gap, lineage gap) as needs with a key that survives the flag being re-raised under a new id, the output each kind feeds,
// and the bar a URL must meet. A need whose key was already applied is "in flight", not exported again. The export is the drain's queue and the bundle file both.
import { createHash } from "node:crypto";

import type { Db } from "@/core/db";
import { LINEAGE_GAP_CREATED_BY, planLineageGapTargets } from "@/core/entities";
import { FLAG_COLUMNS, loadOpenNeedTargets, needOfFlag, OPEN_STATUSES, type NeedFlag } from "@/core/flags/need-targets";
import { GAP_NAMESPACE, HOLDINGS_NEED_NAMESPACE, TERM_NEED_NAMESPACE } from "@/core/flywheel/flags";
import { authorityFloorFor } from "@/core/grounding";
import { celexOf } from "@/core/vocabulary";
import { allRows, rowsByIds } from "@/core/db";

import { type BatchExport } from "../../kit/session-batch";

/** resolved_by of every flag the URL apply step closes: how the export finds a need already served. */
export const RESOLVED_BY = "apply-need-urls";
export type NeedKind = "term-need" | "holdings-need" | "flywheel-gap" | "lineage-gap";
/** What a found URL becomes, by need kind: a lineage parent is one instrument whose page is a ledger candidate; every other need is answered by a document the census should see. */
const OUTPUT_FOR_KIND: Readonly<Record<NeedKind, "census_worklist" | "portal_link_candidate">> = { "term-need": "census_worklist", "holdings-need": "census_worklist", "flywheel-gap": "census_worklist", "lineage-gap": "portal_link_candidate" };
const FLAG_COLUMNS_FULL = `${FLAG_COLUMNS}, resolved_by, resolution_note`;
export type FullFlag = NeedFlag & { resolved_by: string | null; resolution_note: string | null };

/** The need kind of an integrity_flags.created_by value, or null when it is not a need namespace. */
export function needKindOf(createdBy: unknown): NeedKind | null {
  const c = String(createdBy ?? "");
  return c.startsWith(TERM_NEED_NAMESPACE) ? "term-need" : c.startsWith(HOLDINGS_NEED_NAMESPACE) ? "holdings-need" : c.startsWith(GAP_NAMESPACE) ? "flywheel-gap" : c === LINEAGE_GAP_CREATED_BY ? "lineage-gap" : null;
}
/** The identity of a need that survives its flag being re-raised under a new id: kind, subject and the need text, whitespace collapsed. */
const needKey = (a: { kind: string; subject_ref: string; text: string }): string => createHash("sha256").update(`${a.kind}\u0000${a.subject_ref}\u0000${String(a.text ?? "").replace(/\s+/g, " ").trim().toLowerCase()}`).digest("hex").slice(0, 16);

export interface Need { need_id: string; kind: NeedKind; subject_ref: string | null; text: string; key: string; created_at: string | null; context: Record<string, unknown>; output: "census_worklist" | "portal_link_candidate"; satisfies: Record<string, unknown> }

const USED_FOR = { census_worklist: "the URL becomes a census_worklist row tied to the source registered for its host, so the mint reads it", portal_link_candidate: "the URL becomes a portal_link_candidates row tied to the source registered for its host, so the ledger consume classifies it" } as const;
/** What satisfies a need of this kind: one authoritative URL at or above the authority floor of the item type that would hold it, rated from its host by the class table (never a tier in the batch). */
const satisfiesFor = (kind: NeedKind): Need["satisfies"] => ({
  requirement: "one authoritative URL: a page of the institution that publishes the thing the need names, at or above the authority floor of the item type that would hold it",
  tier_floors: { regulation_family: authorityFloorFor("regulation"), research_finding: authorityFloorFor("research_finding"), technology_family: authorityFloorFor("technology"), other_types: "any rated source" },
  rating: "the source is rated from its host by the institution class table; an unrated host needs a host_verdict (host, class, evidence, verdict_source, generated_at); the tier is never written in the batch",
  output: OUTPUT_FOR_KIND[kind], used_for: USED_FOR[OUTPUT_FOR_KIND[kind]],
});

/** The marker recorded in the resolution_note of a flag the apply closes (the export reads it back). */
export const buildAppliedNote = (a: { key: string; url: string; sourceId: string; tier: number; kind: string; output: string; batch: string }): string => `need-url applied: need_key=${a.key} url=${a.url} source_id=${a.sourceId} tier=${a.tier} kind=${a.kind} output=${a.output} batch=${a.batch}`;
export function parseAppliedNote(note: unknown): { key: string; url: string } | null {
  const text = String(note ?? "");
  if (!text.startsWith("need-url applied:")) return null;
  const [key, url] = [/(?:^|\s)need_key=(\S+)/.exec(text), /(?:^|\s)url=(\S+)/.exec(text)];
  return key && url ? { key: key[1] as string, url: url[1] as string } : null;
}

/** One flag as a need, or a skip reason. `lineageTargets` maps a lineage flag id to its absent parents. */
export function needFromFlag(flag: Pick<NeedFlag, "id" | "subject_ref" | "created_by" | "description" | "recommended_actions" | "created_at">, lineageTargets: ReadonlyMap<string, { identifier: string; relationship: string }[]> = new Map()): { need: Need } | { skip: string } {
  const kind = needKindOf(flag.created_by);
  if (!kind) return { skip: "not a need namespace" };
  let text: string;
  let context: Record<string, unknown>;
  if (kind === "term-need" || kind === "holdings-need") {
    const n = needOfFlag(flag);
    if (!n) return { skip: "no structured find-source need in recommended_actions" };
    text = n.need;
    context = kind === "term-need" ? { term_kind: n.kind ?? null, term_id: flag.subject_ref ?? null } : { item_id: n.item_id, surface: n.surface, product_question: n.product_question };
  } else if (kind === "flywheel-gap") {
    text = String(flag.description ?? "").replace(/\s+/g, " ").trim();
    if (!text) return { skip: "gap flag has no description" };
    context = { gap_type: String(flag.created_by).slice(GAP_NAMESPACE.length), theme_id: flag.subject_ref ?? null };
  } else {
    const absent = lineageTargets.get(flag.id) ?? [];
    if (!absent.length) return { skip: "no absent parent (every named parent is held, or the flag names none)" };
    text = `Parent instrument absent from holdings: ${absent.map((a) => `${a.identifier} (${a.relationship})`).join("; ")}`;
    context = { citing_item_id: flag.subject_ref ?? null, identifiers: absent.map((a) => a.identifier), celex: absent.map((a) => celexOf(a.identifier)).filter(Boolean) };
  }
  return { need: { need_id: flag.id, kind, subject_ref: flag.subject_ref ?? null, text, key: needKey({ kind, subject_ref: flag.subject_ref ?? "", text }), created_at: flag.created_at ?? null, context, output: OUTPUT_FOR_KIND[kind], satisfies: satisfiesFor(kind) } };
}

/** The held corpus the lineage planner resolves parents against (non-archived items). One capped read under a total order. */
const loadCorpus = (sb: Db) => allRows<{ id: string; title: string | null; instrument_identifier: string | null }>(sb, "intelligence_items", "id, title, instrument_identifier", { cap: 500_000, where: (q) => q.eq("is_archived", false) });
/** Absent lineage parents grouped by flag id. */
function lineageTargetsByFlag(lineageFlags: readonly NeedFlag[], corpus: readonly { id: string; title: string | null; instrument_identifier: string | null }[]): Map<string, { identifier: string; relationship: string }[]> {
  const out = new Map<string, { identifier: string; relationship: string }[]>();
  for (const t of planLineageGapTargets(lineageFlags as never, corpus as never).targets) out.set(t.flag_id, [...(out.get(t.flag_id) ?? []), { identifier: t.identifier, relationship: t.relationship }]);
  return out;
}
export const loadLineageTargets = async (sb: Db, lineageFlags: readonly NeedFlag[]) => (lineageFlags.length ? lineageTargetsByFlag(lineageFlags, await loadCorpus(sb)) : new Map<string, { identifier: string; relationship: string }[]>());

/** Every open need of the four kinds as needs, oldest first, with what was skipped and why. */
async function collectOpenNeeds(sb: Db): Promise<{ needs: Need[]; residue: { flag_id: string; kind: string | null; reason: string }[]; counts: { open_by_kind: Record<string, number>; skipped_no_absent_parent: number; unparseable: number } }> {
  const [held, gaps, lineage] = [
    await loadOpenNeedTargets(sb, { includeTermNeeds: true }),
    await allRows<NeedFlag>(sb, "integrity_flags", FLAG_COLUMNS, { where: (q) => q.like("created_by", `${GAP_NAMESPACE}%`).in("status", [...OPEN_STATUSES]) }),
    await allRows<NeedFlag>(sb, "integrity_flags", FLAG_COLUMNS, { where: (q) => q.eq("created_by", LINEAGE_GAP_CREATED_BY).in("status", [...OPEN_STATUSES]) }),
  ];
  const lineageTargets = await loadLineageTargets(sb, lineage);
  const counts = { open_by_kind: {} as Record<string, number>, skipped_no_absent_parent: 0, unparseable: 0 };
  const needs: Need[] = [];
  const residue: { flag_id: string; kind: string | null; reason: string }[] = [];
  for (const f of [...held, ...gaps, ...lineage]) {
    const kind = needKindOf(f.created_by);
    counts.open_by_kind[String(kind)] = (counts.open_by_kind[String(kind)] ?? 0) + 1;
    const r = needFromFlag(f, lineageTargets);
    if ("need" in r) needs.push(r.need);
    else if (kind === "lineage-gap") counts.skipped_no_absent_parent += 1;
    else {
      counts.unparseable += 1;
      residue.push({ flag_id: f.id, kind, reason: r.skip });
    }
  }
  const age = (n: Need) => (n.created_at ? Date.parse(n.created_at) : Number.MAX_SAFE_INTEGER);
  return { needs: needs.sort((a, b) => age(a) - age(b) || (a.need_id < b.need_id ? -1 : a.need_id > b.need_id ? 1 : 0)), residue, counts };
}
/** The need keys the apply step already served (resolved flags it closed), mapped to the url applied. */
async function loadAppliedKeys(sb: Db): Promise<Map<string, string>> {
  const rows = await allRows<FullFlag>(sb, "integrity_flags", FLAG_COLUMNS_FULL, { where: (q) => q.eq("resolved_by", RESOLVED_BY).eq("status", "resolved") });
  const out = new Map<string, string>();
  for (const r of rows) {
    const n = parseAppliedNote(r.resolution_note);
    if (n) out.set(n.key, n.url);
  }
  return out;
}
/** The named flags with their resolution fields, whatever their state. */
export const loadFlagsByIds = (sb: Db, ids: readonly string[]): Promise<FullFlag[]> => (ids.length ? rowsByIds<FullFlag>(sb, "integrity_flags", FLAG_COLUMNS_FULL, ids) : Promise.resolve([]));

/** The export: the open needs not already served, within the limit, with a summary of what was skipped. */
export function needsExporter(sb: Db) {
  return async ({ limit }: { limit: number }): Promise<BatchExport> => {
    try {
      const { needs, residue, counts } = await collectOpenNeeds(sb);
      const applied = await loadAppliedKeys(sb);
      const listed: Need[] = [];
      let inFlight = 0;
      let overLimit = 0;
      for (const n of needs) {
        if (applied.has(n.key)) inFlight += 1;
        else if (listed.length >= limit) overLimit += 1;
        else listed.push(n);
      }
      const byKind: Record<string, number> = {};
      for (const n of listed) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
      return { ok: true, items: listed as never, source: { type: "table", table: "integrity_flags" }, residue, summary: { open_needs_by_kind: counts.open_by_kind, open_needs: Object.values(counts.open_by_kind).reduce((a, b) => a + b, 0), needs_exported: listed.length, needs_exported_by_kind: byKind, skipped_url_in_flight: inFlight, skipped_no_absent_parent: counts.skipped_no_absent_parent, unparseable: counts.unparseable, not_examined_over_limit: overLimit } };
    } catch (e) {
      return { ok: false, items: [], error: (e as Error).message };
    }
  };
}
