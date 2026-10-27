// New in ENGINE-UNBLOCK-1 lane C (scripts/ci/new-files/engine-unblock-1c.txt), operator rulings 2026-10-26 (the live graph is the ontology; the AI defines the patterns): the admin finding validator for a CLUSTER synthesis. One entry answers one cluster of the graph (lane B's
// assembleClusters) with pattern rows, findings, tagged inferences, and the shared write-back (signposts, coverage gaps, new connections). Code verifies every claim against the stored records and refuses the entry naming each failing element: a cited table and pk that is
// not a row of the cluster, an entity id that does not exist, a figure or a date that differs from the stored value, a quote that is not verbatim in the capture of the row it cites. A refusal never drops an element silently. Pure over the live material the caller supplies.
import { createHash } from "node:crypto";

import { isVerbatim, locateSpan } from "@/core/contracts/verbatim";
import { LENSES, WINDOWS } from "@/core/digest/kinds";
import { review, singleSourceReason } from "@/core/digest/review";
import type { Angle, Cluster, ClusterRow } from "@/core/flywheel/clusters";
import type { InputRef } from "@/core/propagation";

import { EDGE_TABLES, verifyWriteback, writebackHeld, type HeldWriteback, type WritebackPlan } from "../../kit/writeback";
import { isObj, nonEmpty, type Locate, type Obj } from "../../kit/session-batch";

import { ANGLES } from "./angles";

