// New in DIGEST-1 PR B (scripts/ci/new-files/digest-1b.txt), ADR-053 / TRIANGLE-TRACE Q3: the candidate_entities block of a reader bundle. The reader may file an entity only by an id on this menu (or a formal code), so the menu is every entity the text could be about: the item's
// own instrument first, then the entities its claims, events and obligations are typed-linked to (entity_refs with a method version; never a prose match), then the rest of the closed ontology of couplings.json, then at most three region or publisher lines. Modes, hubs and windows
// are closed tokens and stay out. The cap is MENU.cap; over it the lowest-ranked linked entities drop and the block says `truncated: n`. A line is `entity_id | kind | canonical_name | aliases | links: n`. The same function serves the theme and admin bundles (their seed is the packet's members).
import { loadOntology, uuidOf, type Ontology } from "@/core/coupling";
import { fetchAllByIdChunks, rowsByIds, type Db } from "@/core/db";
import { MENU } from "@/core/digest/kinds";
import type { Packet } from "@/core/digest/packets-client";
import { canonicalJurisdictionCode, entityId } from "@/core/entities/id";
import { readAll } from "@/core/coupling/read";
import { hostOf } from "@/core/shared/url";

/** What ranks an entity: its own instrument, the typed-link weight of the others, where the region and publisher lines come from, and the graph neighbourhood (GRAPH-GROW-1): the item's domain, and the item itself (excluded from its own domain neighbours). */
export interface Seed { self?: string | null; weights: ReadonlyMap<string, number>; region?: readonly string[]; publisher?: string | null; domain?: number | null; itemId?: string | null }
export interface Menu { lines: string[]; ids: string[]; truncated: number }
interface Ent { entity_id: string; kind: string; canonical_name: string; status: string }
interface Ident { entity_id: string; scheme: string; value: string }

const OUT = new Set(["mode", "hub", "window"]);
const rank = (onto: Ontology) => (e: Ent): number => { const i = MENU.kindOrder.indexOf(onto.classOf(e.entity_id) || e.kind); return i < 0 ? MENU.kindOrder.length : i; };
const byRank = (onto: Ontology) => (a: Ent, b: Ent): number => rank(onto)(a) - rank(onto)(b) || (a.entity_id < b.entity_id ? -1 : 1);
const bump = (m: Map<string, number>, id: string, n = 1): void => void m.set(id, (m.get(id) ?? 0) + n);
const identsOf = (sb: Db, ids: readonly string[]) => fetchAllByIdChunks<Ident>(ids, (slice) => readAll(sb, "entity_identifiers", "entity_id, scheme, value", ["entity_id", "scheme", "value"], (q) => q.in("entity_id", slice)), { manyPerId: true });

/**
 * The LIVE graph around an item (GRAPH-GROW-1, no static list): the entities one hop from its own and its linked entities in entity_relations, the entities that share a formal code (entity_identifiers) with them,
 * and, for the item's domain, the entities the other items of that domain are most often filed under. Weights: relations and shared codes counted per entity; the domain by how many items file the entity.
 */
