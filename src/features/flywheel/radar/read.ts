// New in UI-RADAR-1 (scripts/ci/new-files/ui-radar-1.txt): what the flywheel radar draws, read for one scope. The panel is the customer face of the engine's cross-surface findings: the patterns the pattern step recorded as derived values (emerging or still forming),
// the items and entities each one joins by surface, the signpost that would confirm it, the open needs that say which part of the chain is missing, and the connections still developing. This module reads and composes; it writes nothing, and no method id, uuid or score leaves it.
// The facts joins (ENGINE-JOIN-1, src/core/flywheel/facts-join.ts) are taken as an argument in the shape the radar reads them, so the reads here stand on their own until a page hands them in.
import { allRows, boundedRead, fetchAllByIdChunks, isServiceConfigured, rowsByIds, serviceClient, type Db } from "@/core/db";
import { admitItems } from "@/core/derived/admissible";
import { buildSubjectRef, createdBy, GAP_NAMESPACE } from "@/core/flywheel/flags";
import { familyWords, reasonFor, whyLines, type FactsByItem } from "@/core/flywheel/view-model";
import { FACT_SPECS } from "@/core/flywheel/patterns/config";
import { PATTERN_METHODS } from "@/core/propagation/methods";
import { SURFACE_LABELS, SURFACE_ORDER, SURFACE_PATH, surfaceHref, surfaceOf } from "@/core/routing";
import { PATTERN_COPY } from "@/features/operations/model/derived-view";
import type { RadarForming, RadarGroup, RadarPattern, RadarView } from "@/ui/flywheel/FlywheelRadar";

export type { RadarForming, RadarGroup, RadarPattern, RadarView };

/** The two joins the radar's neighbours read; ENGINE-JOIN-1's facts-join.ts exports them with a database as the first argument. */
export interface FactsJoin {
  readEntityFacts(db: Db, itemIds: readonly string[]): Promise<FactsByItem>;
  /** The items (regulations, operations, research) tied to structured rows, per row id: each link is an item with its title, next dated obligation and penalty in `summary`. */
  readFactItems(db: Db, refTable: string, refIds: readonly string[]): Promise<FactsByItem>;
}

/** The facts joins ENGINE-JOIN-1 ships (src/core/flywheel/facts-join.ts). Null until that module is on main; every reader then draws from the basis alone and the figure cards say which surface holds nothing. */
export const FACTS_JOIN: FactsJoin | null = null;

/** The reader's own client and the platform's: the signposts and the open needs sit behind the platform role; without it the radar draws what the reader's client can read. */
export const radarClients = (db: Db): { db: Db; admin: Db } => ({ db, admin: isServiceConfigured() ? serviceClient() : db });

export type RadarScope = { kind: "corpus" } | { kind: "surface"; surface: string } | { kind: "item"; itemUuid: string; memberIds: readonly string[] };
interface PatternRow {
  value_id: string;
  entity_id: string;
  method_id: string;
  lifecycle: string;
  computed_by: string;
  computed_at: string;
  inputs: unknown;
}
interface Input {
  table: string;
  pk: string;
  surface?: string;
  entities?: string[];
}
interface ItemRow {
  id: string;
  legacy_id: string | null;
  title: string;
  item_type: string | null;
  domain: number | null;
}
const KIND_OF_METHOD: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(PATTERN_METHODS).map(([kind, m]) => [m.id, kind]));
const METHOD_IDS = Object.values(PATTERN_METHODS).map((m) => m.id);
const SHOWN_PATTERNS = 5;
const SHOWN_FORMING = 3;
const OPEN = ["open", "in_review"];

const inputsOf = (r: PatternRow): Input[] => (Array.isArray(r.inputs) ? (r.inputs as Input[]).filter((i) => i && typeof i.table === "string" && i.pk !== undefined && i.pk !== null) : []);
/** The seed a pattern and its signpost are filed under: the detector kind and the pattern key (computed_by is `method@version:key`). */
const seedOf = (r: PatternRow): string => `${KIND_OF_METHOD[r.method_id]}:${r.computed_by.slice(r.computed_by.indexOf(":") + 1)}`;
/** The missing link a forming pattern states, wherever the producer left it in the row's inputs: `{ surface, truth }`. */
function missingOf(r: PatternRow): { surface: string; truth: string } | null {
  const hit = (Array.isArray(r.inputs) ? (r.inputs as Record<string, unknown>[]) : []).map((i) => (i?.missing ?? i) as Record<string, unknown> | null).find((m) => typeof m?.truth === "string" && typeof m?.surface === "string");
  return hit ? { surface: String(hit.surface), truth: String(hit.truth).trim() } : null;
}
/** The surface a pattern-need flag names: its description states it as "Surface <key>;" (gaps.ts patternGaps writes both rules that way); a key the routing table does not hold names none. */
const gapSurface = (description: string): string | null => {
  const key = /\bSurface (\w+);/.exec(description)?.[1];
  return key && SURFACE_LABELS[key] ? key : null;
};

