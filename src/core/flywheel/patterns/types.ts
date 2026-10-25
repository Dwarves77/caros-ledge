// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the shapes the pattern detectors read and return. A fact is one stored row seen by a detector (its table and key, the entities it is filed under, the modes those entities couple, its dates and its one quantity); a pattern is
// what a detector finds in facts: an anchor entity, a strength, and the evidence rows by edge kind (member, evidence, key), which become the derivation edges of the derived value that records it.
import type { Relation } from "@/core/coupling";

export const KINDS = ["velocity", "mandateCapacity", "leadLag", "crossModal", "penaltyAbatement"] as const;
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
  source: string | null;
  tier: number | null;
  qty: number | null;
  unit: string | null;
  /** The row held a quantity whose unit the unit map does not state: the quantity is left out, never guessed. */
  unitUnknown?: true;
  trl: number | null;
  /** A claim's kind, a forward event's kind. */
  kind: string | null;
  /** The series a point belongs to. */
  group: string | null;
}
export type EdgeKind = "member" | "evidence" | "key";
export interface Evidence {
  table: string;
  pk: string;
  kind: EdgeKind;
  entities: string[];
  /** The relation a cross-modal pattern crossed. */
  relation?: Relation;
  /** On a capped pattern's one summary edge: how many rows the pattern stands on and the window they were read over. */
  summary?: Record<string, number>;
}
export interface Pattern {
  kind: PatternKind;
  /** Identifies the pattern across turns: the same finding gets the same key. */
  key: string;
  entity: string;
  value: number;
  unit: string;
  evidence: Evidence[];
}
export interface PatternInput {
  now: Date;
  facts: readonly Fact[];
  /** The entities one relation away from an entity, with the relation. */
  related(entity: string): { entity: string; relation: Relation }[];
  /** The claims the corpus holds per day (YYYY-MM-DD to count, the kinds that are not absences): a burst is a rise in an entity's share of this flow, so a corpus that is itself growing is no burst, and a window with no flow has no baseline. Null: the stored pattern is being revalidated and its value is `carry`. */
  flow: ReadonlyMap<string, number> | null;
  carry?: number;
}
