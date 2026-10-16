// Ported from old_repo/scripts/drain/kinds.mjs (lines 1-221)
// Ported from old_repo/scripts/research/backfill-themes.mjs (lines 28-40)
// The judgement drain's kinds: the six queues of ADR-044 decision 1 plus `theme-classification` (the residue of the free theme rules) and `screen-verdict` (the ambiguous
// relevance holds P2-05 banks). Each kind names an exporter FUNCTION (plan.ts calls it in-process) and the apply STEP P2-08's dispatcher runs on merge (the old
// workflow filenames are gone). The two exporters this slice owns are here; the other six are supplied through deps by the slices that own their queues.
import { z } from "zod";

import { fetchAllRows, type Db } from "@/core/db";

import raw from "./data/kinds.json";

const modeSchema = z.object({ label: z.string() });
const kind = z.object({ id: z.string(), label: z.string(), batchDir: z.string(), batchRe: z.string(), batchPrefix: z.string(), applyStep: z.string(), namesFile: z.boolean(), batchSize: z.number().int().positive(), maxBatchesPerRun: z.number().int().positive(), idKey: z.string(), leaseKey: z.string().nullable(), modes: z.record(z.string(), modeSchema).optional() }).strict();
const file = z.object({ order: z.array(z.string()), kinds: z.array(kind) }).superRefine((f, ctx) => {
  if (f.kinds.map((k) => k.id).join() !== f.order.join()) ctx.addIssue({ code: "custom", message: "order must list every kind once, in kind order" });
  for (const k of f.kinds) if (!k.batchDir || /\.\./.test(k.batchDir)) ctx.addIssue({ code: "custom", message: `kind ${k.id}: batchDir must be a clean relative path` });
});
const parsed = file.parse(raw);
export type DrainKind = Omit<z.infer<typeof kind>, "batchRe"> & { batchRe: RegExp };
export const DRAIN_KINDS: readonly DrainKind[] = Object.freeze(parsed.kinds.map((k) => Object.freeze({ ...k, batchRe: new RegExp(k.batchRe) })));
export const KIND_ORDER: readonly string[] = Object.freeze(parsed.order);
export const DEFAULT_MODE = "pending";

export const kindById = (id: string): DrainKind | null => DRAIN_KINDS.find((k) => k.id === id) ?? null;
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
/** The kind a committed batch path belongs to (the file must sit directly in the kind's directory and match its pattern). */
export function kindForBatchPath(path: string): DrainKind | null {
  const p = String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  for (const k of DRAIN_KINDS) {
    if (!p.startsWith(`${k.batchDir}/`)) continue;
    const name = p.slice(k.batchDir.length + 1);
    if (!name.includes("/") && k.batchRe.test(name)) return k;
  }
  return null;
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
/** Research findings with no theme that the rules left unclassified: the residue a session authors. Rule-classifiable rows are never exported. */
export function themeClassificationExporter(sb: Db, classify: (text: string) => { theme: string }): Exporter {
  return async ({ limit }) => {
    try {
      const rows = await fetchAllRows<{ id: string; title: string | null; what_is_it: string | null; full_brief: string | null }>((a, b) => sb.from("intelligence_items").select("id, title, what_is_it, full_brief").eq("item_type", "research_finding").is("theme", null).eq("is_archived", false).order("id", { ascending: true }).range(a, b) as never, { cap: 100_000 });
      const items = rows.filter((r) => classify(`${r.title ?? ""} ${r.what_is_it ?? ""} ${r.full_brief ?? ""}`).theme === "unclassified").slice(0, limit).map((r) => ({ id: r.id, title: r.title, text: `${r.what_is_it ?? ""} ${r.full_brief ?? ""}`.trim().slice(0, 4000) }));
      return { ok: true, items, source: { type: "table", table: "intelligence_items" } };
    } catch (e) {
      return { ok: false, items: [], error: (e as Error).message };
    }
  };
}
