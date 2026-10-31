// New in UI-RADAR-1 (scripts/ci/new-files/ui-radar-1.txt): what the flywheel radar draws, read for one scope. The panel is the customer face of the engine's cross-surface findings: the patterns the pattern step recorded as derived values (emerging or still forming),
// the items and entities each one joins by surface, the signpost that would confirm it, the open needs that say which part of the chain is missing, and the connections still developing. This module reads and composes; it writes nothing, and no method id, uuid or score leaves it.
// The structured-fact joins (src/core/flywheel/facts-join.ts) are read here for the two-line "Why this matters" of a figure and the facts of an item.
import { allRows, boundedRead, fetchAllByIdChunks, isServiceConfigured, rowsByIds, serviceClient, type Db } from "@/core/db";
import { admitItems } from "@/core/derived/admissible";
import { type BasisEntry, CANDIDATE_ORIGIN, type EdgeBasis, evidenceOf } from "@/core/flywheel/discover";
import { DISCOVERY_ORIGIN } from "@/core/flywheel/edges";
import { entityRefs, type FactLink, type FactSummary, readFactItems, type Missing } from "@/core/flywheel/facts-join";
import type { IntersectionDetail } from "@/core/flywheel/intersections";
import { buildSubjectRef, createdBy, GAP_NAMESPACE } from "@/core/flywheel/flags";
import { FACT_SPECS } from "@/core/flywheel/patterns/config";
import { RELATIONS } from "@/core/coupling";
import { PATTERN_METHODS } from "@/core/propagation/methods";
import { formatDate, formatFigure } from "@/core/shared";
import { joinLabels, labelForComplianceObject, labelForScenario } from "@/core/tags/vocabulary";
import { SURFACE_LABELS, SURFACE_ORDER, SURFACE_PATH, surfaceHref, surfaceOf } from "@/core/routing";
import { JURISDICTIONS } from "@/core/workspace/vocabulary";
import { PATTERN_COPY } from "@/features/operations/model/derived-view";
import type { RadarForming, RadarGroup, RadarPattern, RadarView } from "@/ui/flywheel/FlywheelRadar";

export type { RadarForming, RadarGroup, RadarPattern, RadarView };

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
  /** A forming row: the surface that does not yet hold its other half, in words (derived_values.missing). */
  missing?: { surface: string; truth: string; entity?: string | null } | null;
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
/** A forming row is registered under forming_<kind> (patterns/run.ts); the pattern copy is keyed by the method it would become. */
const FORMING_IDS = METHOD_IDS.map((id) => `forming_${id.replace(/^pattern_/, "")}`);
const copyKey = (methodId: string): string => (methodId.startsWith("forming_") ? `pattern_${methodId.slice("forming_".length)}` : methodId);
const SHOWN_PATTERNS = 5;
const SHOWN_FORMING = 3;
const OPEN = ["open", "in_review"];

