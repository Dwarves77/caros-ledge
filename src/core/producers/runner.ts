// Ported from old_repo/scripts/producers/market/ecb-fx-producer.mjs (lines 196-391)
// Ported from old_repo/scripts/producers/market/eia-v2-petroleum-spot-producer.mjs (lines 143-326)
// Ported from old_repo/scripts/producers/market/eu-weekly-oil-bulletin.mjs (lines 22-132)
// Ported from old_repo/scripts/producers/regional/run-envelope-producer.mjs (lines 102-166)
// Ported from old_repo/scripts/producers/oem/eea-hdv-co2-producer.mjs (lines 49-57)
// ONE runner replacing the thirteen CLI skeletons: dry by default, kill switch read first, licence gate, credentials, truncation; every dependency injected.
import type { Db } from "@/core/db";
import { licenceGate } from "@/core/contracts";
import { runResult, type RunResult } from "@/core/intake/result";

import type { FetchFn, ProducerDeps } from "./deps";
import { writeProducerSummary } from "./summary";
import { planKeyedUpsert, type Rec, type UpsertPlan } from "./upsert-plan";

export class NetworkError extends Error {}
/** A document that is not the one the producer reads (a changed layout, a wrong file): the run fails with the reason, nothing is written. */
export class StructureError extends Error {}

export interface GetOptions {
  headers?: Record<string, string>;
  /** Inclusive byte range, sent as `Range: bytes=a-b`. A 200 answer (range ignored) is accepted; the caller limits the bytes it reads. */
  range?: [number, number];
  method?: string;
  body?: string;
}
export type Getter = (url: string, opts?: GetOptions) => Promise<Response>;

/** The runner's retry configuration: the waits before each retry, in order, so a source that is briefly down (a 503) is given about a minute before the run fails. Its length is the number of retries. */
const FETCH_RETRY_BACKOFF_MS: readonly number[] = Object.freeze([5_000, 15_000, 45_000]);

