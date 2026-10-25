// Ported from old_repo/scripts/drain/kinds.mjs (lines 1-221)
// Ported from old_repo/scripts/research/backfill-themes.mjs (lines 28-40)
// The judgement drain's kinds: the seven digest kinds of the one registry (src/core/digest/kinds.ts, DIGEST-1) plus `theme-classification` (the residue of the free theme rules) and `screen-verdict` (the ambiguous
// relevance holds P2-05 banks). Each kind names an exporter FUNCTION (plan.ts calls it in-process) and the apply STEP P2-08's dispatcher runs on merge (the old
// workflow filenames are gone). The two exporters this slice owns are here; the other six are supplied through deps by the slices that own their queues.
import { z } from "zod";

import { fetchAllRows, type Db } from "@/core/db";
import { DIGEST_KINDS, type DigestKind } from "@/core/digest/kinds";
import { runResult, type RunResult } from "@/core/intake/result";
import { dispatchNotification } from "@/core/notifications";

import raw from "./data/kinds.json";

const kind = z.object({ id: z.string(), label: z.string(), batchDir: z.string(), batchRe: z.string(), batchPrefix: z.string(), applyStep: z.string(), namesFile: z.boolean(), batchSize: z.number().int().positive(), maxBatchesPerRun: z.number().int().positive(), idKey: z.string(), leaseKey: z.string().nullable() }).strict();
const file = z.object({ kinds: z.array(kind) }).superRefine((f, ctx) => {
  for (const k of f.kinds) if (!k.batchDir || /\.\./.test(k.batchDir)) ctx.addIssue({ code: "custom", message: `kind ${k.id}: batchDir must be a clean relative path` });
});
const parsed = file.parse(raw);
type Own = Omit<z.infer<typeof kind>, "batchRe"> & { batchRe: RegExp };
/** A drain kind: the seven digest kinds come from the one registry (core/digest); the three below it (theme classification, screen verdicts, the notification outbox) are the drain's own and carry no authoring guide. */
export type DrainKind = Own & { modes?: Record<string, { label: string }> | undefined; authoringGuide: DigestKind["authoringGuide"] | null; applyPending: string | null };
const own: DrainKind[] = parsed.kinds.map((k) => ({ ...k, batchRe: new RegExp(k.batchRe), authoringGuide: null, applyPending: null }));
const digest: DrainKind[] = DIGEST_KINDS.map((k) => ({ id: k.id, label: k.label, batchDir: k.batchDir, batchRe: k.batchRe, batchPrefix: k.batchPrefix, applyStep: k.applyStep, namesFile: k.namesFile, batchSize: k.batchSize, maxBatchesPerRun: k.maxBatchesPerRun, idKey: k.idKey, leaseKey: k.leaseKey, modes: k.modes, authoringGuide: k.authoringGuide, applyPending: k.applyPending }));
export const DRAIN_KINDS: readonly DrainKind[] = Object.freeze([...digest, ...own].map((k) => Object.freeze(k)));
export const KIND_ORDER: readonly string[] = Object.freeze(DRAIN_KINDS.map((k) => k.id));
export const DEFAULT_MODE = "pending";

