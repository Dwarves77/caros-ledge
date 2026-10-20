// Ported from old_repo/src/lib/entities/lineage-backfill.mjs (lines 1-214)
// ADR-022 / INV-206: a machine lineage write never changes a manual-origin edge, never downgrades a typed relationship to related, never retypes a
// foreign-origin edge that already holds a different type (reported as a conflict, not written), merges basis entries additively, and never
// re-creates an admin-tombstoned pair. The one change it makes to another machine origin's row is upgrading a generic related edge to a typed one.
import { isPairTombstoned } from "@/core/corrections";

import { resolveMention, type CorpusRow } from "./mentions";

const LINEAGE_BACKFILL_ORIGIN = "entity_extraction";
export const LINEAGE_GAP_CREATED_BY = "lineage-gap:absent-parent";
const MANUAL_ORIGIN = "manual";

export interface EdgeRowLike {
  id?: string;
  source_item_id: string;
  target_item_id: string;
  relationship: string;
  origin?: string;
  basis?: unknown;
}
export interface EdgeWrite {
  table: string;
  row: EdgeRowLike;
}
interface Pair {
  source_item_id: string;
  target_item_id: string;
}

export const pairKey = (source: string, target: string): string => `${source}|${target}`;
const byPair = (a: Pair, b: Pair): number => pairKey(a.source_item_id, a.target_item_id).localeCompare(pairKey(b.source_item_id, b.target_item_id));
const isTyped = (relationship: unknown): boolean => typeof relationship === "string" && relationship !== "related";
const basisList = (b: unknown): { signal?: string; detail?: unknown }[] => (Array.isArray(b) ? b : []);
const basisKey = (e: { signal?: string; detail?: unknown } | undefined): string => `${e?.signal ?? ""}|${e?.detail ?? ""}`;

function appendBasis(existing: unknown, incoming: unknown): { merged: unknown[]; added: number } {
  const merged = basisList(existing).slice();
  const seen = new Set(merged.map(basisKey));
  let added = 0;
  for (const e of basisList(incoming)) {
    if (seen.has(basisKey(e))) continue;
    seen.add(basisKey(e));
    merged.push(e);
    added += 1;
  }
  return { merged, added };
}

export interface Partition {
  inserts: EdgeRowLike[];
  upgrades: { id?: string; source_item_id: string; target_item_id: string; relationship: string; basis: unknown[]; origin: string | undefined; prior_relationship: string; basis_added: number }[];
  skippedForeign: (Pair & { foreignOrigin?: string })[];
  conflicts: (Pair & { foreignOrigin?: string; existingRelationship: string; claimedRelationship: string })[];
  unchanged: (Pair & { id?: string })[];
  skippedTombstoned: Pair[];
}

/** Decide, for each planned edge write, whether it inserts, upgrades, is skipped (manual or generic claim on a foreign row), conflicts, is a no-op or is tombstoned. */
export function partitionLineageWrites(writes: readonly EdgeWrite[], existingByPair: ReadonlyMap<string, EdgeRowLike> | undefined, tombstones: Set<string> | undefined): Partition {
  const out: Partition = { inserts: [], upgrades: [], skippedForeign: [], conflicts: [], unchanged: [], skippedTombstoned: [] };
  for (const w of writes.filter((x) => x && x.table === "item_cross_references")) {
    const row = w.row;
    const existing = existingByPair?.get(pairKey(row.source_item_id, row.target_item_id));
    const pair: Pair = { source_item_id: row.source_item_id, target_item_id: row.target_item_id };
    if (isPairTombstoned(tombstones, row.source_item_id, row.target_item_id)) {
      out.skippedTombstoned.push(pair);
      continue;
    }
    if (!existing) {
      out.inserts.push(row);
      continue;
    }
    const own = existing.origin === LINEAGE_BACKFILL_ORIGIN;
    if (existing.origin === MANUAL_ORIGIN) {
      out.skippedForeign.push({ ...pair, foreignOrigin: existing.origin });
      continue;
    }
    if (!isTyped(row.relationship)) {
      if (own) out.unchanged.push({ id: existing.id as string, ...pair });
      else out.skippedForeign.push({ ...pair, foreignOrigin: existing.origin as string });
      continue;
    }
    if (isTyped(existing.relationship) && existing.relationship !== row.relationship && !own) {
      out.conflicts.push({ ...pair, foreignOrigin: existing.origin as string, existingRelationship: existing.relationship, claimedRelationship: row.relationship });
      continue;
    }
    const sameType = existing.relationship === row.relationship;
    if (sameType && !own) {
      out.unchanged.push({ id: existing.id as string, ...pair });
      continue;
    }
    const { merged, added } = appendBasis(existing.basis, row.basis);
    if (sameType && added === 0) {
      out.unchanged.push({ id: existing.id as string, ...pair });
      continue;
    }
    out.upgrades.push({ id: existing.id as string, ...pair, relationship: row.relationship, basis: merged, origin: existing.origin, prior_relationship: existing.relationship, basis_added: added });
  }
  out.inserts.sort(byPair);
  for (const k of ["upgrades", "skippedForeign", "conflicts", "unchanged", "skippedTombstoned"] as const) (out[k] as Pair[]).sort(byPair);
  return out;
}

