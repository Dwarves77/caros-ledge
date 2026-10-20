// Ported from old_repo/scripts/producers/market/sbti-target-dashboard-producer.mjs (lines 28-312)
// SBTi Target Dashboard per-sector lead time (months) and commitments removed (survivorship), into market_series. LICENCE BLOCKED: redistribution is prohibited
// (source-licence register), so the licence gate refuses every apply before any other gate; a dry run reads and reports only (INV-245).
import { slugify } from "@/core/shared";
import { cellText, readSheet, type SheetRow } from "@/core/producers/xlsx";
import { StructureError, type ParseOut, type ProducerSpec } from "@/core/producers/runner";
import type { Rec } from "@/core/producers/upsert-plan";

import { marketSeriesBase } from "./market-series-delta";

const SBTI_XLSX_URL = "https://files.sciencebasedtargets.org/production/files/targets-excel.xlsx";
const SHEET_NAME = "WebsiteData";
const LICENCE_BLOCK = {
  sourceKey: "sbti_dashboard",
  reason:
    "SBTi's 'sbti_dashboard' register entry states redistribution=\"prohibited\" (\"This does not represent a license to repackage or resell any of the data\"); express permission is required from BOTH SBTi and CDP. " +
    "This producer cannot write market_series rows from this source until that permission exists or the register entry changes, a reviewed code change citing the resolution, never a runtime flag. A dry run reads and reports; it does not redistribute.",
} as const;
const FIELDS = { sector: "sector", status: "status", action: "action", target: "target", baseYear: "base_year", targetYear: "target_year", datePublished: "date_published", companyName: "company_name" } as const;

export interface SbtiRow {
  sector: string;
  status: string;
  action: string;
  target: string;
  baseYear: number | null;
  targetYear: number | null;
  datePublishedIso: string | null;
  companyName: string;
}

