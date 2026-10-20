// Ported from old_repo/scripts/spec09/lib/rows-file.mjs (lines 1-83)
// Ported from old_repo/scripts/spec09/lib/operator-rows-contract.mjs (lines 1-245)
// Ported from old_repo/scripts/spec09/lib/cli-csv-args.mjs (lines 1-22)
// Reviewed rows files (a citation on every row, the cited source rated by the class table) and the operator CSV contract (two tables, size and row caps,
// entity references now validated by the producer that calls this). A citation's retrieved_at must be a real date, and its quote must stand on a stored capture of the cited URL that holds it verbatim
// (registerCitedSource: acceptStoredQuote, the same rule the statutory inputs use): a quote nobody checked against a capture is refused.
import { z } from "zod";

import { classTierForHost, type HostVerdictRef } from "@/core/sources";
import { registerAndRate } from "@/core/sources/register";
import { splitCsvText } from "@/core/csv/stream";
import type { Db } from "@/core/db";
import { hostOf } from "@/core/shared";

import { acceptStoredQuote, parseVerifiedAt } from "./quote";
import tables from "./data/operator-tables.json";

export class RowsFileError extends Error {}

/** Parse a rows file's JSON text: a bare array or `{ rows: [...] }`, non-empty. Throws RowsFileError (never a raw parse error). */
export function loadRowsFile(text: string, label = "rows file"): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new RowsFileError(`could not parse ${label}: ${(e as Error).message}`);
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || !rows.length) throw new RowsFileError(`${label} has no rows[] (or is not an array): refusing to run on an empty file.`);
  return rows as Record<string, unknown>[];
}

export interface Citation {
  url: string;
  title: string;
  retrieved_at: string;
  quote: string;
}
/** Every row REQUIRES a citation block (rule 18: a figure with no source is never published). Throws naming exactly what is missing; never guesses. */
export function requireCitation(row: Record<string, unknown>, index: number, where: string): Citation {
  const c = row?.citation as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") throw new RowsFileError(`${where}: row[${index}] has no citation {url, title, retrieved_at, quote}: refused, not guessed.`);
  for (const f of ["url", "title", "retrieved_at", "quote"]) if (typeof c[f] !== "string" || !(c[f] as string).trim()) throw new RowsFileError(`${where}: row[${index}].citation.${f} is required and must be a non-empty string.`);
  try {
    new URL(c.url as string);
  } catch {
    throw new RowsFileError(`${where}: row[${index}].citation.url is not a valid absolute URL: "${c.url}"`);
  }
  if (!parseVerifiedAt(c.retrieved_at)) throw new RowsFileError(`${where}: row[${index}].citation.retrieved_at "${String(c.retrieved_at)}" is not a date (YYYY-MM-DD).`);
  return c as unknown as Citation;
}

export type CitedSource = { refused: true; reason: string; wouldRegisterTier?: number } | { refused: false; source_id: string; host: string; tier: number; created: boolean };
/**
 * Register a citation as a `sources` row rated through the institution class table, never a hand-typed tier. A host the table cannot classify is refused with the
 * reason (ambiguous hosts are worklisted, SC-13); with no client the answer is the refusal "would register at tier N" so a dry run needs no database.
 */
export async function registerCitedSource(citation: Pick<Citation, "url" | "title"> & Partial<Pick<Citation, "quote" | "retrieved_at">>, deps: { sb: Db | null; verdicts?: ReadonlyMap<string, HostVerdictRef> | null }): Promise<CitedSource> {
  const host = hostOf(citation.url);
  if (!host) return { refused: true, reason: `citation.url has no resolvable host: "${citation.url}"` };
  if (deps.sb && citation.quote !== undefined) {
    const verdict = await acceptStoredQuote(deps.sb, { url: citation.url, quote: citation.quote, verifiedAt: citation.retrieved_at });
    if (!verdict.ok) return { refused: true, reason: `${verdict.reason}: ${verdict.detail}` };
  }
  if (!deps.sb) {
    const tier = classTierForHost(host, citation.title);
    return tier == null
      ? { refused: true, reason: `host "${host}" does not resolve to a codified class (classTierForHost): ambiguous hosts are worklisted, never guessed a tier (SC-13).` }
      : { refused: true, reason: `no database client (dry run): the citation would register at tier ${tier}`, wouldRegisterTier: tier };
  }
  const r = await registerAndRate(deps.sb, citation.url, { name: citation.title || host, verdicts: deps.verdicts ?? null });
  return r.status === "registered" || r.status === "existing" ? { refused: false, source_id: r.source_id, host, tier: r.tier, created: r.status === "registered" } : { refused: true, reason: `${r.status}: ${"reason" in r ? r.reason : "not registered"}` };
}

/** An entity id by EXACT canonical name within an already kind-filtered list. Never mints an entity; null when no row matches exactly. */
export function resolveEntityByName(list: ReadonlyArray<{ canonical_name: string; entity_id: string }> | null | undefined, canonicalName: string): string | null {
  return (list ?? []).find((e) => e.canonical_name === canonicalName)?.entity_id ?? null;
}

// ---- the operator CSV contract ----
const MAX_BYTES_PER_FILE = 262_144;
const MAX_ROWS_PER_FILE = 500;

