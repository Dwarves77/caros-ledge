// Ported from old_repo/src/app/api/admin/sources/bulk-import/route.ts (lines 83-205)
// Ported from old_repo/src/app/api/admin/sources/bulk-import/route.ts (lines 256-375)
// Ported from old_repo/src/app/api/admin/sources/bulk-import/route.ts (lines 379-483)
// Ported from old_repo/src/app/api/admin/sources/bulk-import/route.ts (lines 485-612)
// Ported from old_repo/src/app/api/admin/sources/bulk-import/logic.ts (lines 10-19)
import { z } from "zod";

import { splitCsvText } from "@/core/csv";
import type { Db } from "@/core/db";
import { fetchAllowed } from "@/core/fetch";
import { HttpError } from "@/core/http/errors";
import { parseJson } from "@/core/http/parse";
import { canonicalUrl } from "@/core/shared";
import { classTierForHost } from "@/core/sources";
import { runBounded } from "@/features/sources/triage";
import { verifyCandidate, type VerificationResult } from "@/features/sources/verify-candidate";
import { hostOf } from "@/core/shared";
import { FetchHoldError } from "@/core/fetch";

import { adminRoute, reply } from "./shared";

const MAX_ROWS = 500;
const ISO_PATTERN = /^([A-Z]{2}|[A-Z]{2}-[A-Z0-9]{1,3}|EU|GLOBAL|IMO|ICAO)$/;
/** The import's `type` column, each value to the registered source_type it means; a type the vocabulary has no token for is kept in the notes, never dropped. */
const TYPE_TO_SOURCE_TYPE: Readonly<Record<string, string | null>> = { regulator: "regulatory_executive", "standards-body": "standards_body", "industry-association": "industry_assoc", gazette: "gazette", intergovernmental: "treaty_org", academic: "research_institute", ngo: null, "trade-press": "news", "law-firm": null, other: null };

export interface ImportRow {
  url: string;
  name: string;
  type?: string | undefined;
  jurisdiction_iso?: string[] | undefined;
  language?: string | undefined;
  notes?: string | undefined;
}
export type ProposedAction = "queue-provisional" | "reject" | "duplicate";
export interface PreviewRow {
  row_index: number;
  url: string;
  name: string;
  head_status: number | "error" | "held";
  head_reason?: string | undefined;
  duplicate_of_source_id: string | null;
  validation_errors: string[];
  proposed_action: ProposedAction | "auto-approve";
}

const list = (v: string): string[] | undefined => (v ? v.split(/[|;,\s]+/).map((s) => s.trim()).filter(Boolean) : undefined);

/** CSV text to rows: quoted newlines and commas survive (the shared splitter), the header names the columns, `url` and `name` are required. */
function parseImport(format: "csv" | "json", raw: string): { rows: ImportRow[]; error?: string } {
  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { rows: [], error: `Invalid JSON: ${(e as Error).message}` };
    }
    if (!Array.isArray(parsed)) return { rows: [], error: "JSON body must be an array of rows" };
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
    return { rows: parsed.filter((x): x is Record<string, unknown> => !!x && typeof x === "object").map((o) => ({ url: str(o.url) ?? "", name: str(o.name) ?? "", type: str(o.type), jurisdiction_iso: Array.isArray(o.jurisdiction_iso) ? o.jurisdiction_iso.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean) : undefined, language: str(o.language), notes: str(o.notes) })) };
  }
  const { header, rows } = splitCsvText(raw);
  if (!header.length) return { rows: [], error: "CSV is empty" };
  for (const col of ["url", "name"]) if (!header.includes(col)) return { rows: [], error: `CSV header missing required column: ${col}` };
  const cell = (r: string[], col: string) => (header.includes(col) ? (r[header.indexOf(col)] ?? "").trim() : "");
  return { rows: rows.filter((r) => !r.every((c) => c === "")).map((r) => ({ url: cell(r, "url"), name: cell(r, "name"), type: cell(r, "type") || undefined, jurisdiction_iso: list(cell(r, "jurisdiction_iso")), language: cell(r, "language") || undefined, notes: cell(r, "notes") || undefined })) };
}