const inputsOf = (r: PatternRow): Input[] => (Array.isArray(r.inputs) ? (r.inputs as Input[]).filter((i) => i && typeof i.table === "string" && i.pk !== undefined && i.pk !== null) : []);
/** The seed a pattern and its signpost are filed under: the detector kind and the pattern key (computed_by is `method@version:key`). */
const seedOf = (r: PatternRow): string => `${KIND_OF_METHOD[r.method_id]}:${r.computed_by.slice(r.computed_by.indexOf(":") + 1)}`;
/** The surface a pattern-need flag names: the typed action ENGINE-JOIN-1 writes ({ action: "missing", surface }), else for a flag written before it the "Surface <key>;" its description states; a key the routing table does not hold names none. */
const gapSurface = (f: { description: string; recommended_actions: unknown }): string | null => {
  const typed = (Array.isArray(f.recommended_actions) ? f.recommended_actions : []).find((a): a is { surface: string } => !!a && (a as { action?: unknown }).action === "missing" && typeof (a as { surface?: unknown }).surface === "string")?.surface;
  const key = typed ?? /\bSurface (\w+);/.exec(f.description)?.[1];
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
  const read = await boundedRead<PatternRow>((n) => db.from("derived_values_admissible").select("value_id, entity_id, method_id, lifecycle, computed_by, computed_at, inputs").in("method_id", METHOD_IDS).eq("lifecycle", "emerging").order("computed_at", { ascending: false }).order("value_id", { ascending: true }).limit(n) as never, { limit: 200 });
  if (read.error) throw new Error(read.error.message);
  // a forming row is hidden from every admissible read (migration 0145); the radar is the one place it is drawn, as what it is: a chain not yet complete
  const formingRead = await boundedRead<PatternRow>((n) => admin.from("derived_values").select("value_id, entity_id, method_id, lifecycle, computed_by, computed_at, inputs, missing").in("method_id", FORMING_IDS).eq("lifecycle", "forming").order("computed_at", { ascending: false }).order("value_id", { ascending: true }).limit(n) as never, { limit: 200 });
  if (formingRead.error) throw new Error(formingRead.error.message);
  const surfaceOfRow = (r: PatternRow): Set<string> => new Set(inputsOf(r).map((i) => i.surface).filter((s): s is string => !!s && !!SURFACE_LABELS[s]));
  let rows = [...read.data, ...formingRead.data].filter((r) => copyKey(r.method_id) in PATTERN_COPY);
  if (scope.kind === "surface") rows = rows.filter((r) => surfaceOfRow(r).has(scope.surface));
  // a pattern that spans surfaces is the finding; the widest first, an emerging one before one still forming
  rows = rows.sort((a, b) => surfaceOfRow(b).size - surfaceOfRow(a).size || Number(a.lifecycle === "forming") - Number(b.lifecycle === "forming")).slice(0, scope.kind === "item" ? 40 : 80);
  const allInputs = rows.flatMap(inputsOf);
  const ownerOf = await itemsOfInputs(db, allInputs);
  if (scope.kind === "item") {
    const mine = new Set([scope.itemUuid, ...scope.memberIds]);
    rows = rows.filter((r) => inputsOf(r).some((i) => mine.has(ownerOf.get(`${i.table}/${i.pk}`) ?? "")));
  }
  const items = await readItems(db, [...new Set(rows.flatMap((r) => inputsOf(r).map((i) => ownerOf.get(`${i.table}/${i.pk}`)).filter((x): x is string => !!x)))]);
  const names = new Map([...(await entityRefs(db, new Set(rows.flatMap((r) => inputsOf(r).flatMap((i) => i.entities ?? []))))).values()].map((e) => [e.id, e.canonicalName]));
  const seeds = rows.filter((r) => r.lifecycle === "emerging").map(seedOf);
  const posts = await rowsByIds<{ predicate: { pattern?: string; key_date?: string } | null; outcome: string | null; watches: string }>(admin, "signposts", "predicate,outcome,watches", rows.map((r) => r.entity_id), "watches", "entity_id");
  const watchOf = new Map(posts.filter((p) => !p.outcome && p.predicate?.pattern && seeds.includes(p.predicate.pattern)).map((p) => [p.predicate?.pattern as string, p.predicate?.key_date ?? null]));
  const flags = await allRows<{ id: string; subject_ref: string; description: string; recommended_actions: unknown }>(admin, "integrity_flags", "id,subject_ref,description,recommended_actions", { cap: 5_000, where: (q) => q.like("created_by", `${createdBy(GAP_NAMESPACE, "pattern_")}%`).in("status", OPEN) });
  // one card per pattern: rows of one method that join the same members (the same items and entities on each surface) differ only in the date they watch, so they are one card listing every date
  const cards = new Map<string, RadarPattern & { dates: string[]; watching: boolean; absent: string[] }>();
  for (const r of rows) {
    const copy = PATTERN_COPY[copyKey(r.method_id)] as (typeof PATTERN_COPY)[string];
    const forming = r.lifecycle === "forming";
    const seed = forming ? "" : seedOf(r);
    const ins = inputsOf(r);
    const groups: RadarGroup[] = SURFACE_ORDER.flatMap((surface) => {
      const here = ins.filter((i) => i.surface === surface);
      const found = [...new Map(here.flatMap((i) => { const it = items.get(ownerOf.get(`${i.table}/${i.pk}`) ?? ""); return it ? [[it.id, { id: it.id, title: shortTitle(it.title), href: surfaceHref(surfaceOf(it.item_type, it.domain), it.legacy_id || it.id) as string }] as const] : []; })).values()].sort((x, y) => x.id.localeCompare(y.id));
      const who = [...new Set(here.flatMap((i) => (i.entities ?? []).map((e) => names.get(e)).filter((n): n is string => !!n)))].sort();
      return here.length ? [{ surface, label: SURFACE_LABELS[surface] as string, href: SURFACE_PATH[surface] as string, items: found.map(({ title, href }) => ({ title, href })), names: who }] : [];
    });
    const keys = new Set(ins.map((i) => buildSubjectRef("trigger", i.table, i.pk)));
    const parts = flags.filter((f) => (seed && f.subject_ref.startsWith(`pattern:${seed}:`)) || keys.has(f.subject_ref)).map(gapSurface).filter((s): s is string => !!s);
    const id = JSON.stringify([forming, copyKey(r.method_id), groups.map((g) => [g.surface, g.items.map((it) => it.href), g.items.length ? [] : g.names])]);
    const card = cards.get(id) ?? { key: r.value_id, label: forming ? copy.forming : copy.label, means: forming ? "The chain is not complete yet; the reading below is what is linked so far." : copy.means, forming, groups, watch: null, missingParts: [], next: forming ? (r.missing?.truth?.trim() || null) : null, dates: [], watching: false, absent: [] };
    if (watchOf.has(seed)) {
      card.watching = true;
      const date = watchOf.get(seed);
      if (date && !card.dates.includes(date)) card.dates.push(date);
    }
    // a missing part names a surface the card does not hold: a surface it holds is not missing
    card.absent.push(...parts.filter((s) => !groups.some((g) => g.surface === s)));
    cards.set(id, card);
  }
  const patterns = [...cards.values()].slice(0, SHOWN_PATTERNS).map(({ dates, watching, absent, ...card }): RadarPattern => ({
    ...card,
    watch: !watching ? null : dates.length === 0 ? "Watch: confirmed while the evidence behind it keeps holding." : `Watch: confirmed if the dated ${dates.length === 1 ? "step still stands" : "steps still stand"} on ${joinLabels([...dates].sort().map(dateWords))}.`,
    missingParts: [...new Set(absent)].map((s) => `Missing part: no ${SURFACE_LABELS[s]} item yet; the chain is incomplete until one appears.`),
  }));
  return { patterns, forming: scope.kind === "item" ? [] : await readForming(db, scope) };
}