const columns = z.array(z.object({ name: z.string(), kind: z.enum(["string", "number", "enum", "date"]), required: z.boolean(), min: z.number().optional(), max: z.number().optional(), values: z.array(z.string()).optional() }));
const contracts = z.record(z.string(), z.object({ columns, entityRefs: z.array(z.object({ field: z.string(), kind: z.string() })) })).parse(tables);
const OPERATOR_ROW_TABLES: readonly string[] = Object.freeze(Object.keys(contracts));
type Column = z.infer<typeof columns>[number];

function cellValue(c: Column, raw: string): { value: unknown } | { error: string } {
  const s = (raw ?? "").trim();
  if (!s) return c.required ? { error: `${c.name} is required${c.kind === "enum" ? ` (one of: ${c.values?.join(", ")})` : c.kind === "date" ? " (YYYY-MM-DD)" : ""}` } : { value: null };
  if (c.kind === "string") return { value: s };
  if (c.kind === "enum") return c.values?.includes(s) ? { value: s } : { error: `${c.name} must be one of: ${c.values?.join(", ")} (got ${JSON.stringify(s)})` };
  if (c.kind === "date") return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? { value: s } : { error: `${c.name} must be a valid YYYY-MM-DD date (got ${JSON.stringify(s)})` };
  const n = Number(s);
  if (!Number.isFinite(n)) return { error: `${c.name} must be a number${c.required ? "" : " when present"} (got ${JSON.stringify(s)})` };
  if (n < (c.min ?? -Infinity) || n > (c.max ?? Infinity)) return { error: `${c.name} must be between ${c.min ?? -Infinity} and ${c.max ?? Infinity} (got ${n})` };
  return { value: n };
}

export interface ParsedOperatorRows {
  ok: boolean;
  error?: string;
  accepted: Array<{ rowNumber: number; data: Record<string, unknown> }>;
  rejected: Array<{ rowNumber: number; raw: string[]; errors: string[] }>;
  total: number;
}
/** Parse a whole operator CSV for one table. A bad row is a rejection in the result; only size and shape problems the caller cannot recover from are `ok: false`. */
export function parseOperatorRows(table: string, csvText: string, o: { maxRows?: number; maxBytes?: number } = {}): ParsedOperatorRows {
  const fail = (error: string, total = 0): ParsedOperatorRows => ({ ok: false, error, accepted: [], rejected: [], total });
  const contract = contracts[table];
  if (!contract) return fail(`unknown table "${table}", must be one of: ${OPERATOR_ROW_TABLES.join(", ")}`);
  const bytes = Buffer.byteLength(String(csvText ?? ""), "utf8");
  if (bytes > (o.maxBytes ?? MAX_BYTES_PER_FILE)) return fail(`rows file is ${bytes} bytes, exceeding the ${o.maxBytes ?? MAX_BYTES_PER_FILE}-byte cap`);
  const { header, rows } = splitCsvText(csvText);
  if (rows.length === 0) return fail("CSV has no data rows");
  if (rows.length > (o.maxRows ?? MAX_ROWS_PER_FILE)) return fail(`CSV has ${rows.length} data rows, exceeding the ${o.maxRows ?? MAX_ROWS_PER_FILE}-row cap`, rows.length);
  const missingHeaders = contract.columns.filter((c) => c.required && !header.includes(c.name)).map((c) => c.name);
  if (missingHeaders.length) return fail(`CSV header missing required column(s): ${missingHeaders.join(", ")}`, rows.length);
  const out: ParsedOperatorRows = { ok: true, accepted: [], rejected: [], total: rows.length };
  rows.forEach((cells, i) => {
    const rowNumber = i + 2;
    const errors: string[] = [];
    const data: Record<string, unknown> = {};
    for (const c of contract.columns) {
      const idx = header.indexOf(c.name);
      const r = cellValue(c, idx < 0 ? "" : (cells[idx] ?? ""));
      if ("error" in r) errors.push(r.error);
      else data[c.name] = r.value;
    }
    if (!errors.length && typeof data.cap_pct === "number" && typeof data.floor_pct === "number" && data.floor_pct > data.cap_pct) errors.push("floor_pct must be <= cap_pct (an inverted band cannot be applied)");
    if (errors.length) out.rejected.push({ rowNumber, raw: cells, errors });
    else out.accepted.push({ rowNumber, data });
  });
  return out;
}

/** Every distinct non-empty entity-ref value an accepted batch references: the caller reads `entities` for exactly this set, once per batch. */
export function entityRefValuesForTable(table: string, accepted: ParsedOperatorRows["accepted"]): Set<string> {
  const values = new Set<string>();
  for (const { data } of accepted) for (const ref of contracts[table]?.entityRefs ?? []) if (typeof data[ref.field] === "string" && data[ref.field] !== "") values.add(data[ref.field] as string);
  return values;
}

/** Split accepted rows into those whose entity refs all resolve against `existing` and those that do not, with the reason per row. */
export function validateEntityRefs(table: string, accepted: ParsedOperatorRows["accepted"], existing: ReadonlySet<string>) {
  const refs = contracts[table]?.entityRefs ?? [];
  const valid: ParsedOperatorRows["accepted"] = [];
  const invalid: Array<{ rowNumber: number; errors: string[] }> = [];
  for (const row of accepted) {
    const errors = refs.filter((r) => typeof row.data[r.field] === "string" && row.data[r.field] !== "" && !existing.has(row.data[r.field] as string)).map((r) => `${r.field} "${row.data[r.field]}" does not match any known entity (kind expected: ${r.kind})`);
    if (errors.length) invalid.push({ rowNumber: row.rowNumber, errors });
    else valid.push(row);
  }
  return { valid, invalid };
}