/** The reasons a row cannot be imported, and the jurisdiction it carries (its own, else the default). Pure. */
function validateImportRow(row: ImportRow, defaults: readonly string[]): { errors: string[]; jurisdiction: string[] } {
  const errors: string[] = [];
  if (!row.url) errors.push("url is required");
  if (!row.name) errors.push("name is required");
  if (row.url) {
    try {
      if (!["http:", "https:"].includes(new URL(row.url).protocol)) errors.push("url must use http or https");
    } catch {
      errors.push("url is not well-formed");
    }
  }
  if (row.type && !(row.type in TYPE_TO_SOURCE_TYPE)) errors.push(`type "${row.type}" is not in allowed set: ${Object.keys(TYPE_TO_SOURCE_TYPE).join(", ")}`);
  for (const code of row.jurisdiction_iso ?? []) if (!ISO_PATTERN.test(code)) errors.push(`jurisdiction_iso "${code}" does not match expected ISO pattern`);
  if (row.language && !/^[a-z]{2}$/i.test(row.language)) errors.push(`language "${row.language}" must be ISO 639-1 (two letters)`);
  return { errors, jurisdiction: row.jurisdiction_iso?.length ? row.jurisdiction_iso : [...defaults] };
}

/** What verification decided for one row, as the import's proposal. A non-answer or a held fetch is INCONCLUSIVE and queues for review; only a definitive 404 or 410 (or a gated or duplicate host) is refused. */
function proposalOf(v: VerificationResult): { action: ProposedAction | "auto-approve"; head: number | "error"; reason?: string } {
  const reach = (v.log.reachability ?? {}) as { finalStatus?: number | null; outcome?: string };
  const head = typeof reach.finalStatus === "number" ? reach.finalStatus : "error";
  if (v.rejection_reason === "duplicate") return { action: "duplicate", head };
  return { action: v.action === "auto-approved" ? "auto-approve" : v.action === "queued-provisional" ? "queue-provisional" : "reject", head, ...(reach.outcome ? { reason: reach.outcome } : {}) };
}

interface Applied {
  sources_inserted: number;
  provisional_inserted: number;
  rejected: number;
}

/** What an imported row's own columns add to the row verification created: type, language and notes are written, not validated and dropped. */
async function annotate(db: Db, v: VerificationResult, row: ImportRow, jurisdiction: readonly string[]): Promise<string | null> {
  const mapped = row.type ? TYPE_TO_SOURCE_TYPE[row.type] : null;
  const extra = [row.type && !mapped ? `type=${row.type}` : null, row.language ? `language=${row.language}` : null, row.notes ?? null].filter(Boolean).join(" · ");
  if (v.resulting_source_id) {
    const { error } = await db.from("sources").update({ ...(mapped ? { source_type: [mapped] } : {}), ...(jurisdiction.length ? { jurisdiction_iso: [...jurisdiction] } : {}), ...(extra ? { notes: extra } : {}) }).eq("id", v.resulting_source_id);
    return error?.message ?? null;
  }
  if (v.resulting_provisional_id) {
    const { error } = await db.from("provisional_sources").update({ discovered_via: "manual_add", ...(extra ? { description: extra } : {}), ...(jurisdiction.length ? { discovered_for_jurisdiction: jurisdiction.join(",") } : {}) }).eq("id", v.resulting_provisional_id);
    return error?.message ?? null;
  }
  return null;
}

/** While the hold is on nothing is fetched, so the row is queued unverified (a held check is inconclusive, never a pass): one insert at the class tier's recommendation. */
async function queueHeld(db: Db, row: ImportRow, jurisdiction: readonly string[]): Promise<boolean> {
  const url = canonicalUrl(row.url) ?? row.url;
  const { error } = await db.from("provisional_sources").insert({ name: row.name, url, description: row.notes ?? "", discovered_via: "manual_add", provisional_tier: 7, recommended_tier: classTierForHost(hostOf(url), row.name), status: "pending_review", discovered_for_jurisdiction: jurisdiction.join(",") || null });
  if (error && (error as { code?: string }).code !== "23505") throw new HttpError(500, `queue insert failed: ${error.message}`);
  return !error;
}

const body = z.object({ format: z.enum(["csv", "json"]), data: z.string().min(1).max(1_000_000), options: z.object({ dryRun: z.boolean().optional(), defaultJurisdictionIso: z.array(z.string().trim().max(10)).max(20).optional() }).optional() });

/**
 * Bulk source import: parse, validate, verify each row through the free pipeline (a HEAD check behind the hold, the class table, the off-vertical gate, the exact-host duplicate check), preview by default,
 * apply on request, and one bulk_imports audit row whose failure is reported and raised as a flag. No model, no render service. A row never fails the batch.
 */