/** The connections still developing: candidate edges, each as the two items already linked, why, and the next link to watch. */
async function readForming(db: Db, scope: RadarScope): Promise<RadarForming[]> {
  const edges = await boundedRead<{ source_item_id: string; target_item_id: string; basis: Parameters<typeof reasonFor>[0]["basis"]; score: number | null }>((n) => db.from("item_cross_references").select("source_item_id, target_item_id, basis, score").eq("origin", CANDIDATE_ORIGIN).order("score", { ascending: false }).limit(n) as never, { limit: 60 });
  if (edges.error) throw new Error(edges.error.message);
  const items = await readItems(db, edges.data.flatMap((e) => [e.source_item_id, e.target_item_id]));
  const shown: RadarForming[] = [];
  for (const e of edges.data) {
    const [a, b] = [items.get(e.source_item_id), items.get(e.target_item_id)];
    if (!a || !b) continue;
    const chain = [a, b].map((it) => ({ title: it.title, surface: surfaceOf(it.item_type, it.domain), href: surfaceHref(surfaceOf(it.item_type, it.domain), it.legacy_id || it.id) as string }));
    if (scope.kind === "surface" && !chain.some((c) => c.surface === scope.surface)) continue;
    const basis = e.basis && !Array.isArray(e.basis) ? e.basis : null;
    shown.push({ key: `${e.source_item_id}|${e.target_item_id}`, family: familyWords(basis?.missing?.patternFamily), chain, reason: reasonFor({ basis: e.basis, origin: CANDIDATE_ORIGIN, label: "Related" }) ?? "A chain is forming between the two.", next: basis?.missing?.truth?.trim() || null });
    if (shown.length >= SHOWN_FORMING) break;
  }
  return shown;
}

/** The two "Why this matters" lines of structured rows (a series, a fact), per row id: the regulation tied to the figure's entity with its next dated obligation and penalty, and the operations, market or research item tied to it. */
export async function readWhyMatters(db: Db, refTable: string, rows: readonly { id: string; subject: string }[], nowIso: string): Promise<Map<string, string[]>> {
  if (rows.length === 0) return new Map();
  const tied = await readFactItems(db, refTable, rows.map((r) => r.id), new Date(nowIso));
  return new Map(rows.map((r) => [r.id, whyLines(tied.get(r.id) ?? [], r.subject)]));
}

