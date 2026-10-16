// The interfaces the producer runner consumes. P2-08 (turn) wires the recorder and the fetch; the database client is the service client.
import type { Db } from "@/core/db";

export type FetchFn = (url: string, init?: { method?: string | undefined; headers?: Record<string, string> | undefined; body?: string | undefined; signal?: AbortSignal | undefined }) => Promise<Response>;

/** Structurally the recordRun and now of the intake RecorderDeps (P2-08 supplies it); core does not import a feature. */
export interface Recorder {
  recordRun(entry: { family: string; itemId?: string | null; outcome: "ok" | "partial" | "failed"; counts: Record<string, number>; notes: string[] }): Promise<{ error: string | null }>;
  now(): Date;
}

export interface ProducerDeps {
  /** The service client; null when no credentials exist (a dry run needs none). */
  sb: Db | null;
  /** The injected fetch (timeouts, retries and Range live in `makeGetter`, never in a producer). */
  fetch: FetchFn;
  recorder: Recorder;
  /** Environment reads (kill switches, the one free key). Defaults to process.env at the call site that builds the deps. */
  env: Record<string, string | undefined>;
  /** Back-off sleep; defaults to a real timer. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Where producer summaries are written (PRODUCER_SUMMARY_DIR); null or absent writes none. */
  summaryDir?: string | null | undefined;
}
