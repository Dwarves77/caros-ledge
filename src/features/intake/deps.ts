// The interfaces this slice consumes from slices that are not merged yet. P2-08 (turn) wires the real implementations; until then a
// runtime that needs one gets it through the `deps` object and nothing in this slice imports another slice.
import type { Db } from "@/core/db";
import type { GroundSources } from "@/core/grounding";

export interface CaptureResult {
  ok: boolean;
  text: string;
  /** Set when the body is a bot wall or interface shell rather than the document (the row then stays a candidate). */
  wall?: { kind: string } | null;
  reason?: string;
}

/** P2-03 (sources) satisfies this. GroundSources is the part grounding calls; the rest is what the portal ledger and quarantine tools call. */
export interface SourcesDeps extends GroundSources {
  classTierForHost(host: string): number | null;
  holdingsGate(capture: { snapshotBytes: number; usablePoolRows: number }): { present: boolean; detail: string };
  fetchAllowed(url: string, caller: string | null): boolean;
  capture(url: string, ref: { family: string; key: string }): Promise<CaptureResult>;
}

export type MintOutcome = "minted" | "retyped" | "linked" | "exists" | "duplicate" | "unsourced" | "rejected";
export interface MintInput {
  seed: Record<string, unknown>;
  legacyId?: string | null;
  relevance?: number | null;
  origin: string;
  grade?: "brief" | "record";
}
export interface MintResult {
  itemId: string | null;
  outcome: MintOutcome;
  /** The gate decisions taken (congruence:1a, dedup:linked, low-relevance, ...) and, on a refusal, the machine reason. */
  reasons: string[];
}
/** P2-05 (mint) satisfies this: the ONE mint function. Nothing in this slice inserts into intelligence_items. */
export interface MintDeps {
  mintItem(input: MintInput, opts: { dry: boolean }): Promise<MintResult>;
}
export const MINT_OK: readonly MintOutcome[] = ["minted", "retyped", "linked", "exists"];

export interface ForwardEventsResult {
  attempted: number;
  inserted: number;
  collision: boolean;
  /** Existing events whose supporting claim or section no longer exists: reported, never deleted. */
  staleIds: string[];
  complianceDeadline?: { changed: boolean; value: string | null };
}
/** P2-06 (connect) satisfies this: the flywheel steps that follow every mint and substantive update. */
export interface ConnectDeps {
  connect(itemId: string): Promise<{ written: number }>;
  extractAndInsertForwardEvents(itemId: string): Promise<ForwardEventsResult>;
  deriveObligations(itemId: string): Promise<{ derived: number }>;
  linkEntities(itemId: string): Promise<{ refs: number; instrumentEntityId?: string | null }>;
}

export interface RunRecord {
  family: string;
  itemId?: string | null;
  outcome: "ok" | "partial" | "failed";
  counts: Record<string, number>;
  notes: string[];
}
/** P2-08 (turn) satisfies this: the recorder writes the run's ledger row from the entry's returned counts. */
export interface RecorderDeps {
  recordRun(entry: RunRecord): Promise<{ error: string | null }>;
  now(): Date;
}

export interface IntakeDeps {
  sb: Db;
  sources: SourcesDeps;
  mint: MintDeps;
  connect: ConnectDeps;
  recorder: RecorderDeps;
}