// -- the sentences: why two items connect (from the typed basis and the typed facts), what a figure matters to, what moves with an item -------------------------------------
export const asBasis = (b: EdgeBasis | null | undefined): { evidence: BasisEntry[]; missing: Missing | null; rationale: string | null } => {
  const o = b && !Array.isArray(b) ? b : null;
  return { evidence: evidenceOf(b), missing: o?.missing ?? null, rationale: o?.rationale?.text.trim() || null };
};

// the evidence kinds, strongest first
const KIND_ORDER = ["shared_entity", "shared_regulation_identifier", "shared_title_entity", "coupled_entity"] as const;
/** A relation token in words, for "{A} {relation} {B}" (the closed RELATIONS of the coupling ontology). */
const RELATION_WORDS: Readonly<Record<(typeof RELATIONS)[number], string>> = { feedstock_of: "is a feedstock of", fuel_for_mode: "fuels", competes_for_feedstock: "competes for feedstock with", shares_grid_zone: "shares a grid zone with", serves_hub: "serves", corridor_links: "links to", implements: "implements", amends: "amends", consignment_wide: "applies across the same consignment as" };
/** The reason an explicit relationship states by itself (the legal edges, which need no evidence) and what a plain citation says. */
const RELATION_REASON: Readonly<Record<string, string>> = { Supersedes: "Replaces prior statutory provisions.", "Superseded by": "Succeeded by newer legislation.", Implements: "Technical execution of the parent framework.", "Implemented by": "Carried out by implementing legislation.", Amends: "Modifies the text or scope of the other.", "Amended by": "Updated by a later amendment.", "Conflicts with": "Its requirements conflict with this one.", "Depends on": "This depends on it being in force." };
const CITATION_REASON: Readonly<Record<string, string>> = { References: "Cited directly in the source text.", "Referenced by": "Cites this item directly in its source text." };

/** The entities an evidence entry names: the typed canonical names, or the stored detail ("both name reg:x, y"). */
const entityNames = (e: BasisEntry): string[] => {
  const typed = (e.tokens?.entities ?? []).map((x) => x.name?.trim() ?? "").filter(Boolean);
  return typed.length ? typed : typeof e.detail === "string" && e.signal === "shared_entity" ? e.detail.replace(/^both name /, "").split(", ").map((x) => x.replace(/^reg:/, "")).filter(Boolean) : [];
};
/** The scenario or object tokens of an evidence entry: the typed tokens, or the stored detail ("both touch x", the intersection's lists). */
const tokensOf = (e: BasisEntry, kind: "scenarios" | "objects"): string[] => {
  const typed = e.tokens?.[kind];
  if (typed?.length) return typed;
  const d = e.detail;
  if (typeof d === "string") return e.signal === (kind === "scenarios" ? "shared_scenario" : "shared_compliance_object") ? [d.replace(/^both (?:touch|address) /, "")].filter(Boolean) : [];
  return (d && typeof d === "object" ? (d as IntersectionDetail)[kind] : undefined) ?? [];
};
const dateWords = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? formatDate(iso.slice(0, 10)) : iso);
/** An item's title as a card shows it: as written up to 90 characters, else cut at the last whole word with an ellipsis (the title stays whole on the item's page and in the link's title). */
const shortTitle = (title: string, max = 90): string => (title.length <= max ? title : `${title.slice(0, max).replace(/\s+\S*$/, "").replace(/[\s,;:(–—-]+$/, "")}…`);
/** A jurisdiction token in words: the workspace vocabulary's label, else a short code in capitals. */
const placeWords = (token: string): string => JURISDICTIONS.find((j) => j.id === token.toLowerCase())?.label ?? (token.length <= 3 ? token.toUpperCase() : token);
/** The jurisdictions and topics of a jurisdiction-and-topic entry: the typed tokens, or the stored detail ("both in sg/us on fuels/emissions"). */
const placeOf = (e: BasisEntry): { where: string[]; topics: string[] } => {
  const d = typeof e.detail === "string" ? /^both in (.+?) on (.+)$/.exec(e.detail) : null;
  return { where: e.tokens?.jurisdictions ?? d?.[1]?.split("/") ?? [], topics: e.tokens?.topics ?? d?.[2]?.split("/") ?? [] };
};
/** The quoted names of a stored detail (`both name regulation identifier(s) "2099/2002" in their titles`). */
const quoted = (e: BasisEntry): string[] => (typeof e.detail === "string" ? [...e.detail.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string) : []);

