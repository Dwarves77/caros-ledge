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

/** What ranks an entity: its own instrument, the typed-link weight of the others, and where the region and publisher lines come from. */
export interface Seed { self?: string | null; weights: ReadonlyMap<string, number>; region?: readonly string[]; publisher?: string | null }
export interface Menu { lines: string[]; ids: string[]; truncated: number }
interface Ent { entity_id: string; kind: string; canonical_name: string; status: string }

const OUT = new Set(["mode", "hub", "window"]);
/** The entity kinds the ontology of the database is made of (the seeded vocabulary: feedstocks, carriers, nodes, assets, methods); the spine kinds (jurisdiction, organisation, instrument, obligation) are not menu ontology. */
const ONTOLOGY_KINDS = ["material", "node", "asset", "method"];
const rank = (onto: Ontology) => (e: Ent): number => { const i = MENU.kindOrder.indexOf(onto.classOf(e.entity_id) || e.kind); return i < 0 ? MENU.kindOrder.length : i; };
const byRank = (onto: Ontology) => (a: Ent, b: Ent): number => rank(onto)(a) - rank(onto)(b) || (a.entity_id < b.entity_id ? -1 : 1);

/** The menu for a seed: rank, cap and state the truncation. Dropped entities are the lowest-ranked linked ones that are not already in the ontology. */
export async function candidateMenu(sb: Db, seed: Seed): Promise<Menu> {
  const region = [...(seed.region ?? []), ...(seed.publisher ? [seed.publisher] : [])].slice(0, MENU.maxRegion);
  const onto = await loadOntology(sb);
  const byRank_ = byRank(onto);
  // the ontology is the database: the entities of the vocabulary kinds, and any entity the relation graph connects (an instrument the vocabulary relates to a node or a fuel)
  const seededKinds = await readAll<Ent>(sb, "entities", "entity_id, kind, canonical_name, status", ["entity_id"], (q) => q.in("kind", ONTOLOGY_KINDS).eq("status", "active"));
  const related = new Set((await readAll<{ parent_entity_id: string; child_entity_id: string }>(sb, "entity_relations", "parent_entity_id, child_entity_id", ["parent_entity_id", "child_entity_id", "relation"])).flatMap((r) => [r.parent_entity_id, r.child_entity_id]));
  const heldKinds = new Set(seededKinds.map((e) => e.entity_id));
  const seeded = [...seededKinds, ...(await rowsByIds<Ent>(sb, "entities", "entity_id, kind, canonical_name, status", [...related].filter((id) => !heldKinds.has(id)), "entity_id", "entity_id")).filter((e) => e.status === "active")];
  const ontologyIds = new Set(seeded.filter((e) => !OUT.has(onto.classOf(e.entity_id))).map((e) => e.entity_id));
  const isOntology = (id: string): boolean => ontologyIds.has(id);
  const want = [...new Set([...ontologyIds, ...(seed.self ? [seed.self] : []), ...seed.weights.keys(), ...region])];
  const ents = new Map((await rowsByIds<Ent>(sb, "entities", "entity_id, kind, canonical_name, status", want, "entity_id", "entity_id")).filter((e) => e.status === "active" && !OUT.has(onto.classOf(e.entity_id))).map((e) => [e.entity_id, e]));
  const take = (ids: Iterable<string>): Ent[] => [...ids].flatMap((id) => (ents.has(id) ? [ents.get(id) as Ent] : []));
  const self = take(seed.self ? [seed.self] : []);
  const used = new Set(self.map((e) => e.entity_id));
  const linked = take([...seed.weights.keys()].filter((id) => !used.has(id))).sort((a, b) => (seed.weights.get(b.entity_id) ?? 0) - (seed.weights.get(a.entity_id) ?? 0) || byRank_(a, b));
  const ontology = take(ontologyIds).sort(byRank_);
  const regions = take(region).filter((e) => !ontology.includes(e) && !linked.includes(e));
  const room = MENU.cap - self.length - ontology.filter((e) => !linked.includes(e)).length - regions.length;
  let free = Math.min(MENU.maxLinked, room);
  const kept = linked.filter((e) => isOntology(e.entity_id) || free-- > 0);
  const ordered = [...self, ...kept, ...ontology.filter((e) => !kept.includes(e)), ...regions];
  const aliases = new Map<string, string[]>();
  for (const a of await fetchAllByIdChunks<{ entity_id: string; alias: string }>(ordered.map((e) => e.entity_id), (slice) => readAll(sb, "entity_aliases", "entity_id, alias", ["entity_id", "alias"], (q) => q.in("entity_id", slice)), { manyPerId: true })) aliases.set(a.entity_id, [...(aliases.get(a.entity_id) ?? []), a.alias]);
  const line = (e: Ent) => [e.entity_id, e.kind, e.canonical_name, (aliases.get(e.entity_id) ?? []).slice(0, MENU.aliases).join("; "), `links: ${seed.weights.get(e.entity_id) ?? 0}${isOntology(e.entity_id) && seed.weights.has(e.entity_id) ? " ontology: true" : ""}`].join(" | ");
  return { lines: ordered.map(line), ids: ordered.map((e) => e.entity_id), truncated: linked.length - kept.length };
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
export async function itemSeed(sb: Db, it: { id: string; instrument_entity_id: string | null; jurisdiction_iso: string[] | null; source_url: string | null }, parts: { claimIds: readonly string[]; eventIds: readonly string[]; obligationIds: readonly string[] }): Promise<Seed> {
  const rows = [...parts.claimIds.map((id) => ({ table: "section_claim_provenance", id })), ...parts.eventIds.map((id) => ({ table: "item_forward_events", id })), ...parts.obligationIds.map((id) => ({ table: "obligation_objects", id }))];
  const host = hostOf(it.source_url);
  const codes = (it.jurisdiction_iso ?? []).flatMap((c) => canonicalJurisdictionCode(c) ?? []);
  return { self: it.instrument_entity_id, weights: await weightsOf(sb, rows), region: codes.map((c) => entityId("jurisdiction", c)), publisher: host ? entityId("organisation", host) : null };
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