async function neighbourhood(sb: Db, seed: Seed): Promise<{ near: Map<string, number>; domain: Map<string, number> }> {
  const core = [...new Set([...(seed.self ? [seed.self] : []), ...seed.weights.keys()])];
  const near = new Map<string, number>();
  if (core.length) {
    const edge = (col: "parent_entity_id" | "child_entity_id") => fetchAllByIdChunks<{ parent_entity_id: string; child_entity_id: string }>(core, (slice) => readAll(sb, "entity_relations", "parent_entity_id, child_entity_id, relation", ["parent_entity_id", "child_entity_id", "relation"], (q) => q.in(col, slice)), { manyPerId: true });
    for (const r of await edge("parent_entity_id")) bump(near, r.child_entity_id);
    for (const r of await edge("child_entity_id")) bump(near, r.parent_entity_id);
    const own = await identsOf(sb, core);
    for (const scheme of new Set(own.map((o) => o.scheme))) {
      const values = [...new Set(own.filter((o) => o.scheme === scheme).map((o) => o.value))];
      for (const r of await fetchAllByIdChunks<Ident>(values, (slice) => readAll(sb, "entity_identifiers", "entity_id, scheme, value", ["entity_id", "scheme", "value"], (q) => q.eq("scheme", scheme).in("value", slice)), { manyPerId: true })) bump(near, r.entity_id);
    }
    for (const id of core) near.delete(id);
  }
  const domain = new Map<string, number>();
  if (seed.domain !== null && seed.domain !== undefined) {
    // The newest items of the domain, a bounded sample (a limit, never a paginated read that throws past a cap).
    const items = await sb.from("intelligence_items").select("id").eq("domain", seed.domain).eq("is_archived", false).order("added_date", { ascending: false }).limit(MENU.domainItems);
    if (items.error) throw new Error(`domain neighbours read failed: ${items.error.message}`);
    const ids = ((items.data ?? []) as { id: string }[]).map((i) => i.id).filter((i) => i !== seed.itemId);
    for (const r of await fetchAllByIdChunks<{ entity_id: string }>(ids, (slice) => readAll(sb, "entity_refs", "entity_id, ref_id, role", ["ref_table", "ref_id", "entity_id", "role"], (q) => q.eq("ref_table", "intelligence_items").in("ref_id", slice).not("method_version", "is", null)), { manyPerId: true })) bump(domain, r.entity_id);
    for (const id of [...core, ...near.keys()]) domain.delete(id);
  }
  return { near, domain };
}

/** The menu for a seed: the own instrument, the typed-linked entities, the graph neighbours, the domain's entities, then region and publisher lines; rank, cap and state the truncation. Modes and hubs are closed tokens and stay out. */
export async function candidateMenu(sb: Db, seed: Seed): Promise<Menu> {
  const region = [...(seed.region ?? []), ...(seed.publisher ? [seed.publisher] : [])].slice(0, MENU.maxRegion);
  const onto = await loadOntology(sb);
  const isClosedToken = (id: string): boolean => OUT.has(onto.classOf(id));
  const { near, domain } = await neighbourhood(sb, seed);
  const want = [...new Set([...(seed.self ? [seed.self] : []), ...seed.weights.keys(), ...near.keys(), ...domain.keys(), ...region])];
  const ents = new Map((await rowsByIds<Ent>(sb, "entities", "entity_id, kind, canonical_name, status", want, "entity_id", "entity_id")).filter((e) => e.status === "active" && !isClosedToken(e.entity_id)).map((e) => [e.entity_id, e]));
  const take = (ids: Iterable<string>): Ent[] => [...ids].flatMap((id) => (ents.has(id) ? [ents.get(id) as Ent] : []));
  const heaviest = (m: ReadonlyMap<string, number>) => (a: Ent, b: Ent) => (m.get(b.entity_id) ?? 0) - (m.get(a.entity_id) ?? 0) || byRank(onto)(a, b);
  const self = take(seed.self ? [seed.self] : []);
  const used = new Set(self.map((e) => e.entity_id));
  const regions = take(region).filter((e) => !used.has(e.entity_id));
  regions.forEach((e) => used.add(e.entity_id));
  const room = (): number => MENU.cap - self.length - regions.length;
  const pick = (from: Ent[], m: ReadonlyMap<string, number>, limit: number): { kept: Ent[]; all: number } => {
    const fresh = from.filter((e) => !used.has(e.entity_id)).sort(heaviest(m));
    const kept = fresh.slice(0, Math.max(0, limit));
    kept.forEach((e) => used.add(e.entity_id));
    return { kept, all: fresh.length };
  };
  const linked = pick(take(seed.weights.keys()), seed.weights, Math.min(MENU.maxLinked, room()));
  const neigh = pick(take(near.keys()), near, Math.min(MENU.maxNeighbour, room() - linked.kept.length));
  const dom = pick(take(domain.keys()), domain, Math.min(MENU.maxDomain, room() - linked.kept.length - neigh.kept.length));
  const ordered = [...self, ...linked.kept, ...neigh.kept, ...dom.kept, ...regions];
  const aliases = new Map<string, string[]>();
  const add = (id: string, v: string) => void aliases.set(id, [...(aliases.get(id) ?? []), v]);
  for (const a of await identsOf(sb, ordered.map((e) => e.entity_id))) add(a.entity_id, `${a.scheme}:${a.value}`);
  for (const a of await fetchAllByIdChunks<{ entity_id: string; alias: string }>(ordered.map((e) => e.entity_id), (slice) => readAll(sb, "entity_aliases", "entity_id, alias", ["entity_id", "alias"], (q) => q.in("entity_id", slice)), { manyPerId: true })) add(a.entity_id, a.alias);
  const line = (e: Ent) => [e.entity_id, e.kind, e.canonical_name, (aliases.get(e.entity_id) ?? []).slice(0, MENU.aliases).join("; "), `links: ${seed.weights.get(e.entity_id) ?? 0}`].join(" | ");
  return { lines: ordered.map(line), ids: ordered.map((e) => e.entity_id), truncated: linked.all - linked.kept.length + (neigh.all - neigh.kept.length) + (dom.all - dom.kept.length) };
}