/** One sentence about the PAIR from the strongest typed evidence the basis holds, in words; null when the basis holds none that states anything (an entry of the same source alone is corroboration, not a connection). */
function evidenceSentence(evidence: readonly BasisEntry[]): string | null {
  for (const k of KIND_ORDER) {
    const hits = evidence.filter((e) => e.signal === k);
    const first = hits[0];
    if (!first) continue;
    if (k === "shared_entity") {
      const n = [...new Set(hits.flatMap(entityNames))];
      if (n.length) return `Both concern ${joinLabels(n)}.`;
    } else if (k === "shared_title_entity" || k === "shared_regulation_identifier") {
      const n = [...new Set(hits.flatMap(quoted))];
      if (n.length) return `Both name ${k === "shared_regulation_identifier" ? "regulation " : ""}${joinLabels(n)} in their titles.`;
    } else {
      const c = first.tokens?.coupled?.[0];
      const rel = RELATION_WORDS[c?.relation as (typeof RELATIONS)[number]];
      if (c?.parent.name && c.child.name && rel) return `${c.parent.name} ${rel} ${c.child.name}, so a change in one reaches the other.`;
    }
  }
  // tag level: the operating context the two share, every typed kind of it in words (the scenarios, the place and topic, the party addressed)
  const of = (signals: readonly string[], kind: "scenarios" | "objects"): string[] => evidence.filter((e) => signals.includes(e.signal)).flatMap((e) => tokensOf(e, kind));
  const scn = [...new Set(of(["shared_scenario", "intersection"], "scenarios").map(labelForScenario).filter(Boolean))];
  const objs = [...new Set(of(["shared_compliance_object", "intersection"], "objects").map(labelForComplianceObject).filter(Boolean))];
  const place = evidence.filter((e) => e.signal === "shared_jurisdiction_topic").map(placeOf);
  const where = [...new Set(place.flatMap((p) => p.where).map(placeWords))];
  const topics = [...new Set(place.flatMap((p) => p.topics).map(labelForScenario))];
  const apply = scn.length || where.length ? `apply to ${scn.length ? `${joinLabels(scn)} operations` : "operations"}${where.length ? ` in ${joinLabels(where)}` : ""}${topics.length ? ` on ${joinLabels(topics)}` : ""}` : "";
  const parts = [apply, objs.length ? `address ${joinLabels(objs)}` : ""].filter(Boolean);
  return parts.length ? `Both ${parts.join(" and ")}.` : null;
}