/** The one fetch policy: a timeout per attempt, and a retry (after each wait of FETCH_RETRY_BACKOFF_MS) on a network error, a 429 or a 5xx. Any other non-2xx throws NetworkError. */
function makeGetter(fetchFn: FetchFn, o: { timeoutMs?: number; backoffMs?: readonly number[]; sleep?: ((ms: number) => Promise<void>) | undefined } = {}): Getter {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = o.backoffMs ?? FETCH_RETRY_BACKOFF_MS;
  return async (url, opts = {}) => {
    const headers = { ...(opts.headers ?? {}), ...(opts.range ? { Range: `bytes=${opts.range[0]}-${opts.range[1]}` } : {}) };
    let last = "";
    for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
      if (attempt > 0) await sleep(backoff[attempt - 1] as number);
      try {
        const res = await fetchFn(url, { method: opts.method, headers, body: opts.body, signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
        if (res.ok) return res;
        last = `HTTP ${res.status} ${res.statusText ?? ""}`.trim();
        if (res.status !== 429 && res.status < 500) break;
      } catch (e) {
        last = `fetch threw (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    throw new NetworkError(`${last} for ${url.replace(/([?&](?:api_key|apikey|key|token)=)[^&]*/gi, "$1REDACTED")}`);
  };
}

export interface GateInput {
  apply: boolean;
  licenceBlock?: string | null;
  enabled: boolean;
  killSwitchOn: boolean;
  hasCreds: boolean;
  truncated?: boolean;
}
/** The gate order is fixed: licence, the reviewed ENABLED constant, the kill switch, credentials, a partial read. A dry run never writes and never needs any of them. */
function decideApply(g: GateInput): { canWrite: boolean; reason: string } {
  if (!g.apply) return { canWrite: false, reason: "dry run: parse only, nothing written, no existing row read" };
  if (g.licenceBlock) return { canWrite: false, reason: `REFUSING: licence block: ${g.licenceBlock}` };
  if (!g.enabled) return { canWrite: false, reason: "REFUSING: the source-level ENABLED constant is false; arming a producer is a reviewed code change, never a runtime flag" };
  if (!g.killSwitchOn) return { canWrite: false, reason: "REFUSING: the kill switch is OFF (set it to \"1\" to arm this producer)" };
  if (!g.hasCreds) return { canWrite: false, reason: "REFUSING: apply requires database credentials and any declared key; none found" };
  if (g.truncated) return { canWrite: false, reason: "REFUSING: the read was byte-limited, so the counts are partial; apply needs the complete document" };
  return { canWrite: true, reason: "all gates satisfied" };
}

export interface RunInput {
  /** Default true. A run writes only when this is exactly false AND every gate passes. */
  dry?: boolean;
  /** An injected document (a file or a recorded response): fetch is skipped. */
  text?: string;
  bytes?: Buffer;
  since?: string | null;
  trace?: boolean;
  limit?: number;
  /** The entity a registry entry stamps on the rows it describes (never ambient). */
  entityId?: string | null;
  rowsFile?: unknown;
  csv?: string;
  orgId?: string;
}
export interface ProducerCtx {
  deps: ProducerDeps;
  input: RunInput;
  get: Getter;
  now: () => Date;
  sb: Db | null;
  apply: boolean;
  entityId: string | null;
  /** A scratch bag a spec uses to hand parse-time facts (hosts, titles) to its apply-time `resolve`. */
  state: Record<string, unknown>;
}
export interface Doc {
  text?: string;
  /** A binary document (a workbook). */
  bytes?: Buffer;
  truncated?: boolean;
  meta?: Rec;
}
export interface ParseOut<R extends Rec> {
  rows: R[];
  warnings: string[];
  truncated?: boolean;
  counts?: Record<string, number>;
}
export interface PlanSpec<R extends Rec> {
  /** Existing rows by the key's namespace (a bounded read that throws on error); called only on an apply that passed every gate. */
  read(sb: Db, rows: R[]): Promise<Rec[]>;
  key(row: Rec): string | null;
  patchable: readonly string[];
  pk: string;
}
export interface ProducerSpec<R extends Rec = Rec> {
  name: string;
  table: string;
  licenceKey: string | null;
  licenceBlock?: string | null;
  /** The reviewed constant (ADR-023): flipping it is a code change. `enabledRuling` cites why it is false. */
  enabled: boolean;
  enabledRuling?: string;
  killSwitchEnv: string | null;
  /** The honest answer to "no input given" for a producer fed only by a reviewed file: a recorded gap, never an invented row. */
  gap?: string;
  /** The one documented free-key exception: the env NAME of a key a source requires. */
  keyEnv?: string;
  fetchDoc(ctx: ProducerCtx): Promise<Doc>;
  parse(doc: Doc, ctx: ProducerCtx): ParseOut<R> | Promise<ParseOut<R>>;
  plan?: PlanSpec<R>;
  /** Apply only: resolve ids the rows need (region, source). A refused row is named and never written. */
  resolve?(ctx: ProducerCtx, rows: R[]): Promise<{ rows: R[]; refused: string[] }>;
  /** Replaces the generic keyed insert/patch (a producer that writes more than one table). */
  persist?(ctx: ProducerCtx, rows: R[]): Promise<Record<string, number>>;
  /** Rule 17: the downstream of a write, in the same run. Throwing fails the run closed. */
  after?(ctx: ProducerCtx, written: { rows: R[]; created: R[]; updated: Rec[] }): Promise<Record<string, number>>;
}

/** The licence block of a spec: an explicit one, else the register's refusal for any source whose verdict is not `permitted` (conditional, unverified, prohibited or unregistered: INV-ARM-1). A file-fed spec names no key. */
function licenceBlockOf(spec: Pick<ProducerSpec, "licenceKey" | "licenceBlock">): string | null {
  if (spec.licenceBlock) return spec.licenceBlock;
  const g = spec.licenceKey ? licenceGate(spec.licenceKey) : null;
  return g && !g.ok ? g.reason : null;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const failed = (name: string, reason: string, counts: Record<string, number> = {}): RunResult => runResult("failed", counts, [`${name}: ${reason}`]);
const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * Run one producer spec. Dry by default. The kill switch and every other gate are decided BEFORE the first fetch of an apply, so a refused apply costs nothing;
 * a dry run performs zero writes and zero existing-row reads. Never exits the process; returns its counts for the recorder.
 */
export async function runProducer<R extends Rec>(deps: ProducerDeps, input: RunInput & { spec: ProducerSpec<R> }): Promise<RunResult> {
  const { spec } = input;
  const apply = input.dry === false;
  const killSwitchOn = spec.killSwitchEnv ? deps.env[spec.killSwitchEnv] === "1" : true;
  const hasCreds = deps.sb !== null && (!spec.keyEnv || Boolean(deps.env[spec.keyEnv]));
  const gate = (truncated: boolean) => decideApply({ apply, licenceBlock: licenceBlockOf(spec), enabled: spec.enabled, killSwitchOn, hasCreds, truncated });
  const pre = gate(false);
  if (apply && !pre.canWrite) return failed(spec.name, pre.reason, { refused: 1 });

  const ctx: ProducerCtx = { deps, input, get: makeGetter(deps.fetch, { sleep: deps.sleep }), now: () => deps.recorder.now(), sb: deps.sb, apply, entityId: input.entityId ?? null, state: {} };
  const notes: string[] = [];
  let rows: R[];
  let truncated = false;
  let parseCounts: Record<string, number> = {};
  try {
    const doc: Doc = input.text !== undefined ? { text: input.text } : input.bytes ? { bytes: input.bytes } : await spec.fetchDoc(ctx);
    if (doc.text !== undefined && !doc.text.trim()) return spec.gap ? runResult("ok", { parsed: 0, gap: 1 }, [`${spec.name}: gap: ${spec.gap}`]) : failed(spec.name, "no input: the document came back empty");
    const out = await spec.parse(doc, ctx);
    rows = out.rows;
    truncated = Boolean(out.truncated ?? doc.truncated);
    parseCounts = out.counts ?? {};
    notes.push(...out.warnings.map((w) => `[parse] ${w}`));
  } catch (e) {
    if (e instanceof NetworkError || e instanceof StructureError) return failed(spec.name, `${e instanceof NetworkError ? "network" : "structure"}: ${e.message}`);
    return failed(spec.name, `read failed: ${errMsg(e)}`);
  }
  const counts: Record<string, number> = { parsed: rows.length, warnings: notes.length, ...parseCounts };
  if (rows.length === 0) return runResult("ok", counts, [...notes, `${spec.name}: nothing to plan`]);
  if (!apply) return runResult("ok", counts, [...notes, `${spec.name}: dry run, ${rows.length} row(s) parsed; existing rows are not read, so the create/patch split is not computed`]);

  const final = gate(truncated);
  if (!final.canWrite) return failed(spec.name, final.reason, { ...counts, refused: 1 });
  const sb = deps.sb as Db;
  let result: RunResult;
  try {
    let toWrite = rows;
    if (spec.resolve) {
      const r = await spec.resolve(ctx, rows);
      toWrite = r.rows;
      counts.refused_rows = r.refused.length;
      notes.push(...r.refused.map((x) => `[refused] ${x}`));
    }
    let created: R[] = [];
    let updated: Rec[] = [];
    if (spec.persist) Object.assign(counts, await spec.persist(ctx, toWrite));
    else if (spec.plan) {
      const plan: UpsertPlan<R, Rec> = planKeyedUpsert(await spec.plan.read(sb, toWrite), toWrite, spec.plan);
      for (const part of chunk(plan.toCreate, 100)) {
        const { error } = await sb.from(spec.table).insert(part as never);
        if (error) throw new Error(`insert into ${spec.table} failed: ${error.message}`);
      }
      for (const u of plan.toUpdate) {
        const { error } = await sb.from(spec.table).update(u.patch as never).eq(spec.plan.pk, u.pk);
        if (error) throw new Error(`update of ${spec.table} ${String(u.pk)} failed: ${error.message}`);
      }
      created = plan.toCreate;
      updated = plan.toUpdate.map((u) => u.existing);
      Object.assign(counts, { created: created.length, updated: updated.length, unchanged: plan.unchanged, skipped: plan.skipped.length });
    }
    if (spec.after) Object.assign(counts, await spec.after(ctx, { rows: toWrite, created, updated }));
    result = runResult(counts.refused_rows ? "partial" : "ok", counts, notes);
  } catch (e) {
    result = failed(spec.name, errMsg(e), counts);
  }
  const rec = await deps.recorder.recordRun({ family: "producers", outcome: result.outcome, counts: result.counts, notes: [`producer=${spec.name}`, ...result.notes] });
  if (rec.error) result.notes.push(`recordRun failed: ${rec.error}`);
  const rowsChanged = (result.counts.created ?? 0) + (result.counts.updated ?? 0);
  writeProducerSummary({ producer: spec.name, status: result.outcome === "failed" ? "failed" : "ok", rows_changed: rowsChanged, edges_authored: result.counts.edges_authored ?? null, reason: result.outcome === "failed" ? result.notes.join(" | ") : null, counts: result.counts }, { dir: deps.summaryDir, now: deps.recorder.now() });
  return result;
}