/** The typed-link weights from entity_refs for a set of rows: each ref the mining wrote with a method version counts once for its entity. */
async function weightsOf(sb: Db, rows: readonly { table: string; id: string }[]): Promise<Map<string, number>> {
  const w = new Map<string, number>();
  for (const table of new Set(rows.map((r) => r.table))) {
    const ids = rows.filter((r) => r.table === table).map((r) => (table === "obligation_objects" ? uuidOf(r.id) : r.id));
    for (const r of await fetchAllByIdChunks<{ entity_id: string }>(ids, (slice) => readAll(sb, "entity_refs", "entity_id, ref_id, role", ["ref_table", "ref_id", "entity_id", "role"], (q) => q.eq("ref_table", table).in("ref_id", slice).not("method_version", "is", null)), { manyPerId: true })) w.set(r.entity_id, (w.get(r.entity_id) ?? 0) + 1);
  }
  return w;
}

/** An item's seed: its instrument, the entities its claims, forward events and obligations are filed under, its jurisdictions and its publisher host. */
export async function itemSeed(sb: Db, it: { id: string; instrument_entity_id: string | null; jurisdiction_iso: string[] | null; source_url: string | null; domain?: number | null }, parts: { claimIds: readonly string[]; eventIds: readonly string[]; obligationIds: readonly string[] }): Promise<Seed> {
  const rows = [...parts.claimIds.map((id) => ({ table: "section_claim_provenance", id })), ...parts.eventIds.map((id) => ({ table: "item_forward_events", id })), ...parts.obligationIds.map((id) => ({ table: "obligation_objects", id }))];
  const host = hostOf(it.source_url);
  const codes = (it.jurisdiction_iso ?? []).flatMap((c) => canonicalJurisdictionCode(c) ?? []);
  return { self: it.instrument_entity_id, weights: await weightsOf(sb, rows), region: codes.map((c) => entityId("jurisdiction", c)), publisher: host ? entityId("organisation", host) : null, domain: it.domain ?? null, itemId: it.id };
}

/** A packet seed (theme and admin bundles): the entities the packet's member rows are filed under. */
export async function packetSeed(sb: Db, packets: readonly Packet[]): Promise<Seed> {
  const members = packets.flatMap((p) => p.members.map((m) => ({ table: m.table, id: m.id })));
  return { weights: await weightsOf(sb, members) };
}

/** The bundle block: the lines the reader reads and the truncation stated (`truncated: 0` when nothing dropped). */
export const menuBlock = (m: Menu): { entities: string[]; truncated: number } => ({ entities: m.lines, truncated: m.truncated });

/** A theme's seed when no packet is read: the entities the member items' claims and forward events are filed under. */
export async function memberSeed(sb: Db, itemIds: readonly string[]): Promise<Seed> {
  const claims = await rowsByIds<{ id: string }>(sb, "section_claim_provenance", "id", itemIds, "intelligence_item_id", "id");
  const events = await rowsByIds<{ id: string }>(sb, "item_forward_events", "id", itemIds, "intelligence_item_id", "id");
  return { weights: await weightsOf(sb, [...claims.map((c) => ({ table: "section_claim_provenance", id: c.id })), ...events.map((e) => ({ table: "item_forward_events", id: e.id }))]) };
}
