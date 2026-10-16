// Ported from old_repo/src/lib/perf/server-timing-core.ts (lines 1-8)
// Ported from old_repo/src/lib/perf/server-timing-core.ts (lines 10-24)
// Ported from old_repo/src/lib/perf/server-timing-core.ts (lines 29-62)
// Ported from old_repo/src/lib/perf/server-timing-core.ts (lines 71-78)
// Ported from old_repo/src/lib/perf/server-timing-core.ts (lines 85-109)
// Ported from old_repo/src/lib/perf/server-timing-core.ts (lines 136-144)
// Ported from old_repo/src/lib/perf/server-timing.ts (lines 20-58)
// Ported from old_repo/src/lib/perf/server-timing.ts (lines 71-73)
import * as React from "react";

export const PERF_PHASES = { AUTH: "auth", ORG: "org", LISTING_RPC: "listing_rpc", COUNTS: "counts", DETAIL_CORE: "detail_core", SERIALIZE_BYTES: "serialize_bytes" } as const;
/** process.uptime() under this at request start means a cold start. */
export const COLD_START_UPTIME_SECONDS = 5;

export interface PerfPhaseRecord {
  readonly name: string;
  /** A timed phase carries durationMs; a sized phase carries bytes: never both, so the header renders them unambiguously (`dur=` vs `desc=`). */
  readonly durationMs?: number;
  readonly bytes?: number;
}
export interface PerfTimingStore {
  readonly requestStartedAt: number;
  readonly coldStart: boolean;
  readonly phases: PerfPhaseRecord[];
}
export const createTimingStore = (nowMs: number, processUptimeSeconds: number = Number.POSITIVE_INFINITY): PerfTimingStore => ({ requestStartedAt: nowMs, coldStart: processUptimeSeconds < COLD_START_UPTIME_SECONDS, phases: [] });
export const recordPhaseOnStore = (store: PerfTimingStore, name: string, durationMs: number): void => void store.phases.push({ name, durationMs: Math.max(0, Math.round(durationMs)) });
export const recordBytesOnStore = (store: PerfTimingStore, name: string, bytes: number): void => void store.phases.push({ name, bytes: Math.max(0, Math.round(bytes)) });

/** Time an async or sync phase and record it, returning the call's own result. The phase is recorded even when `fn` throws: a failed phase is evidence, not a hole in the trace. */
export async function timePhaseOnStore<T>(store: PerfTimingStore, name: string, fn: () => Promise<T> | T, now: () => number = Date.now): Promise<T> {
  const start = now();
  try {
    return await fn();
  } finally {
    recordPhaseOnStore(store, name, now() - start);
  }
}
/** The UTF-8 wire size of a JSON-serializable value (TextEncoder, so an edge caller works); an unserializable value yields 0 rather than crashing the render. */
export function measureJsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : new TextEncoder().encode(json).length;
  } catch {
    return 0;
  }
}
/** A Server-Timing metric name must be an HTTP token; anything else is renamed rather than producing a malformed header. */
export const sanitizeTimingName = (name: string): string => String(name).replace(/[^A-Za-z0-9_-]/g, "_") || "phase";

/** The Server-Timing header value: `name;dur=N` per timed phase, `name;desc="NB"` per sized phase, then a synthetic total and a cold or warm marker (never omitted). */
export function toServerTimingHeader(store: PerfTimingStore, now: number): string {
  const entries = store.phases.map((p) => (typeof p.bytes === "number" ? `${sanitizeTimingName(p.name)};desc="${p.bytes}B"` : `${sanitizeTimingName(p.name)};dur=${Math.max(0, Math.round(p.durationMs ?? 0))}`));
  entries.push(`total;dur=${Math.max(0, now - store.requestStartedAt)}`, `coldstart;desc="${store.coldStart ? "cold" : "warm"}"`);
  return entries.join(", ");
}
/** The same store as one `[perf]` log line: the channel for a full RSC page render, where no response header can be attached. */
export function toPerfLogLine(routeLabel: string, store: PerfTimingStore, now: number): string {
  const parts = store.phases.map((p) => (typeof p.bytes === "number" ? `${p.name}=${p.bytes}bytes` : `${p.name}=${Math.round(p.durationMs ?? 0)}ms`));
  return `[perf] ${routeLabel} ${parts.join(" ")} total=${Math.max(0, now - store.requestStartedAt)}ms coldstart=${store.coldStart ? 1 : 0}`;
}
/** A copy of `response` with the store's Server-Timing header appended (Web-standard Response only, so a route handler, the proxy or a test can use it). */
export function applyServerTimingHeader(response: Response, store: PerfTimingStore, now: number): Response {
  const headers = new Headers(response.headers);
  headers.append("Server-Timing", toServerTimingHeader(store, now));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// The ambient request-scoped store: React's per-request cache on the server; elsewhere (tests, scripts) a function that is its own store is not shared across requests.
const scoped: <T>(fn: () => T) => () => T = typeof (React as { cache?: unknown }).cache === "function" ? ((React as unknown as { cache: <T>(fn: () => T) => () => T }).cache) : <T,>(fn: () => T) => fn;
const uptime = (): number => {
  try {
    return typeof process !== "undefined" && typeof process.uptime === "function" ? process.uptime() : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};
const getStore = scoped((): PerfTimingStore => createTimingStore(Date.now(), uptime()));

export const timePhase = <T,>(name: string, fn: () => Promise<T> | T): Promise<T> => timePhaseOnStore(getStore(), name, fn);
/** Measure `value`'s JSON size and record it as a sized phase in one call: `recordSerializedBytes(propsPassedToClient)`. */
export function recordSerializedBytes(value: unknown, name: string = PERF_PHASES.SERIALIZE_BYTES): number {
  const bytes = measureJsonBytes(value);
  recordBytesOnStore(getStore(), name, bytes);
  return bytes;
}
/** Attach the current request's Server-Timing header to a route handler's Response. */
export const withServerTiming = (response: Response): Response => applyServerTimingHeader(response, getStore(), Date.now());
