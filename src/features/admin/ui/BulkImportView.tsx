"use client";

// Ported from old_repo/src/components/admin/BulkImportView.tsx (lines 89-471)
// Ported from old_repo/src/components/admin/BulkImportView.tsx (lines 513-640)
// Ported from old_repo/src/components/admin/BulkImportView.tsx (lines 708-792)
import { useState, type ChangeEvent } from "react";

import { requestJson } from "@/core/http/request-json";
import { Button, FilePickRow, FormField, Input, InlineErrorBanner, RowTable, Segmented, StateNote, Textarea } from "@/ui";

import type { PreviewRow } from "../api/bulk-import";

import { Panel, useFlash } from "./panel-kit";
import styles from "./admin.module.css";

type Format = "csv" | "json";
interface Response {
  preview: PreviewRow[];
  summary: { total_rows: number; valid: number; invalid: number; duplicates: number };
  applied?: { sources_inserted: number; provisional_inserted: number; rejected: number };
  held?: string | null;
  failures?: string[];
  audit_log_error?: string;
}

export const CSV_TEMPLATE = 'url,name,type,jurisdiction_iso,language,notes\nhttps://example.com,Example Source,regulator,"US|EU",en,Optional notes\n';
export const JSON_TEMPLATE = JSON.stringify([{ url: "https://example.com", name: "Example Source", type: "regulator", jurisdiction_iso: ["US", "EU"], language: "en", notes: "Optional notes" }], null, 2);
const ACTION_WORDS: Record<PreviewRow["proposed_action"], string> = { "auto-approve": "Register", "queue-provisional": "Queue for review", reject: "Reject", duplicate: "Duplicate" };

/** What a row's HEAD check shows: a status code, or the reason it has none ("held" while the hold is on is not a failure). Pure. */
export const headLabel = (r: Pick<PreviewRow, "head_status" | "head_reason">): string => (typeof r.head_status === "number" ? String(r.head_status) : r.head_status === "held" ? "not checked (hold on)" : (r.head_reason ?? "no answer"));

/** Add sources in bulk: paste or upload CSV or JSON, preview every row (validation, duplicates, a free reachability check, the proposed action), then commit. Reachability is a plain request behind the hold; classification is the class table. No model, no render service. */
export function BulkImportView() {
  const [format, setFormat] = useState<Format>("csv");
  const [text, setText] = useState({ csv: "", json: "" });
  const [defaults, setDefaults] = useState("");
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Response | null>(null);
  const flash = useFlash();
  const data = text[format];
  const send = async (dryRun: boolean) => {
    setBusy(dryRun ? "preview" : "commit");
    setError(null);
    const r = await requestJson<Response>("/api/admin/sources/bulk-import", { method: "POST", body: { format, data, options: { dryRun, defaultJurisdictionIso: defaults.split(/[,\s|;]+/).map((s) => s.trim()).filter(Boolean) } } });
    setBusy(null);
    if (!r.ok || !r.data) return setError(r.error ?? "The import failed.");
    setPreview(r.data);
    if (!dryRun) flash.show(`Imported: ${r.data.applied?.sources_inserted ?? 0} registered, ${r.data.applied?.provisional_inserted ?? 0} queued, ${r.data.applied?.rejected ?? 0} rejected.`, !!r.data.audit_log_error);
  };
  const columns = [{ label: "Row", width: "48px" }, { label: "Source", width: "minmax(220px, 3fr)" }, { label: "Check", width: "minmax(120px, 1fr)" }, { label: "Action", width: "130px" }, { label: "Problems", width: "minmax(160px, 2fr)" }];
  return (
    <Panel title="Bulk add sources">
      <Segmented<Format> label="Input format" options={[{ id: "csv", label: "CSV" }, { id: "json", label: "JSON" }]} selected={[format]} onSelect={(f) => { setFormat(f); setPreview(null); }} />
      {format === "csv" ? <FilePickRow label="Upload a CSV file" hint="or paste below" accept=".csv,text/csv" onFile={async (e: ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (!f) return; const body = await f.text(); setText((t) => ({ ...t, csv: body })); setPreview(null); }} /> : null}
      <Textarea rows={8} spellCheck={false} aria-label={format === "csv" ? "CSV content" : "JSON content"} value={data} onChange={(e) => { setText({ ...text, [format]: e.target.value }); setPreview(null); }} placeholder={format === "csv" ? "url,name,type,jurisdiction_iso" : '[ { "url": "https://...", "name": "..." } ]'} />
      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={() => setText({ ...text, [format]: format === "csv" ? CSV_TEMPLATE : JSON_TEMPLATE })}>Fill a template</Button>
      </div>
      <FormField label="Default jurisdiction" hint="Applied to rows with none of their own. Codes such as US, EU, GLOBAL, US-CA.">{(c) => <Input {...c} value={defaults} onChange={(e) => setDefaults(e.target.value)} placeholder="US, EU" />}</FormField>
      <div className={styles.actions}>
        <Button variant="secondary" disabled={!data.trim() || busy !== null} onClick={() => send(true)}>{busy === "preview" ? "Checking..." : "Preview"}</Button>
        <Button variant="primary" disabled={!preview || preview.applied !== undefined || busy !== null || preview.summary.valid === 0} onClick={() => send(false)}>{busy === "commit" ? "Importing..." : "Commit import"}</Button>
      </div>
      {error ? <InlineErrorBanner message={error} /> : null}
      {preview?.held ? <StateNote>Nothing was fetched because the hold is on ({preview.held.replace(/_/g, " ")}). Rows are checked for shape and queued for review.</StateNote> : null}
      {preview ? (
        <>
          <p className={styles.note}>{preview.summary.total_rows} rows: {preview.summary.valid} usable, {preview.summary.invalid} refused, {preview.summary.duplicates} duplicates.{preview.applied ? ` Applied: ${preview.applied.sources_inserted} registered, ${preview.applied.provisional_inserted} queued, ${preview.applied.rejected} rejected.` : ""}</p>
          <RowTable columns={columns} rows={preview.preview.map((r) => ({ key: String(r.row_index), cells: [<span key="i">{r.row_index + 1}</span>, <span key="s" className={styles.cell}><b>{r.name || "(no name)"}</b><br /><span className={styles.mono}>{r.url}</span></span>, <span key="h">{headLabel(r)}</span>, <span key="a" className={r.proposed_action === "reject" ? styles.pillBad : styles.pill}>{ACTION_WORDS[r.proposed_action]}</span>, <span key="p" className={styles.cell}>{r.validation_errors.length ? r.validation_errors.join("; ") : r.duplicate_of_source_id ? `Duplicate of ${r.duplicate_of_source_id.slice(0, 8)}` : ""}</span>] }))} />
          {preview.failures?.length ? <InlineErrorBanner message="Some rows did not complete:"><ul>{preview.failures.map((f, i) => <li key={i}>{f}</li>)}</ul></InlineErrorBanner> : null}
          {preview.audit_log_error ? <InlineErrorBanner message={preview.audit_log_error} /> : null}
        </>
      ) : null}
      {flash.node}
    </Panel>
  );
}