// -- the causal chain: the facts both items are tied to, strongest kind first ----------------------------------------------------------------------
const FACT_KIND: Readonly<Record<string, number>> = { statutory_computations: 0, market_series: 1, reroute_events: 2, grid_connection_queues: 2, emission_factors: 2, regional_data_facts: 2, state_cost_facts: 2, oem_tech_roadmaps: 3 };
const figureWords = (s: FactSummary): string => (s.value === undefined ? "" : `${formatFigure(s.value)}${s.unit ? ` ${s.unit}` : ""}`);
/** One fact as one plain sentence, from the typed fields it holds; null when the link states nothing a reader could use. */
function factSentence(f: FactLink): string | null {
  const s = f.summary;
  const name = s.label ?? f.entity.canonicalName;
  const asOf = s.asOf ? ` (as of ${dateWords(s.asOf)})` : "";
  const move = s.delta?.week !== undefined ? { pct: s.delta.week * 100, span: "week" } : s.delta?.month !== undefined ? { pct: s.delta.month * 100, span: "month" } : null;
  switch (FACT_KIND[f.refTable]) {
    case 0: return s.value !== undefined ? `${name} states ${figureWords(s)}${asOf}.` : null;
    case 1:
      if (move) return `${name} ${move.pct >= 0 ? "rose" : "fell"} ${Math.abs(move.pct).toFixed(1)}% over the last ${move.span}.`;
      return s.value !== undefined ? `${name} stands at ${figureWords(s)}${asOf}.` : null;
    case 2: return s.value !== undefined ? `${name}: ${figureWords(s)}${asOf}.` : null;
    case 3: return s.stage ? `${name} is at the ${s.stage.replace(/_/g, " ")} stage${s.date ? `, targeting ${s.date.slice(0, 4)}` : ""}.` : null;
    default: return null;
  }
}
const byStrength = (both: ReadonlySet<string>) => (x: FactLink, y: FactLink): number => (FACT_KIND[x.refTable] ?? 9) - (FACT_KIND[y.refTable] ?? 9) || Number(both.has(y.entity.id)) - Number(both.has(x.entity.id)) || x.hop - y.hop;
/** The chain the two items share: only facts tied to an entity BOTH reach (a fact that belongs to one side alone says nothing about the pair), at most one sentence per kind (obligation, figure, operational constraint, technology). */
function chainOf(a: readonly FactLink[], b: readonly FactLink[]): string | null {
  const both = new Set(a.map((f) => f.entity.id).filter((id) => b.some((g) => g.entity.id === id)));
  const ranked = [...a, ...b].filter((f) => FACT_KIND[f.refTable] !== undefined && both.has(f.entity.id)).sort(byStrength(both));
  const lines: string[] = [];
  for (const kind of [0, 1, 2, 3]) {
    const line = ranked.filter((f) => FACT_KIND[f.refTable] === kind).map(factSentence).find((x): x is string => !!x);
    if (line && !lines.includes(line)) lines.push(line);
  }
  return lines.length ? lines.join(" ") : null;
}

/**
 * Why two items are connected, as one short passage about the PAIR that a reader without a sustainability background can act on: the reader's own rationale first, then what an explicit relationship says, then what the typed evidence states
 * (the shared entity, the coupled relation, the shared operating context) followed by the facts tied to an entity both items reach. Null for an edge whose only evidence is the same source (it corroborates; it never connects).
 */
export function reasonFor(c: { basis: EdgeBasis | null | undefined; origin: string; label: string }, facts: { self?: readonly FactLink[]; other?: readonly FactLink[] } = {}): string | null {
  const { evidence, rationale } = asBasis(c.basis);
  const pair = [evidenceSentence(evidence), chainOf(facts.self ?? [], facts.other ?? [])].filter(Boolean).join(" ");
  return rationale ?? RELATION_REASON[c.label] ?? (pair || null) ?? (evidence.length > 0 && c.origin === DISCOVERY_ORIGIN ? null : (CITATION_REASON[c.label] ?? null));
}

/** What a set of edges is mostly linked by, in words: the canonical names of the entities they share and the scenarios they touch, most frequent first. The same source is not a link. */
function linkedByWords(bases: readonly (EdgeBasis | null | undefined)[], top = 3): string[] {
  const tally = new Map<string, number>();
  for (const b of bases) {
    const words = new Set(asBasis(b).evidence.flatMap((e) => [...entityNames(e), ...(e.signal === "shared_title_entity" || e.signal === "shared_regulation_identifier" ? quoted(e) : []), ...(e.signal === "shared_scenario" ? tokensOf(e, "scenarios").map(labelForScenario) : [])]).filter(Boolean));
    for (const w of words) tally.set(w, (tally.get(w) ?? 0) + 1);
  }
  return [...tally].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, top).map(([w]) => w);
}

/** The family a forming chain is called, from the detector kind (or the method id) the typed `patternFamily` names. */
export const familyWords = (family: string | undefined | null): string | null => (family ? (PATTERN_COPY[PATTERN_METHODS[family as keyof typeof PATTERN_METHODS]?.id ?? family]?.forming ?? null) : null);

// -- the two sentences under a figure, and the rows that move with an item --------------------------------------------------------------------------
const KIND_LABELS = ["Obligation", "Price or figure", "Operating constraint", "Technology"] as const;
const surfaceName = (s: string): string => SURFACE_LABELS[s] ?? s;
/**
 * "Why this matters" under a figure: two lines. The first names the regulation(s) tied to the figure's entity with the next dated obligation and the penalty; the second the operations, market or research item tied to it. A line with
 * nothing behind it names the surface that holds nothing (an absence is a sentence, never a blank). `links` are the items tied to the figure's row (facts-join readFactItems); `subject` is the figure in the reader's words.
 */
