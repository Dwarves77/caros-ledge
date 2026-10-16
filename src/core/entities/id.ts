// Ported from old_repo/src/lib/entities/entity-id.mjs (lines 1-89)
// Ported from old_repo/src/lib/entities/host-from-url.mjs (lines 1-10)
// Ported from old_repo/src/lib/entities/resolve.mjs (lines 55-98)
// Deterministic entity ids: cl:<kind>:<first 16 hex of sha256(normalised seed)>, so independent ingest paths mint the same id with no
// coordination. A corridor seed is ORIGIN-DEST:mode with the mode through normaliseMode (never sea/maritime). An empty seed is refused.
import { createHash } from "node:crypto";

import { normaliseMode } from "@/core/contracts/vocabularies";
import { hostOf } from "@/core/shared/url";

import aliases from "./data/jurisdiction-aliases.json";
import { assertEntityId, entityKindOf, KINDS, parseCorridorName, type EntityKind } from "./kinds";

export { assertEntityId, entityKindOf, hostOf as hostFromUrl, KINDS, parseCorridorName };
export type { EntityKind };

const KIND_SET: ReadonlySet<string> = new Set(KINDS);
const HEX_LEN = 16;
const sha256Hex16 = (payload: string): string => createHash("sha256").update(payload, "utf8").digest("hex").slice(0, HEX_LEN);

/** Scopes that name no jurisdiction (the workspace profile, a register filter): never a match key. One definition for every reader. */
export const GENERIC_JURISDICTIONS: ReadonlySet<string> = new Set(["global", "worldwide", "all"]);

/** The canonical spelling of a jurisdiction code: trimmed, upper case, and the alias table applied (UK is GB). Null when empty. */
export function canonicalJurisdictionCode(code: unknown): string | null {
  const c = String(code ?? "").trim().toUpperCase();
  if (!c) return null;
  return (aliases as Record<string, string>)[c] ?? c;
}

/** The seed of a corridor: upper-case UN/LOCODE endpoints and the canonical mode. Throws on a missing endpoint or an unrecognised mode. */
export function corridorSeed(input: { origin?: unknown; dest?: unknown; mode?: unknown } = {}): string {
  const o = String(input.origin ?? "").trim().toUpperCase();
  const d = String(input.dest ?? "").trim().toUpperCase();
  const mode = normaliseMode(input.mode);
  if (!o || !d) throw new Error(`entity-id: corridorSeed requires both origin and dest UN/LOCODE (got origin=${JSON.stringify(input.origin)}, dest=${JSON.stringify(input.dest)})`);
  if (!mode) throw new Error(`entity-id: corridorSeed got an unrecognised mode ${JSON.stringify(input.mode)}: normaliseMode() could not resolve it to a canonical transport mode`);
  return `${o}-${d}:${mode}`;
}

/** The normalised seed per kind (what is hashed). */
export function normalizeSeed(kind: EntityKind, seed: unknown): string {
  if (!KIND_SET.has(kind)) throw new Error(`entity-id: unknown entity_kind "${kind}", must be one of ${KINDS.join(", ")}`);
  if (kind === "corridor") return seed && typeof seed === "object" ? corridorSeed(seed as Record<string, unknown>) : String(seed ?? "").trim();
  if (kind === "jurisdiction" || kind === "instrument") return String(seed ?? "").trim().toUpperCase();
  if (kind === "organisation") {
    const s = String(seed ?? "").trim();
    return s.includes("://") || s.includes("/") ? hostOf(s) : s.toLowerCase().replace(/^www\./, "");
  }
  return String(seed ?? "").trim().replace(/\s+/g, " ");
}

export function entityId(kind: EntityKind, seed: unknown): string {
  const normalized = normalizeSeed(kind, seed);
  if (!normalized) throw new Error(`entity-id: empty normalized seed for kind "${kind}" (raw seed: ${JSON.stringify(seed)}), refusing to mint a degenerate id`);
  return `cl:${kind}:${sha256Hex16(normalized)}`;
}

export interface EntityRowLike {
  entity_id: string;
  status?: string | null;
  merged_into?: string | null;
}
export const MAX_MERGE_HOPS = 5;
export type Survivor = { ok: true; entity: EntityRowLike; viaMerge: boolean } | { ok: false; reason: "entity_missing" | "merge_chain_too_long" | "merge_loop" };

/** Follow merged_into to each live survivor; a missing row, a chain past MAX_MERGE_HOPS or a loop is reported with its reason, never dropped. */
export async function resolveSurvivors(ids: readonly string[], readEntities: (ids: string[]) => Promise<EntityRowLike[]>): Promise<Map<string, Survivor>> {
  const known = new Map<string, EntityRowLike | null>();
  const load = async (want: string[]) => {
    const need = [...new Set(want)].filter((id) => !known.has(id));
    if (!need.length) return;
    for (const r of await readEntities(need)) known.set(r.entity_id, r);
    for (const id of need) if (!known.has(id)) known.set(id, null);
  };
  const out = new Map<string, Survivor>();
  let pending = [...new Set(ids)].map((id) => ({ requested: id, current: id, seen: new Set<string>(), hops: 0 }));
  while (pending.length) {
    await load(pending.map((p) => p.current));
    const next: typeof pending = [];
    for (const p of pending) {
      const row = known.get(p.current);
      if (!row) {
        out.set(p.requested, { ok: false, reason: "entity_missing" });
        continue;
      }
      if (row.status === "merged" && row.merged_into) {
        p.seen.add(p.current);
        p.hops += 1;
        if (p.hops > MAX_MERGE_HOPS) out.set(p.requested, { ok: false, reason: "merge_chain_too_long" });
        else if (p.seen.has(row.merged_into)) out.set(p.requested, { ok: false, reason: "merge_loop" });
        else {
          p.current = row.merged_into;
          next.push(p);
        }
        continue;
      }
      out.set(p.requested, { ok: true, entity: row, viaMerge: p.current !== p.requested });
    }
    pending = next;
  }
  return out;
}