const GAP_ACTION_RE = /^item (\w+) (.+), which does not resolve to any item in the corpus$/;
const GAP_DESC_ITEM_RE = /([^,():]+?) \((\w+)\)(?:,|$)/g;

/** The (relationship, identifier) pairs a lineage-gap flag names, from its actions or (older flags) its description. */
function parseLineageGapFlag(flag: { recommended_actions?: unknown; description?: string | null }): { relationship: string; identifier: string }[] {
  const out: { relationship: string; identifier: string }[] = [];
  const actions = Array.isArray(flag?.recommended_actions) ? (flag.recommended_actions as { rationale?: unknown }[]) : [];
  for (const a of actions) {
    const m = GAP_ACTION_RE.exec(String(a?.rationale ?? ""));
    if (m) out.push({ relationship: m[1] as string, identifier: (m[2] as string).trim() });
  }
  if (out.length) return out;
  const desc = String(flag?.description ?? "");
  const idx = desc.indexOf(": ");
  if (idx === -1) return out;
  for (const m of desc.slice(idx + 2).matchAll(GAP_DESC_ITEM_RE)) out.push({ identifier: (m[1] as string).trim(), relationship: m[2] as string });
  return out;
}

export interface GapFlag {
  id: string;
  subject_ref?: string | null;
  created_by?: string;
  description?: string | null;
  recommended_actions?: unknown;
}
/** For each open lineage-gap flag: the identifiers still absent from the corpus (acquisition targets) or, when every parent is now held, the flag is resolvable. */
export function planLineageGapTargets(openFlags: readonly GapFlag[], corpus: readonly CorpusRow[]): {
  targets: { identifier: string; relationship: string; citing_item_id: string; flag_id: string }[];
  resolvable: { flag_id: string; citing_item_id: string; parents: { relationship: string; identifier: string; parent_item_ids: string[] }[] }[];
  residue: { flag_id: string; citing_item_id: string | null; reason: string }[];
} {
  const targets: { identifier: string; relationship: string; citing_item_id: string; flag_id: string }[] = [];
  const resolvable: { flag_id: string; citing_item_id: string; parents: { relationship: string; identifier: string; parent_item_ids: string[] }[] }[] = [];
  const residue: { flag_id: string; citing_item_id: string | null; reason: string }[] = [];
  for (const flag of openFlags) {
    if (!flag || typeof flag.id !== "string") continue;
    if (flag.created_by !== undefined && flag.created_by !== LINEAGE_GAP_CREATED_BY) continue;
    const citing = typeof flag.subject_ref === "string" && flag.subject_ref ? flag.subject_ref : null;
    const mentions = parseLineageGapFlag(flag);
    if (!citing || !mentions.length) {
      residue.push({ flag_id: flag.id, citing_item_id: citing, reason: !citing ? "flag has no subject_ref" : "flag names no parseable parent instrument" });
      continue;
    }
    const held: { relationship: string; identifier: string; parent_item_ids: string[] }[] = [];
    const absent: { relationship: string; identifier: string }[] = [];
    for (const m of mentions) {
      const r = resolveMention({ kind: "identifier", value: m.identifier, canonical: m.identifier }, corpus, citing);
      if (r.count >= 1) held.push({ ...m, parent_item_ids: r.ids.slice().sort() });
      else absent.push(m);
    }
    for (const m of absent) targets.push({ identifier: m.identifier, relationship: m.relationship, citing_item_id: citing, flag_id: flag.id });
    if (!absent.length) resolvable.push({ flag_id: flag.id, citing_item_id: citing, parents: held });
  }
  targets.sort((a, b) => `${a.citing_item_id}|${a.identifier}`.localeCompare(`${b.citing_item_id}|${b.identifier}`));
  resolvable.sort((a, b) => a.flag_id.localeCompare(b.flag_id));
  residue.sort((a, b) => a.flag_id.localeCompare(b.flag_id));
  return { targets, resolvable, residue };
}