export function whyLines(links: readonly FactLink[], subject: string): string[] {
  const regs = links.filter((l) => l.surface === "regulations");
  const others = links.filter((l) => l.surface !== "regulations");
  const reg = regs[0];
  const first = reg ? `${reg.summary.label ?? reg.entity.canonicalName}${reg.summary.date ? `: next dated obligation ${dateWords(reg.summary.date)}` : ""}${reg.summary.penalty ? `, penalty ${formatFigure(reg.summary.penalty.value)} ${reg.summary.penalty.unit}` : ""}${regs.length > 1 ? `, and ${regs.length - 1} more regulation${regs.length > 2 ? "s" : ""}` : ""}.` : `No regulation in the ledger is tied to ${subject} yet.`;
  const other = others[0];
  const second = other ? `Also tied: ${other.summary.label ?? other.entity.canonicalName} (${surfaceName(other.surface)})${others.length > 1 ? `, and ${others.length - 1} more` : ""}.` : `No operations, market or research item is tied to ${subject} yet.`;
  return [first, second];
}

/** The rows that move with an item: each structured row tied to its entities as one line (the figure, its date or delta, and the entity it moves through), the strongest kind first. */
function movesRows(links: readonly FactLink[], limit = 8): { kind: string; line: string }[] {
  const seen = new Set<string>();
  const out: { kind: string; line: string }[] = [];
  for (const f of [...links].filter((l) => FACT_KIND[l.refTable] !== undefined).sort(byStrength(new Set()))) {
    const s = factSentence(f);
    const via = f.hop === 1 ? ` It reaches this item through ${f.entity.canonicalName}.` : "";
    const key = `${f.refTable}/${f.refId}`;
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: KIND_LABELS[FACT_KIND[f.refTable] as number] as string, line: `${s}${via}` });
    if (out.length >= limit) break;
  }
  return out;
}

/** What a theme with no usable brief is mostly linked by, in words: read from the bases of a sample of its edges (the first 200 members' edges, candidates left out), bounded for a theme of hundreds. */
export const readLinkedBy = async (db: Db, memberIds: readonly string[]): Promise<string[]> =>
  linkedByWords(await fetchAllByIdChunks(memberIds.slice(0, 200), async (slice) => {
    const r = await db.from("item_cross_references").select("basis").in("source_item_id", slice).neq("origin", CANDIDATE_ORIGIN).limit(300);
    if (r.error) throw new Error(`item_cross_references read failed: ${r.error.message}`);
    return ((r.data ?? []) as { basis: EdgeBasis | null }[]).map((x) => x.basis);
  }, { chunk: 100, manyPerId: true }));

/** The theme chips with their names: a theme no brief names is called by what its edges are mostly linked by (up to three; read for the few chips drawn, never for the 25 considered), and two chips never read the same (a label already drawn takes the title of the member it opens). */
export async function nameChips<C extends { themeId: string; label: string; itemTitle: string; hasBrief: boolean }>(db: Db, chips: readonly C[], themes: readonly { id: string; member_ids: readonly string[] }[]): Promise<(C & { linkedBy: string[] })[]> {
  const drawn = new Set<string>();
  const by = await Promise.all(chips.map((c) => readLinkedBy(db, themes.find((t) => t.id === c.themeId)?.member_ids ?? []).then((w) => w.slice(0, 3))));
  return chips.map((c, i) => {
    const linkedBy = by[i] ?? [];
    const named = !c.hasBrief && linkedBy.length > 0 ? `Linked by ${joinLabels(linkedBy)}` : c.label;
    const label = drawn.has(named) ? `${named} · ${c.itemTitle}` : named;
    drawn.add(label);
    return { ...c, label, linkedBy };
  });
}

/** What a detail page adds under Connected intelligence: the patterns resting on the item or its theme (null: that read failed), and the structured rows tied to its entities. */
export const readItemExtras = async (db: Db, itemUuid: string, memberIds: readonly string[], facts: readonly FactLink[]) => ({ radar: await readFlywheelRadar(radarClients(db), { kind: "item", itemUuid, memberIds }).catch(() => null), moves: movesRows(facts) });
export type ItemExtras = Awaited<ReturnType<typeof readItemExtras>>;