/** An Excel serial day to YYYY-MM-DD (1900 system, epoch 1899-12-30); null when not a finite number. */
function excelSerialToIsoDate(serial: unknown): string | null {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Columns by header NAME (row 1), never by position; a missing expected column refuses the whole read. */
function resolveHeaderColumns(rows: SheetRow[], shared: readonly string[]): Record<keyof typeof FIELDS, string> {
  const head = rows.find((r) => r.rowNum === 1);
  if (!head) throw new StructureError("no row 1 found: cannot resolve the header");
  const byLabel = new Map([...head.cells].map(([col, cell]) => [cellText(cell, shared).trim().toLowerCase(), col] as const).filter(([l]) => l));
  const missing = Object.values(FIELDS).filter((l) => !byLabel.has(l));
  if (missing.length) throw new StructureError(`header row is missing expected column(s): ${missing.join(", ")}; the live header no longer matches what this parser was built against, so it refuses rather than guess a column`);
  return Object.fromEntries(Object.entries(FIELDS).map(([k, l]) => [k, byLabel.get(l)])) as Record<keyof typeof FIELDS, string>;
}

function extractSbtiTargetRows(rows: SheetRow[], shared: readonly string[], cols: Record<keyof typeof FIELDS, string>): SbtiRow[] {
  return rows
    .filter((r) => r.rowNum !== 1)
    .map((r) => {
      const get = (f: keyof typeof FIELDS) => cellText(r.cells.get(cols[f]), shared);
      const by = get("baseYear");
      const ty = get("targetYear");
      const dp = r.cells.get(cols.datePublished);
      return { sector: get("sector").trim(), status: get("status").trim(), action: get("action").trim(), target: get("target").trim(), baseYear: by ? Number(by) : null, targetYear: ty ? Number(ty) : null, datePublishedIso: dp ? excelSerialToIsoDate(cellText(dp, shared)) : null, companyName: get("companyName").trim() };
    });
}

const validYear = (n: number | null): n is number => Number.isInteger(n) && (n as number) >= 1990 && (n as number) <= 2100;
type Bucket = { nearTerm: Array<{ months: number; date: string | null }>; netZero: Array<{ months: number; date: string | null }>; removedCount: number; removedMaxDate: string | null };
const maxDate = (xs: Array<{ date: string | null }>): string | null => xs.reduce<string | null>((m, e) => (e.date && (!m || e.date > m) ? e.date : m), null);

/**
 * Per sector: mean lead time (target year minus base year, in months, 1 decimal) for near-term and net-zero targets with status "Other", and the count of
 * "Removed" commitments (survivorship, aggregated first). A row with a bad year, an unknown target type or no parseable date is excluded with a counted reason.
 */
function aggregateSbtiTargetRows(data: readonly SbtiRow[]): { seriesRows: Rec[]; skipReasons: Map<string, number>; sectorCount: number } {
  const bySector = new Map<string, Bucket>();
  const skip = new Map<string, number>();
  const bump = (r: string) => skip.set(r, (skip.get(r) ?? 0) + 1);
  for (const r of data) {
    if (!r.sector) {
      bump("missing sector");
      continue;
    }
    const b = bySector.get(r.sector) ?? { nearTerm: [], netZero: [], removedCount: 0, removedMaxDate: null };
    bySector.set(r.sector, b);
    if (/removed/i.test(r.status)) {
      b.removedCount += 1;
      if (r.datePublishedIso && (!b.removedMaxDate || r.datePublishedIso > b.removedMaxDate)) b.removedMaxDate = r.datePublishedIso;
    } else if (r.status.toLowerCase() !== "other") bump(`status not Other/Removed ("${r.status || "blank"}")`);
    else if (!validYear(r.baseYear)) bump("missing/invalid base_year");
    else if (!validYear(r.targetYear)) bump("missing/invalid target_year");
    else if (!(r.targetYear - r.baseYear > 0)) bump("target_year not after base_year");
    else {
      const e = { months: (r.targetYear - r.baseYear) * 12, date: r.datePublishedIso };
      const t = r.target.toLowerCase();
      if (t === "near-term") b.nearTerm.push(e);
      else if (t === "net-zero") b.netZero.push(e);
      else bump(`unrecognised target type ("${r.target || "blank"}")`);
    }
  }
  const seriesRows: Rec[] = [];
  const base = { currency: null, derivation: "calculated", origin_class: "derived", source_key: LICENCE_BLOCK.sourceKey, method_version: "sbti-lead-time-v1" };
  for (const [sector, b] of bySector) {
    const slug = slugify(sector, 200);
    if (!slug) {
      bump(`sector slug empty for "${sector}"`);
      continue;
    }
    for (const [kind, entries, label] of [["near-term", b.nearTerm, "Near-term"], ["net-zero", b.netZero, "Net-zero"]] as const) {
      if (!entries.length) continue;
      const ref = maxDate(entries);
      if (!ref) {
        bump(`sector "${sector}" ${kind}: no parseable date_published across ${entries.length} contributing row(s), aggregate skipped`);
        continue;
      }
      seriesRows.push({ ...base, series_key: `sbti:${kind}-lead-time-${slug}`, label: `${label} target lead time (base year to target year), ${sector}, SBTi Target Dashboard`, value_numeric: Math.round((entries.reduce((s, e) => s + e.months, 0) / entries.length) * 10) / 10, unit: "months", source_ref: `SBTi Target Dashboard, targets-excel.xlsx, sheet "${SHEET_NAME}", sector "${sector}", ${entries.length} ${kind} row(s) as of ${ref}`, n_observations: entries.length, as_at_date: ref, reference_period: ref });
    }
    if (b.removedCount > 0) {
      if (!b.removedMaxDate) bump(`sector "${sector}" commitment-removed: no parseable date_published across ${b.removedCount} removed row(s), aggregate skipped`);
      else seriesRows.push({ ...base, series_key: `sbti:commitment-removed-${slug}`, label: `Commitments removed (survivorship), ${sector}, SBTi Target Dashboard`, value_numeric: b.removedCount, unit: "companies", source_ref: `SBTi Target Dashboard, targets-excel.xlsx, sheet "${SHEET_NAME}", sector "${sector}", ${b.removedCount} removed row(s) as of ${b.removedMaxDate}`, n_observations: null, as_at_date: b.removedMaxDate, reference_period: b.removedMaxDate });
    }
  }
  return { seriesRows, skipReasons: skip, sectorCount: bySector.size };
}

export const sbtiTargets: ProducerSpec = {
  name: "sbti-target-dashboard",
  ...marketSeriesBase("sbti"),
  licenceKey: "sbti_dashboard",
  licenceBlock: LICENCE_BLOCK.reason,
  enabled: false,
  enabledRuling: "licence blocked: redistribution prohibited; permission from SBTi and CDP is the discharge",
  killSwitchEnv: "MARKET_PRODUCER_SBTI_ENABLED",
  async fetchDoc(ctx) {
    return { bytes: Buffer.from(await (await ctx.get(SBTI_XLSX_URL, { headers: { accept: "application/octet-stream" } })).arrayBuffer()) };
  },
  parse(doc): ParseOut<Rec> {
    if (!doc.bytes) throw new StructureError("the SBTi producer reads a workbook; pass its bytes as the input");
    const { rows, shared } = readSheet(doc.bytes, SHEET_NAME);
    const data = extractSbtiTargetRows(rows, shared, resolveHeaderColumns(rows, shared));
    const { seriesRows, skipReasons, sectorCount } = aggregateSbtiTargetRows(data);
    return { rows: seriesRows, warnings: [...skipReasons].map(([r, n]) => `[aggregate] ${n} row(s) excluded: ${r}`), counts: { target_rows: data.length, sectors: sectorCount } };
  },
};