export const POST = adminRoute("/api/admin/sources/bulk-import", async (admin, request) => {
  const b = await parseJson(request, body);
  const defaults = (b.options?.defaultJurisdictionIso ?? []).filter(Boolean);
  const badDefault = defaults.find((c) => !ISO_PATTERN.test(c));
  if (badDefault) throw new HttpError(400, `defaultJurisdictionIso entry "${badDefault}" does not match expected ISO pattern`);
  const parsed = parseImport(b.format, b.data);
  if (parsed.error) throw new HttpError(400, parsed.error);
  if (!parsed.rows.length) throw new HttpError(400, "No rows parsed from input");
  if (parsed.rows.length > MAX_ROWS) throw new HttpError(400, `Too many rows (${parsed.rows.length}). Maximum is ${MAX_ROWS}.`);
  const dry = b.options?.dryRun !== false;
  const db = admin.service();
  const hold = await fetchAllowed("https://hold.invalid/", null, { db, env: process.env });
  const deps = { db, env: process.env, now: () => new Date() };
  const seen = new Set<string>();
  const preview: PreviewRow[] = [];
  const applied: Applied = { sources_inserted: 0, provisional_inserted: 0, rejected: 0 };
  const failures: string[] = [];

  await runBounded(parsed.rows.map((row, i) => ({ row, i })), async ({ row, i }) => {
    const { errors, jurisdiction } = validateImportRow(row, defaults);
    const base = { row_index: i, url: row.url, name: row.name, duplicate_of_source_id: null, validation_errors: errors };
    const canon = canonicalUrl(row.url) ?? "";
    if (errors.length) return void preview.push({ ...base, head_status: "error", head_reason: "skipped: row failed validation", proposed_action: "reject" });
    if (seen.has(canon)) return void preview.push({ ...base, head_status: "error", head_reason: "skipped: the same address appears earlier in this file", proposed_action: "duplicate" });
    seen.add(canon);
    if (!hold.allowed) {
      if (!dry) {
        try {
          if (await queueHeld(db, row, jurisdiction)) applied.provisional_inserted += 1;
        } catch (e) {
          failures.push(`row ${i}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return void preview.push({ ...base, head_status: "held", head_reason: `not checked: ${hold.reason.replace(/_/g, " ")}`, proposed_action: "queue-provisional" });
    }
    try {
      const run = await verifyCandidate(deps, { url: row.url, name: row.name, jurisdiction_iso: jurisdiction, dry });
      const v = run.data as VerificationResult;
      const p = proposalOf(v);
      preview.push({ ...base, head_status: p.head, head_reason: p.reason, proposed_action: p.action });
      if (dry) return;
      if (v.resulting_source_id) applied.sources_inserted += 1;
      else if (v.resulting_provisional_id || v.action === "queued-provisional") applied.provisional_inserted += 1;
      else if (p.action !== "duplicate") applied.rejected += 1;
      const problem = await annotate(db, v, row, jurisdiction);
      if (problem) failures.push(`row ${i}: its columns were not written: ${problem}`);
      failures.push(...run.notes.filter((n) => run.outcome !== "ok" && n));
    } catch (e) {
      if (e instanceof FetchHoldError) preview.push({ ...base, head_status: "held", head_reason: "not checked: the hold is on", proposed_action: "queue-provisional" });
      else failures.push(`row ${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, { concurrency: 4, now: () => Date.now() });

  preview.sort((x, y) => x.row_index - y.row_index);
  const duplicates = preview.filter((p) => p.proposed_action === "duplicate").length;
  const invalid = preview.filter((p) => p.proposed_action === "reject").length;
  const summary = { total_rows: parsed.rows.length, valid: parsed.rows.length - invalid - duplicates, invalid, duplicates };
  if (dry) return reply(admin, { preview, summary, held: hold.allowed ? null : hold.reason, failures });

  const audit = await db.from("bulk_imports").insert({ imported_by: admin.userId, format: b.format, total_rows: summary.total_rows, sources_inserted: applied.sources_inserted, provisional_inserted: applied.provisional_inserted, rejected: applied.rejected, raw_input: b.data.slice(0, 100_000), preview_summary: { summary, preview: preview.map((p) => ({ row_index: p.row_index, url: p.url, proposed_action: p.proposed_action, head_status: p.head_status, validation_errors: p.validation_errors })) } });
  let auditError: string | undefined;
  if (audit.error) {
    auditError = `bulk_imports audit row failed to write: ${audit.error.message}`;
    const flag = await db.from("integrity_flags").insert({ category: "data_integrity", subject_type: "system", subject_ref: "bulk-import-audit", description: `${auditError}. imported_by=${admin.userId} sources_inserted=${applied.sources_inserted} provisional_inserted=${applied.provisional_inserted} rejected=${applied.rejected}. The writes committed; only the audit row is missing.`, recommended_actions: [{ action: "Verify the sources and provisional rows from this apply and backfill a bulk_imports row", rationale: "the audit insert failed after the writes it records" }], status: "open", created_by: "bulk-import-route" });
    if (flag.error) failures.push(`the audit failure could not be flagged either: ${flag.error.message}`);
  }
  return reply(admin, { preview, summary, applied, failures, ...(auditError ? { audit_log_error: auditError } : {}) });
});
