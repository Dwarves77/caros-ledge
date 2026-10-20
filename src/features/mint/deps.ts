// The interfaces this slice consumes from slices that are not merged yet. P2-08 (turn) wires the real implementations; nothing here imports another slice's
// runtime except the merged core and P2-04's intake exports.
import type { Db } from "@/core/db";
import type { capture } from "@/core/fetch";
import type { IdentityHelpers } from "@/core/intake";
import type { ConnectDeps, RecorderDeps } from "@/features/intake";

export type { ConnectDeps, RecorderDeps };
/** The fetch dependencies capture() takes (hold gate, fetch implementation, throttle); P2-03 does not export the type by name. */
export type CaptureDeps = Parameters<typeof capture>[2];

/** The deduplicated-subject row the dedup gate matches against (the full non-archived corpus). */
export interface CorpusRow {
  id: string;
  title: string | null;
  instrument_identifier: string | null;
  source_url: string | null;
}

/**
 * P2-06 (connect) satisfies this with its `@/core/entities` exports of the same names. Congruence 1a retypes a primary-artifact type seen on a news
 * source to market_signal; 1b keeps research_finding and seeks the study. matchExistingSubject is the high-precision subject dedup.
 */
export interface EntityDeps {
  congruence(itemType: string | undefined, url: string): { itemType?: string; changed: boolean; incongruentSource: boolean; reason?: string };
  sourceRole(url: string): "primary" | "news" | "other";
  matchExistingSubject(seed: Record<string, unknown>, corpus: CorpusRow[]): { id: string; how: string }[];
}

/** Everything the mint family needs from outside itself. */
export interface MintRunDeps {
  sb: Db;
  now(): Date;
  /** P2-06: the entity helpers the single-item gates call. */
  entities: EntityDeps;
  /** P2-06: the flywheel steps; `connect.connect(itemId)` runs exactly once per mint, through P2-04's participation list. */
  connect: ConnectDeps;
  /** P2-08: the ledger recorder; one `mint` row per minted item. */
  recorder: RecorderDeps;
  /** P2-07/harness: canonical-key derivation and institution equality for document identity. */
  identity: IdentityHelpers;
  /** P2-03 transports: the fetch dependencies capture() takes (hold gate, fetch implementation, throttle). */
  fetch: CaptureDeps;
  /** P2-15 (market producers): true when the identifier is an implemented market-series key (the record_hollow exemption). */
  isSeriesKey(identifier: string | null | undefined): boolean;
}