const CITATION = /\[([a-z_]+:[^\]\s]+)\]/g;
const TOKENS = ["CONFIRMED", "HYPOTHESIS", "REFUTED"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const METHOD_VERSION = "reader-synthesis@1.0.0";
export const methodIdOf = (angle: Angle): string => `pattern_ai_${angle}`;
/** The identity a pattern is stored under, and the cluster a stored identity belongs to (a cluster id may itself hold colons: the angle and the hash are the last two segments). */
export const SYNTHESIS_PREFIX = "reader-synthesis:";
const computedByOf = (cluster: string, angle: string, hash: string): string => `${SYNTHESIS_PREFIX}${cluster}:${angle}:${hash}`;
export const clusterOfComputedBy = (computedBy: unknown): string | null => {
  if (typeof computedBy !== "string" || !computedBy.startsWith(SYNTHESIS_PREFIX)) return null;
  const body = computedBy.slice(SYNTHESIS_PREFIX.length);
  const cut = body.lastIndexOf(":", body.lastIndexOf(":") - 1);
  return cut > 0 ? body.slice(0, cut) : null;
};
const rowKey = (r: { table: string; pk: string }): string => `${r.table}:${r.pk}`;

export interface SynthLive {
  clusters: ReadonlyMap<string, Cluster>;
  /** capture id to its full text, for every quote_capture_id of the loaded clusters. */
  captures: ReadonlyMap<string, string>;
  /** entity ids that exist and are active. */
  entities: ReadonlyMap<string, string>;
  /** cluster id to the value ids of the detector patterns attached to it (one more input, citable by a finding). */
  detectors: ReadonlyMap<string, readonly string[]>;
  /** cluster id to the intelligence items its rows belong to. */
  items: ReadonlyMap<string, readonly string[]>;
  /** The stored reader patterns (computed_by to value id) and the stored current findings (value id | title | finding hash). */
  stored: { patterns: ReadonlyMap<string, string>; findings: ReadonlySet<string> };
  /** What an earlier apply already wrote of the entries' write-back (a re-apply of the same entry is "already applied"). */
  held: HeldWriteback;
  now: Date;
  locate?: Locate | null | undefined;
}
export interface PatternPlan { ref: string; angle: Angle; computedBy: string; entityId: string | null; inputs: InputRef[]; rowCount: number }
export interface FindingPlan { patternRef: string | null; patternValueId: string | null; lens: string; window: string; title: string; md: string; inferences: Obj[]; claimProvenance: Obj[] }
export interface TaggedPlan { text: string; statusToken: "CONFIRMED" | "HYPOTHESIS" | "REFUTED"; basis: string[] }
export interface SynthPlan { cluster: Cluster; patterns: PatternPlan[]; findings: FindingPlan[]; tagged: TaggedPlan[]; wb: WritebackPlan; items: string[]; cited: string[]; score: number; reasons: string; reviewer: string; entry: Obj }
export const findingKey = (valueId: string, title: string, md: string): string => `${valueId}|${title}|${createHash("sha256").update(md).digest("hex").slice(0, 16)}`;

const sameFigure = (a: { value: number; unit: string } | null, b: unknown): boolean => !!a && isObj(b) && b.value === a.value && b.unit === a.unit;

/** One entry against its cluster: the refusals (each names the element), the residue (the single-source test, the second reader) and the plan. */
export function validateSynthesisEntry(e: unknown, i: number, live: SynthLive): { errors: string[]; residue?: string[]; plan?: SynthPlan; done?: boolean } {
  if (!isObj(e)) return { errors: [`entries[${i}]: must be an object`] };
  const tag = `cluster ${String(e.cluster_id)}`;
  const errors: string[] = [];
  const at = (where: string, m: string): void => void errors.push(`${tag} ${where}: ${m}`);
  if (!nonEmpty(e.cluster_id)) return { errors: [`entries[${i}]: cluster_id must be a non-empty string`] };
  const cluster = live.clusters.get(e.cluster_id);
  if (!cluster) return { errors: [`${tag}: this cluster does not assemble from the stored records now (it was never exported, or its rows changed); re-export and re-author`] };
  const rows = new Map<string, ClusterRow>(cluster.rows.map((r) => [rowKey(r), r]));
  const quoteOf = (v: unknown, row: ClusterRow, where: string): { capture_id: string; text: string } | null => {
    if (!isObj(v) || !nonEmpty(v.capture_id) || !nonEmpty(v.text)) return (at(where, "quote must be { capture_id, text }"), null);
    if (v.capture_id !== row.quote_capture_id) return (at(where, `capture ${v.capture_id} is not the capture of ${rowKey(row)} (${row.quote_capture_id ?? "it has none"})`), null);
    const cap = live.captures.get(v.capture_id);
    const slice = cap === undefined ? null : (live.locate ?? locateSpan)(cap, v.text);
    if (cap === undefined || slice === null || !isVerbatim(cap, slice)) return (at(where, `the quote is not verbatim in capture ${v.capture_id}: ${JSON.stringify(v.text.slice(0, 80))}`), null);
    return { capture_id: v.capture_id, text: slice };
  };
  const rowOf = (v: unknown, where: string): ClusterRow | null => {
    const key = isObj(v) && typeof v.table === "string" && typeof v.pk === "string" ? rowKey({ table: v.table, pk: v.pk }) : null;
    const r = key ? rows.get(key) : undefined;
    if (!r) return (at(where, `${key ?? JSON.stringify(v)} is not a row of the cluster: its table and pk do not exist among the stored records this cluster was assembled from`), null);
    if (!(EDGE_TABLES as readonly string[]).includes(r.table)) return (at(where, `table ${r.table} is not an admitted evidence table (migration 0134)`), null);
    return r;
  };
  const entityOk = (id: unknown, where: string): void => void (typeof id === "string" && live.entities.has(id) ? null : at(where, `entity id ${JSON.stringify(id)} does not exist among the active entities`));
  const patterns: PatternPlan[] = [];
  const cited = new Set<string>();
  const list = (b: string): unknown[] => (e[b] === undefined ? [] : Array.isArray(e[b]) ? (e[b] as unknown[]) : (at(b, "must be an array"), []));
  list("patterns").forEach((p, k) => {
    const where = `patterns[${k}]`;
    if (!isObj(p) || !nonEmpty(p.ref) || !(ANGLES as readonly unknown[]).includes(p.kind) || !Array.isArray(p.rows_cited) || !p.rows_cited.length || !Array.isArray(p.reasoning) || !p.reasoning.length) return at(where, `must be { ref, kind (${ANGLES.join(", ")}), rows_cited: [{ table, pk }], reasoning: [{ cause, effect, row, quote }] }`);
    if (patterns.some((x) => x.ref === p.ref)) return at(where, `ref ${p.ref} repeats an earlier pattern`);
    const rc = p.rows_cited.flatMap((r, j) => rowOf(r, `${where}.rows_cited[${j}]`) ?? []);
    if (rc.length !== p.rows_cited.length) return;
    const byRow = new Map<string, { cause: string; effect: string; quote: { capture_id: string; text: string }; figure?: unknown; date?: string }[]>();
    p.reasoning.forEach((l, j) => {
      const w = `${where}.reasoning[${j}]`;
      if (!isObj(l) || !nonEmpty(l.cause) || !nonEmpty(l.effect)) return at(w, "must be { cause, effect, row: { table, pk }, quote: { capture_id, text } }: cause and effect at every link");
      const row = rowOf(l.row, `${w}.row`);
      if (!row) return;
      if (!rc.includes(row)) return at(w, `${rowKey(row)} is not among the pattern's rows_cited`);
      const q = quoteOf(l.quote, row, `${w}.quote`);
      if (l.figure !== undefined && !sameFigure(row.figure, l.figure)) at(w, `figure ${JSON.stringify(l.figure)} differs from the stored value of ${rowKey(row)} (${JSON.stringify(row.figure)})`);
      if (l.date !== undefined && l.date !== row.date) at(w, `date ${JSON.stringify(l.date)} differs from the stored date of ${rowKey(row)} (${JSON.stringify(row.date)})`);
      if (q) byRow.set(rowKey(row), [...(byRow.get(rowKey(row)) ?? []), { cause: l.cause.trim(), effect: l.effect.trim(), quote: q, ...(l.figure !== undefined ? { figure: l.figure } : {}), ...(typeof l.date === "string" ? { date: l.date } : {}) }]);
    });
    for (const r of rc) if (!byRow.has(rowKey(r))) at(where, `${rowKey(r)} is cited but no reasoning link quotes it`);
    const own = Array.isArray(p.entity_ids) ? p.entity_ids : [];
    own.forEach((id, j) => entityOk(id, `${where}.entity_ids[${j}]`));
    rc.forEach((r) => cited.add(rowKey(r)));
    const inputs: InputRef[] = rc.map((r) => ({ table: r.table, pk: r.pk, kind: "evidence", entities: r.entity_ids, surface: r.surface, ...(r.date ? { at: r.date } : {}), basis: { links: byRow.get(rowKey(r)) ?? [] } }) as InputRef);
    const hash = createHash("sha256").update(JSON.stringify({ k: p.kind, r: rc.map(rowKey).sort(), l: [...byRow.entries()].sort(([a], [b]) => a.localeCompare(b)) })).digest("hex").slice(0, 12);
    patterns.push({ ref: p.ref, angle: p.kind as Angle, computedBy: computedByOf(cluster.id, p.kind as string, hash), entityId: (own[0] as string | undefined) ?? cluster.anchor_entity_ids[0] ?? null, inputs, rowCount: rc.length });
  });
  const findings: FindingPlan[] = [];
  list("findings").forEach((f, k) => {
    const where = `findings[${k}]`;
    if (!isObj(f) || !nonEmpty(f.title) || f.title.length > 160 || !nonEmpty(f.sourced_finding_md)) return at(where, "must be { pattern_ref | pattern_value_id, lens, window, title (1 to 160), sourced_finding_md }");
    if (!(LENSES as readonly unknown[]).includes(f.lens)) at(where, `lens must be one of ${LENSES.join(", ")}`);
    if (!(WINDOWS as readonly unknown[]).includes(f.window)) at(where, `window must be one of ${WINDOWS.join(", ")}`);
    const detector = typeof f.pattern_value_id === "string" ? f.pattern_value_id : null;
    if ((f.pattern_ref === undefined) === (detector === null)) return at(where, "names exactly one of pattern_ref (a pattern of this entry) and pattern_value_id (a detector pattern attached to this cluster)");
    if (detector !== null && (!UUID.test(detector) || !(live.detectors.get(cluster.id) ?? []).includes(detector))) return at(where, `pattern_value_id ${detector} is not a detector pattern attached to this cluster`);
    if (detector === null && !patterns.some((p) => p.ref === f.pattern_ref)) return at(where, `pattern_ref ${JSON.stringify(f.pattern_ref)} is not a pattern of this entry`);
    for (const m of (f.sourced_finding_md as string).matchAll(CITATION)) { const key = m[1] as string; if (rows.has(key)) cited.add(key); else at(where, `cites ${key}, which is not a row of the cluster`); }
    if (!(f.sourced_finding_md as string).match(CITATION)) at(where, "the sourced finding cites no cluster row ([table:pk])");
    const inferences = (Array.isArray(f.inferences) ? f.inferences : []).flatMap((x, j) => {
      if (!isObj(x) || !nonEmpty(x.text) || !TOKENS.includes(x.status_token as string) || !Array.isArray(x.basis) || !x.basis.length) return (at(`${where}.inferences[${j}]`, `must be { text, status_token (${TOKENS.join(", ")}), basis: [cluster rows] }`), []);
      for (const b of x.basis) if (typeof b !== "string" || !rows.has(b)) at(`${where}.inferences[${j}]`, `basis ${JSON.stringify(b)} is not a row of the cluster`); else cited.add(b);
      return [x];
    });
    const provenance = (Array.isArray(f.claim_provenance) ? f.claim_provenance : []).flatMap((c, j) => {
      const row = isObj(c) && typeof c.row === "string" ? rows.get(c.row) : undefined;
      if (!isObj(c) || !row) return (at(`${where}.claim_provenance[${j}]`, `row ${JSON.stringify(isObj(c) ? c.row : c)} is not a row of the cluster`), []);
      const q = quoteOf({ capture_id: row.quote_capture_id, text: c.span }, row, `${where}.claim_provenance[${j}]`);
      if (!q) return [];
      cited.add(rowKey(row));
      return [{ row: c.row, span: q.text, capture_id: q.capture_id }];
    });
    findings.push({ patternRef: detector === null ? (f.pattern_ref as string) : null, patternValueId: detector, lens: f.lens as string, window: f.window as string, title: f.title.trim(), md: f.sourced_finding_md as string, inferences, claimProvenance: provenance });
  });
  const tagged: TaggedPlan[] = list("tagged_inferences").flatMap((x, j) => {
    if (!isObj(x) || !nonEmpty(x.text) || !TOKENS.includes(x.status_token as string) || !Array.isArray(x.basis) || !x.basis.length) return (at(`tagged_inferences[${j}]`, `must be { text, status_token (${TOKENS.join(", ")}), basis: [cluster rows] }`), []);
    for (const b of x.basis) if (typeof b !== "string" || !rows.has(b)) at(`tagged_inferences[${j}]`, `basis ${JSON.stringify(b)} is not a row of the cluster`); else cited.add(b);
    return [{ text: x.text.trim(), statusToken: x.status_token as TaggedPlan["statusToken"], basis: x.basis as string[] }];
  });
  const gaps = Array.isArray(e.coverage_gaps) ? e.coverage_gaps.length : 0;
  if (!patterns.length && !findings.length && !gaps && !errors.length) at("entry", "carries no pattern, no finding and no coverage gap: a cluster the reader cannot read is answered with the coverage gaps that name what is missing");
  if ((patterns.length || findings.length) && !(Array.isArray(e.signposts) && e.signposts.length)) at("signposts", "a pattern or a finding carries at least one signpost: the future evidence that confirms or falsifies it");
  list("connections").forEach((c, j) => { if (isObj(c)) { entityOk(c.from_entity_id, `connections[${j}].from_entity_id`); entityOk(c.to_entity_id, `connections[${j}].to_entity_id`); } });
  const items = [...(live.items.get(cluster.id) ?? [])];
  if (tagged.length && !items.length) at("tagged_inferences", "an inference record cites at least one intelligence item, and the rows this entry cites name none");
  const wb = verifyWriteback(e, tag, { captures: live.captures, ids: live.entities, now: live.now, locate: live.locate, itemIds: items });
  errors.push(...wb.errors.filter((m) => !errors.includes(m)));
  if (errors.length) return { errors };
  // a reading with no pattern, finding or inference (only coverage gaps) holds no analysis for the second reader to judge
  const rv = patterns.length || findings.length || tagged.length ? review("admin-opportunity-findings", e) : { required: [] as string[], score: 1, reasons: [] as string[], residue: false, reviewed_by: null };
  const why = [...(patterns.length || findings.length ? [singleSourceReason([...cited].map((k) => ({ table: (rows.get(k) as ClusterRow).table, surface: (rows.get(k) as ClusterRow).surface })))].flatMap((r) => r ?? []) : []), ...rv.reasons.map((r) => `second reader: ${r}`)];
  if (why.length) return { errors: [], residue: why.map((r) => `${tag}: ${r}`) };
  const stored = live.stored;
  const allPatternsStored = patterns.every((p) => stored.patterns.has(p.computedBy));
  const allFindingsStored = findings.every((f) => stored.findings.has(findingKey(f.patternValueId ?? stored.patterns.get(patterns.find((p) => p.ref === f.patternRef)?.computedBy ?? "") ?? "", f.title, f.md)));
  if (allPatternsStored && allFindingsStored && writebackHeld(wb.plan, live.held)) return { errors: [], done: true };
  const plan: SynthPlan = { cluster, patterns, findings, tagged, wb: wb.plan, items, cited: [...cited], score: rv.score, reasons: `${rv.required.length} required judges passed`, reviewer: rv.reviewed_by ?? "none", entry: e };
  return { errors: [], plan };
}
