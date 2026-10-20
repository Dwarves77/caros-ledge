// Ported from old_repo/src/lib/connections/run-discovery.mjs (lines 5-35)
// Ported from old_repo/scripts/connections/apply-tags.mjs (lines 497-502)
// Ported from old_repo/scripts/connections/discover-for-items.mjs (lines 99-106)
// Ported from old_repo/src/lib/connections/signal-candidates.mjs (lines 9-21)
// ONE connection signature and ONE paged loader (the old tree had three copies of the column string and the loop). The signature carries
// the domain, so surfaceOf is always called with (item_type, domain). entity_ids are the instrument entity of the item plus the
// regulation identifiers its title names (the old decisive "shared regulation identifier" signal, now an entity basis); obligation_keys
// are the ids of the obligation objects the item holds (and the ones they supersede).
import { admitItems } from "@/core/derived/admissible";
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";

export interface Signature {
  id: string;
  item_type?: string | null;
  domain?: number | null;
  title?: string | null;
  canonical_instrument_key?: string | null;
  instrument_entity_id?: string | null;
  source_id?: string | null;
  operational_scenario_tags?: string[] | null;
  compliance_object_tags?: string[] | null;
  jurisdictions?: string[] | null;
  jurisdiction_iso?: string[] | null;
  topic_tags?: string[] | null;
  created_at?: string | null;
  entity_ids?: string[];
  obligation_keys?: string[];
}

export const SIGNATURE_COLUMNS =
  "id, item_type, domain, title, canonical_instrument_key, instrument_entity_id, source_id, operational_scenario_tags, compliance_object_tags, jurisdictions, jurisdiction_iso, topic_tags, created_at";
export const SIGNATURE_CAP = 200_000;

const REG_ID_RE = /\b(\d{4}\/\d{2,5})(?:\/(?:EU|EC|EEC))?\b/g;

/** Regulation identifiers (2023/1805) named in a title, each as an entity token. */
export function regulationEntityTokens(title: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of String(title ?? "").matchAll(REG_ID_RE)) out.add(`reg:${m[1]}`);
  return [...out].sort();
}

/** The entity tokens one item holds. */
export function entityTokensOf(row: Pick<Signature, "title" | "instrument_entity_id">): string[] {
  return [...new Set([...(row.instrument_entity_id ? [row.instrument_entity_id] : []), ...regulationEntityTokens(row.title)])];
}

/**
 * The verified, live corpus as signatures, id-ordered (a total order) and capped. A failed page throws: discovery over a half-read
 * corpus would score against the wrong frequencies. `ids` restricts to those items, `since` to rows created at or after it.
 */
export async function loadSignatures(sb: Db, opts: { ids?: readonly string[]; since?: string; excludeId?: string; withObligations?: boolean } = {}): Promise<Signature[]> {
  const rows = await fetchAllRows<Signature>(
    (from, to) => {
      let q = admitItems(sb.from("intelligence_items").select(SIGNATURE_COLUMNS));
      if (opts.excludeId) q = q.neq("id", opts.excludeId);
      if (opts.ids?.length) q = q.in("id", [...opts.ids]);
      if (opts.since) q = q.gte("created_at", opts.since);
      return q.order("id", { ascending: true }).range(from, to);
    },
    { cap: SIGNATURE_CAP },
  );
  const keys = opts.withObligations === false ? new Map<string, string[]>() : await loadObligationKeys(sb);
  return rows.map((r) => ({ ...r, entity_ids: entityTokensOf(r), obligation_keys: keys.get(r.id) ?? [] }));
}

/** Item id to the obligation keys it holds: each object's id and the id it supersedes (so a new version links to the one it replaced). */
export async function loadObligationKeys(sb: Db): Promise<Map<string, string[]>> {
  const objs = await fetchAllRows<{ obligation_id: string; instrument_item_id: string; supersedes: string | null }>(
    (from, to) => sb.from("obligation_objects").select("obligation_id, instrument_item_id, supersedes").order("obligation_id", { ascending: true }).range(from, to),
    { cap: SIGNATURE_CAP },
  );
  const out = new Map<string, Set<string>>();
  for (const o of objs) {
    const set = out.get(o.instrument_item_id) ?? new Set<string>();
    set.add(o.obligation_id);
    if (o.supersedes) set.add(o.supersedes);
    out.set(o.instrument_item_id, set);
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}
