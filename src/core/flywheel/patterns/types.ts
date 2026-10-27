// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the shapes the pattern detectors read and return. A fact is one stored row seen by a detector (its table and key, the entities it is filed under, the modes those entities couple, its dates and its one quantity); a pattern is
// what a detector finds in facts: an anchor entity, a strength, and the evidence rows by edge kind (member, evidence, key), which become the derivation edges of the derived value that records it.
import type { Relation } from "@/core/coupling";

export const KINDS = ["velocity", "mandateCapacity", "leadLag", "crossModal", "penaltyAbatement", "regulatoryStacking"] as const;
export type PatternKind = (typeof KINDS)[number];
export type FactRole = "claim" | "ratchet" | "capacity" | "series" | "trigger" | "tech" | "move" | "ceiling" | "abatement";
export interface Fact {
  table: string;
  pk: string;
  role: FactRole;
  entities: string[];
  /** The transport modes the facts' entities couple (canonical names). */
  modes: string[];
  surface: string;
  /** The day the row was observed or written (YYYY-MM-DD), and the day it falls due or lands. */
  at: string | null;
  due: string | null;
  /** How precise `due` is when it is less than a day (G3): a year-precision mandate is stored as 1 January and is never read or shown as that day. Absent: a day. */
  duePrecision?: "month" | "year";
  /** The column that supplied `due` when the spec names several (due_date, else first_deadline, else date_of_application): a pattern resting on a fallback date is traceable. */
  dueSource?: string;
  /** The class and mode tokens of each entity the row is filed under, as the ontology (the database) held them when the fact was read: what a recompute needs without a read. */
  onto?: Record<string, { class: string; modes: string[] }>;
  /** A claim's clock for the velocity detector: the document date of the capture it was read from (never the day the item was added). Undated: null, and the claim counts in no burst. */
  docAt?: string | null;
  /** The intelligence item the row belongs to (the column facts.json names as its owner), for the packet's provenance and the signpost's citations. */
  item?: string | null;
  /** A pending trigger a later capture has resolved. */
  resolved?: true;
  source: string | null;
  tier: number | null;
  /** A derived value the evidence rests on that is display-grade (admissibility display_only): the pattern is graded down with it. */
  displayOnly?: true;
  qty: number | null;
  unit: string | null;
  /** The row held a quantity whose unit the unit map does not state: the quantity is left out, never guessed. */
  unitUnknown?: true;
  trl: number | null;
  /** A claim's kind, a forward event's kind. */
  kind: string | null;
  /** The series a point belongs to. */
  group: string | null;
  /** The capture the row quotes (a claim's search result, an obligation's capture, a forward event's source capture), for the cluster row that must point at its quote. */
  capture?: string | null;
}
export type EdgeKind = "member" | "evidence" | "key";
export interface Evidence {
  table: string;
  pk: string;
  kind: EdgeKind;
  entities: string[];
  /** The relation a cross-modal pattern crossed. */
  relation?: Relation;
  /** The role the row was read as (an obligation is a ratchet or a ceiling), what the fact carried for traceability and what a recompute needs. */
  role?: FactRole;
  dueSource?: string;
  trl?: number;
  onto?: Fact["onto"];
  /** What the detector states about how the pattern was found (the condition that fired, the side that is partial, a unit or maturity gap, the window): on the pattern's first edge. */
  marker?: Record<string, string | number | boolean>;
  /** On a capped pattern's one summary edge: how many rows the pattern stands on and the window they were read over. */
  summary?: Record<string, number>;
}
/** A relation the reader asserted (an entity_relations row with a method_version): the join the P1 packet and the discovery hook need. */
export interface ReaderEdge {
  parent: string;
  child: string;
  relation: Relation;
}
export interface Pattern {
  kind: PatternKind;
  /** Identifies the pattern across turns: the same finding gets the same key. */
  key: string;
  entity: string;
  value: number;
  unit: string;
  evidence: Evidence[];
  /** The date the pattern's dated key row falls due (the ratchet of a mandate-capacity pattern, the trigger of a lead-lag one): the day its forward claim is tested. */
  keyDue?: string;
}
/** The identity of a pattern across turns, versions and re-found evidence: its kind and its key. */
export const patternSeed = (p: Pick<Pattern, "kind" | "key">): string => `${p.kind}:${p.key}`;
export interface PatternInput {
  now: Date;
  facts: readonly Fact[];
  /** The entities one relation away from an entity, with the relation. */
  related(entity: string): { entity: string; relation: Relation }[];
  /** The relations a reader asserted (basis and method_version stored), both ends. */
  readerEdges?: readonly ReaderEdge[];
  /** The claims the corpus holds per day (YYYY-MM-DD to count, the kinds that are not absences): a burst is a rise in an entity's share of this flow, so a corpus that is itself growing is no burst, and a window with no flow has no baseline. Null: the stored pattern is being revalidated and its value is `carry`. */
  flow: ReadonlyMap<string, number> | null;
  carry?: number;
  /** The class of an entity ("mode", "hub", "carrier", "jurisdiction", ...) and the transport modes it is or couples, as the database ontology holds them (none: unknown). */
  classOf?(entity: string): string;
  modesOf?(entity: string): string[];
}