/** The admissible items among `ids` (verified, not archived, not replaced), by uuid. */
async function readItems(db: Db, ids: readonly string[]): Promise<Map<string, ItemRow>> {
  const rows = await fetchAllByIdChunks<ItemRow>(ids, async (slice) => {
    const { data, error } = await admitItems(db.from("intelligence_items").select("id, legacy_id, title, item_type, domain")).in("id", slice);
    if (error) throw new Error(error.message);
    return (data ?? []) as ItemRow[];
  }, { chunk: 100 });
  return new Map(rows.map((r) => [r.id, r]));
}

/** The items the patterns rest on, by the owner column the fact specs name (`owner`, else `item`) (a table with none, such as a price series, joins through its entities). */
async function itemsOfInputs(db: Db, inputs: readonly Input[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const tables = [...new Set(inputs.map((i) => i.table))];
  await Promise.all(
    tables.map(async (table) => {
      const spec = (FACT_SPECS[table] ?? []).find((s) => s.owner ?? s.item);
      const owner = spec?.owner ?? spec?.item;
      if (!spec || !owner) return;
      const pks = inputs.filter((i) => i.table === table).map((i) => String(i.pk));
      const rows = await rowsByIds<Record<string, unknown>>(db, table, `${spec.pk},${owner}`, pks, spec.pk, spec.pk);
      for (const r of rows) if (r[owner]) out.set(`${table}/${String(r[spec.pk])}`, String(r[owner]));
    }),
  );
  return out;
}

/**
 * The radar for one scope. `db` is the reader's own client (RLS); `admin` reads the signposts and the open needs, which the platform keeps behind its own role. A failed read throws (the page says so with Retry);
 * so does a failed read of a part that adds to a pattern (signposts, needs, entity names): the panel never passes for empty.
 */
export async function readFlywheelRadar(clients: { db: Db; admin: Db }, scope: RadarScope): Promise<RadarView> {
  const { db, admin } = clients;
  const read = await boundedRead<PatternRow>((n) => db.from("derived_values_admissible").select("value_id, entity_id, method_id, lifecycle, computed_by, computed_at, inputs").in("method_id", METHOD_IDS).in("lifecycle", ["emerging", "forming"]).order("computed_at", { ascending: false }).order("value_id", { ascending: true }).limit(n) as never, { limit: 200 });
  if (read.error) throw new Error(read.error.message);
  const surfaceOfRow = (r: PatternRow): Set<string> => new Set(inputsOf(r).map((i) => i.surface).filter((s): s is string => !!s && !!SURFACE_LABELS[s]));
  let rows = read.data.filter((r) => r.method_id in PATTERN_COPY);
  if (scope.kind === "surface") rows = rows.filter((r) => surfaceOfRow(r).has(scope.surface));
  // a pattern that spans surfaces is the finding; the widest first, an emerging one before one still forming
  rows = rows.sort((a, b) => surfaceOfRow(b).size - surfaceOfRow(a).size || Number(a.lifecycle === "forming") - Number(b.lifecycle === "forming")).slice(0, scope.kind === "item" ? 40 : SHOWN_PATTERNS * 3);
  const allInputs = rows.flatMap(inputsOf);
  const ownerOf = await itemsOfInputs(db, allInputs);
  if (scope.kind === "item") {
    const mine = new Set([scope.itemUuid, ...scope.memberIds]);
    rows = rows.filter((r) => inputsOf(r).some((i) => mine.has(ownerOf.get(`${i.table}/${i.pk}`) ?? "")));
  }
  rows = rows.slice(0, SHOWN_PATTERNS);
  const items = await readItems(db, [...new Set(rows.flatMap((r) => inputsOf(r).map((i) => ownerOf.get(`${i.table}/${i.pk}`)).filter((x): x is string => !!x)))]);
  const entityIds = [...new Set(rows.flatMap((r) => inputsOf(r).flatMap((i) => i.entities ?? [])))];
  const names = new Map((await rowsByIds<{ entity_id: string; canonical_name: string }>(db, "entities", "entity_id,canonical_name", entityIds, "entity_id", "entity_id")).map((e) => [e.entity_id, e.canonical_name]));
  const seeds = rows.map(seedOf);
  const posts = await rowsByIds<{ predicate: { pattern?: string; key_date?: string } | null; outcome: string | null; watches: string }>(admin, "signposts", "predicate,outcome,watches", rows.map((r) => r.entity_id), "watches", "entity_id");
  const watchOf = new Map(posts.filter((p) => !p.outcome && p.predicate?.pattern && seeds.includes(p.predicate.pattern)).map((p) => [p.predicate?.pattern as string, p.predicate?.key_date ?? null]));
  const flags = await allRows<{ id: string; subject_ref: string; description: string }>(admin, "integrity_flags", "id,subject_ref,description", { cap: 5_000, where: (q) => q.like("created_by", `${createdBy(GAP_NAMESPACE, "pattern_")}%`).in("status", OPEN) });
  const patterns = rows.map((r): RadarPattern => {
    const copy = PATTERN_COPY[r.method_id] as (typeof PATTERN_COPY)[string];
    const forming = r.lifecycle === "forming";
    const seed = seedOf(r);
    const ins = inputsOf(r);
    const groups: RadarGroup[] = SURFACE_ORDER.flatMap((surface) => {
      const here = ins.filter((i) => i.surface === surface);
      const found = [...new Map(here.flatMap((i) => { const it = items.get(ownerOf.get(`${i.table}/${i.pk}`) ?? ""); return it ? [[it.id, { title: it.title, href: surfaceHref(surfaceOf(it.item_type, it.domain), it.legacy_id || it.id) as string }] as const] : []; })).values()];
      const who = [...new Set(here.flatMap((i) => (i.entities ?? []).map((e) => names.get(e)).filter((n): n is string => !!n)))];
      return here.length ? [{ surface, label: SURFACE_LABELS[surface] as string, href: SURFACE_PATH[surface] as string, items: found, names: who }] : [];
    });
    const keys = new Set(ins.map((i) => buildSubjectRef("trigger", i.table, i.pk)));
    const parts = flags.filter((f) => f.subject_ref.startsWith(`pattern:${seed}:`) || keys.has(f.subject_ref)).map((f) => gapSurface(f.description)).filter((s): s is string => !!s);
    const date = watchOf.get(seed);
    const missing = forming ? missingOf(r) : null;
    return {
      key: r.value_id,
      label: forming ? copy.forming : copy.label,
      means: forming ? "The chain is not complete yet; the reading below is what is linked so far." : copy.means,
      forming,
      groups,
      watch: watchOf.has(seed) ? (date ? `Watch: confirmed if the dated step still stands on ${date}.` : "Watch: confirmed while the evidence behind it keeps holding.") : null,
      missingParts: [...new Set(parts)].map((s) => `Missing part: no ${SURFACE_LABELS[s]} item yet; the chain is incomplete until one appears.`),
      next: missing ? missing.truth : null,
    };
  });
  return { patterns, forming: scope.kind === "item" ? [] : await readForming(db, scope) };
}

/** The connections still developing: candidate edges, each as the two items already linked, why, and the next link to watch. */
async function readForming(db: Db, scope: RadarScope): Promise<RadarForming[]> {
  const edges = await boundedRead<{ source_item_id: string; target_item_id: string; basis: Parameters<typeof reasonFor>[0]["basis"]; score: number | null }>((n) => db.from("item_cross_references").select("source_item_id, target_item_id, basis, score").eq("origin", "candidate").order("score", { ascending: false }).limit(n) as never, { limit: 60 });
  if (edges.error) throw new Error(edges.error.message);
  const items = await readItems(db, edges.data.flatMap((e) => [e.source_item_id, e.target_item_id]));
  const shown: RadarForming[] = [];
  for (const e of edges.data) {
    const [a, b] = [items.get(e.source_item_id), items.get(e.target_item_id)];
    if (!a || !b) continue;
    const chain = [a, b].map((it) => ({ title: it.title, surface: surfaceOf(it.item_type, it.domain), href: surfaceHref(surfaceOf(it.item_type, it.domain), it.legacy_id || it.id) as string }));
    if (scope.kind === "surface" && !chain.some((c) => c.surface === scope.surface)) continue;
    const basis = e.basis && !Array.isArray(e.basis) ? e.basis : null;
    shown.push({ key: `${e.source_item_id}|${e.target_item_id}`, family: familyWords(basis?.missing?.patternFamily), chain, reason: reasonFor({ basis: e.basis, origin: "candidate", label: "Related" }) ?? "A chain is forming between the two.", next: basis?.missing?.truth?.trim() || null });
    if (shown.length >= SHOWN_FORMING) break;
  }
  return shown;
}

/** The facts of items' entities, for the connection reasons and the "What moves with this" block. Empty when no join is wired (the reasons then rest on the basis alone); a failed read throws. */
export async function readItemFacts(db: Db, join: FactsJoin | null, itemIds: readonly string[]): Promise<FactsByItem> {
  if (!join || itemIds.length === 0) return new Map();
  return join.readEntityFacts(db, itemIds);
}

/** The two "Why this matters" lines of structured rows (a series, a fact), per row id. Null when no join is wired: a card then draws no line rather than saying nothing is tied. A failed read throws. */
export async function readWhyMatters(db: Db, join: FactsJoin | null, refTable: string, rows: readonly { id: string; subject: string }[]): Promise<Map<string, string[]> | null> {
  if (!join || rows.length === 0) return null;
  const tied = await join.readFactItems(db, refTable, rows.map((r) => r.id));
  return new Map(rows.map((r) => [r.id, whyLines(tied.get(r.id) ?? [], r.subject)]));
}
