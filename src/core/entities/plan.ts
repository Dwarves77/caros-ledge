// Ported from old_repo/src/lib/entities/entity-plan.mjs (lines 1-88)
// Ported from old_repo/scripts/entities/backfill-entities.mjs (lines 26-69)
// Pure planners for the entity spine: jurisdiction, instrument and organisation entities, their identifier rows, refs and foreign-key updates.
// Nothing here touches the database or the clock (the caller passes `now`); a planner returns only what is not already there.
import { identifierRow, VALIDATORS, type IdentifierRow } from "./crosswalk";
import { entityId, hostFromUrl } from "./id";

export interface EntityRow {
  entity_id: string;
  kind: string;
  canonical_name: string;
  status: "active";
}
export interface RefRow {
  ref_table: string;
  ref_id: string;
  entity_id: string;
  role: string;
  asserted_by: string;
}
export interface PlanOpts {
  existingEntityIds?: ReadonlySet<string>;
  existingIdentifierKeys?: ReadonlySet<string>;
  assertedBy: string;
  now: Date;
}
const none = new Set<string>();

/** Jurisdiction entities for the codes not yet held; an ISO 3166-1 or -2 code also gets its identifier row. */
export function planJurisdiction(codes: Iterable<string>, o: PlanOpts): { entities: EntityRow[]; identifiers: IdentifierRow[]; byCode: Map<string, string> } {
  const entities: EntityRow[] = [];
  const identifiers: IdentifierRow[] = [];
  const byCode = new Map<string, string>();
  const haveE = o.existingEntityIds ?? none;
  const haveI = o.existingIdentifierKeys ?? none;
  for (const code of codes) {
    const id = entityId("jurisdiction", code);
    byCode.set(code, id);
    if (!haveE.has(id) && !entities.some((e) => e.entity_id === id)) entities.push({ entity_id: id, kind: "jurisdiction", canonical_name: code, status: "active" });
    const scheme = VALIDATORS.ISO3166_1(code) ? "ISO3166_1" : VALIDATORS.ISO3166_2(code) ? "ISO3166_2" : null;
    if (scheme && !haveI.has(`${id}|${scheme}|${code}`)) identifiers.push(identifierRow(id, scheme, code, o.assertedBy, { now: o.now }));
  }
  return { entities, identifiers, byCode };
}

/** `jurisdiction` refs for each row's ISO codes (items carry jurisdiction_iso, regions iso_codes); `existingRefKeys` is extended so one run never repeats a ref. */
export function planJurisdictionRefs(refTable: string, rows: readonly { id: string; jurisdiction_iso?: string[] | null; iso_codes?: string[] | null }[], byCode: ReadonlyMap<string, string>, existingRefKeys: Set<string>, assertedBy: string): RefRow[] {
  const refs: RefRow[] = [];
  for (const row of rows) {
    const codes = row.jurisdiction_iso ?? row.iso_codes ?? [];
    for (const raw of Array.isArray(codes) ? codes : []) {
      const code = String(raw ?? "").trim().toUpperCase();
      if (!code) continue;
      const entity_id = byCode.get(code) ?? entityId("jurisdiction", code);
      const key = `${refTable}|${row.id}|${entity_id}|jurisdiction`;
      if (existingRefKeys.has(key)) continue;
      refs.push({ ref_table: refTable, ref_id: row.id, entity_id, role: "jurisdiction", asserted_by: assertedBy });
      existingRefKeys.add(key);
    }
  }
  return refs;
}

/** Instrument entities for the canonical instrument keys not yet held; a CELEX-shaped key also gets its identifier row. */
export function planInstrument(keys: Iterable<unknown>, o: PlanOpts): { entities: EntityRow[]; identifiers: IdentifierRow[]; byKey: Map<string, string> } {
  const entities: EntityRow[] = [];
  const identifiers: IdentifierRow[] = [];
  const byKey = new Map<string, string>();
  const haveE = o.existingEntityIds ?? none;
  const haveI = o.existingIdentifierKeys ?? none;
  for (const raw of keys) {
    const key = String(raw ?? "").trim().toUpperCase();
    if (!key) continue;
    const id = entityId("instrument", key);
    byKey.set(key, id);
    if (!haveE.has(id) && !entities.some((e) => e.entity_id === id)) entities.push({ entity_id: id, kind: "instrument", canonical_name: key, status: "active" });
    if (VALIDATORS.CELEX(key) && !haveI.has(`${id}|CELEX|${key}`)) identifiers.push(identifierRow(id, "CELEX", key, o.assertedBy, { now: o.now }));
  }
  return { entities, identifiers, byKey };
}

export function planInstrumentFkUpdates(items: readonly { id: string; canonical_instrument_key?: string | null }[], byKey: ReadonlyMap<string, string>): { id: string; instrument_entity_id: string }[] {
  const updates: { id: string; instrument_entity_id: string }[] = [];
  for (const it of items) {
    const entity_id = byKey.get(String(it.canonical_instrument_key ?? "").trim().toUpperCase());
    if (entity_id) updates.push({ id: it.id, instrument_entity_id: entity_id });
  }
  return updates;
}

/** Organisation entities by source host (one per host, with a HOST identifier row). */
export function planOrganisation(urls: Iterable<string>, o: PlanOpts): { entities: EntityRow[]; identifiers: IdentifierRow[]; byHost: Map<string, string> } {
  const entities: EntityRow[] = [];
  const identifiers: IdentifierRow[] = [];
  const byHost = new Map<string, string>();
  const haveE = o.existingEntityIds ?? none;
  const haveI = o.existingIdentifierKeys ?? none;
  for (const url of urls) {
    const host = hostFromUrl(url);
    if (!host || byHost.has(host)) continue;
    const id = entityId("organisation", host);
    byHost.set(host, id);
    if (!haveE.has(id)) entities.push({ entity_id: id, kind: "organisation", canonical_name: host, status: "active" });
    if (!haveI.has(`${id}|HOST|${host}`)) identifiers.push(identifierRow(id, "HOST", host, o.assertedBy, { now: o.now }));
  }
  return { entities, identifiers, byHost };
}

export function planOrganisationFkUpdates(sources: readonly { id: string; url?: string | null }[], byHost: ReadonlyMap<string, string>): { id: string; organisation_entity_id: string }[] {
  const updates: { id: string; organisation_entity_id: string }[] = [];
  for (const s of sources) {
    const entity_id = byHost.get(hostFromUrl(s.url));
    if (entity_id) updates.push({ id: s.id, organisation_entity_id: entity_id });
  }
  return updates;
}

/** The distinct non-empty values, upper-cased and sorted. */
export function distinctNormalized(raw: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  for (const r of raw) {
    const v = String(r ?? "").trim();
    if (v) seen.add(v.toUpperCase());
  }
  return [...seen].sort();
}