const kindById = (id: string): DrainKind | null => DRAIN_KINDS.find((k) => k.id === id) ?? null;
export const kindModes = (k: DrainKind): string[] => [DEFAULT_MODE, ...Object.keys(k.modes ?? {})];
/** An exact id, or a prefix naming exactly one kind. */
export function resolveKind(input: unknown): DrainKind | null {
  const v = String(input ?? "");
  if (!v) return null;
  const exact = kindById(v);
  if (exact) return exact;
  const hits = DRAIN_KINDS.filter((k) => k.id.startsWith(v));
  return hits.length === 1 ? (hits[0] as DrainKind) : null;
}
/** The next batch path: numbered after the highest committed batch of the kind (plus `offset` for several in one plan). */
export function nextBatchPath(k: DrainKind, existingNames: readonly string[], offset = 0): string {
  let max = 0;
  for (const n of existingNames) {
    if (!k.batchRe.test(n)) continue;
    const m = /-(\d{3})/.exec(n.slice(k.batchPrefix.length));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${k.batchDir}/${k.batchPrefix}-${String(max + 1 + offset).padStart(3, "0")}.json`;
}

export type Item = Record<string, unknown>;
export interface ExportResult { ok: boolean; items: Item[]; error?: string; source?: unknown; current_prompt_version?: string | null }
export type Exporter = (opts: { limit: number; mode: string }) => Promise<ExportResult>;

/** The ambiguous holds P2-05 banked for a reviewed verdict: census rows held with `screen:ambiguous:` whose hold notes carry export_kind "screen-verdict". Oldest first. */
export function screenVerdictExporter(sb: Db): Exporter {
  return async ({ limit }) => {
    try {
      const rows = await fetchAllRows<{ id: string; title: string | null; document_url: string; hold_reason: string | null; notes: string | null }>((a, b) => sb.from("census_worklist").select("id, title, document_url, hold_reason, notes").eq("dryrun_disposition", "hold").like("hold_reason", "screen:ambiguous:%").order("id", { ascending: true }).range(a, b) as never, { cap: 200_000 });
      const items = rows.filter((r) => { try { return (JSON.parse(r.notes ?? "null") as { export_kind?: string } | null)?.export_kind === "screen-verdict"; } catch { return false; } }).slice(0, limit).map((r) => ({ census_id: r.id, title: r.title, document_url: r.document_url, hold_reason: r.hold_reason }));
      return { ok: true, items, source: { type: "table", table: "census_worklist" } };
    } catch (e) {
      return { ok: false, items: [], error: (e as Error).message };
    }
  };
}

const OUTBOX_MAX_ATTEMPTS = 5;
type OutboxRow = { id: string; user_id: string; kind: Parameters<typeof dispatchNotification>[0]["kind"]; payload: Record<string, unknown>; attempts: number | null };
const PENDING = (sb: Db, limit: number, ids?: readonly string[]) => {
  const q = sb.from("notification_outbox").select("id, user_id, kind, payload, attempts").eq("status", "pending");
  return (ids ? q.in("id", [...ids]) : q).order("created_at", { ascending: true }).limit(limit);
};

/**
 * Send each pending notification through dispatchNotification and stamp the row: sent (with sent_at), or attempts + 1 with last_error; the fifth failed attempt
 * gives up (status failed) so a poisoned row stops being retried. `ids` restricts the pass to those pending rows (the live check drains the row it planted and no one else's). Dry counts what it would send and touches nothing. A failed read fails the run.
 */
export async function runNotificationOutbox(deps: { sb: Db; now(): Date; dispatch?: typeof dispatchNotification }, input: { dry?: boolean; limit?: number; ids?: readonly string[] } = {}): Promise<RunResult> {
  const send = deps.dispatch ?? dispatchNotification;
  const { data, error } = await PENDING(deps.sb, input.limit ?? 200, input.ids);
  if (error) return runResult("failed", {}, ["reading notification_outbox failed: " + error.message]);
  const rows = (data ?? []) as OutboxRow[];
  const c = { pending: rows.length, sent: 0, retried: 0, gave_up: 0, stamp_errors: 0 };
  const notes: string[] = [];
  if (input.dry !== false) return runResult("ok", c, ["dry run: nothing sent or stamped"]);
  for (const r of rows) {
    const err = await send({ userId: r.user_id, kind: r.kind, payload: r.payload }, deps.sb);
    const attempts = (r.attempts ?? 0) + 1;
    const patch = err === null ? { status: "sent", sent_at: deps.now().toISOString(), attempts } : { status: attempts >= OUTBOX_MAX_ATTEMPTS ? "failed" : "pending", attempts, last_error: err };
    const up = await deps.sb.from("notification_outbox").update(patch).eq("id", r.id);
    if (up.error) { c.stamp_errors += 1; notes.push("stamping " + r.id + " failed: " + up.error.message); }
    else if (err === null) c.sent += 1;
    else if (patch.status === "failed") { c.gave_up += 1; notes.push(r.id + " gave up after " + attempts + " attempts: " + err); }
    else c.retried += 1;
  }
  return runResult(c.stamp_errors ? "partial" : "ok", c, notes);
}
