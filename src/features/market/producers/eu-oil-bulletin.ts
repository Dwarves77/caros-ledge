// Ported from old_repo/scripts/producers/market/fetch-oil-bulletin.mjs (lines 17-159)
// Ported from old_repo/scripts/producers/market/eu-weekly-oil-bulletin.mjs (lines 38-41)
// Ported from old_repo/src/lib/market/parsers/eu-weekly-oil-bulletin.mjs (lines 1-110)
// Ported from old_repo/src/lib/market/oil-bulletin-workbook.mjs (lines 120-420)
// EU Weekly Oil Bulletin: find the history workbook on the bulletin page (known URL as fallback), read the pre-tax EU block of "Prices wo taxes" in-process, and
// plan weekly rows. The workbook's two independent header keys must agree, or the run refuses rather than guess a column.
import { cellText, readSheet, type SheetRow } from "@/core/producers/xlsx";
import { StructureError, type Doc, type ParseOut, type ProducerSpec } from "@/core/producers/runner";
import type { Rec } from "@/core/producers/upsert-plan";

import { marketSeriesBase, seriesCaptureQuery, stampEntity, type SeriesCapture } from "./market-series-delta";

const PAGE_URL = "https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en";
const ORIGIN = "https://energy.ec.europa.eu";
const FALLBACK_XLSX = "https://energy.ec.europa.eu/document/download/906e60ca-8b6a-44e7-8589-652854d2fd3f_en?filename=Weekly_Oil_Bulletin_Prices_History_maticni_4web.xlsx";
const PRICE_SHEET = "Prices wo taxes";
const SCOPE = "EU average, before taxes";
const PRODUCTS: Readonly<Record<string, { product: string; unit: string }>> = Object.freeze({
  "eurosuper-95": { product: "Euro-Super 95", unit: "EUR/1000L" },
  "automotive-diesel": { product: "Automotive gas oil / diesel", unit: "EUR/1000L" },
  "heating-gas-oil": { product: "Heating gas oil", unit: "EUR/1000L" },
  "lpg-motor-fuel": { product: "LPG motor fuel", unit: "EUR/1000L" },
  "residual-fuel-oil-1pct": { product: "Residual fuel oil 1%S", unit: "EUR/tonne" },
  "heavy-fuel-oil-3-5pct": { product: "Heavy fuel oil 3.5%S", unit: "EUR/tonne" },
});
const SUFFIX_SLUG: Record<string, string> = { euro95: "eurosuper-95", diesel: "automotive-diesel", heating_oil: "heating-gas-oil", fuel_oil_1: "residual-fuel-oil-1pct", fuel_oil_2: "heavy-fuel-oil-3-5pct", LPG: "lpg-motor-fuel" };
const DISPLAY_MATCHERS: Array<[string, (h: string) => boolean]> = [
  ["eurosuper-95", (h) => /euro[\s-]*super\s*95/i.test(h)],
  ["automotive-diesel", (h) => /(automotive gas oil|gas oil automobile|dieselkraftstoff)/i.test(h)],
  ["heating-gas-oil", (h) => /(heating gas oil|gas oil de chauffage|heiz(?:öl|ol)\s*\(ii\))/i.test(h)],
  ["lpg-motor-fuel", (h) => /(lpg motor fuel|gpl pour moteur)/i.test(h)],
  ["heavy-fuel-oil-3-5pct", (h) => /fuel oil/i.test(h) && />\s*1\s*%/.test(h)],
  ["residual-fuel-oil-1pct", (h) => /fuel oil/i.test(h) && !/>\s*1\s*%/.test(h)],
];
const colNum = (c: string): number => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

export interface BulletinWeek {
  week_ending: string;
  prices: Record<string, number>;
  /** The price cell text as the sheet shows it, by product: the value a capture quotes. */
  shown: Record<string, string>;
  warnings: string[];
}
/** The first link containing "Prices_History" on the bulletin page, made absolute; null when none. */
function findPricesHistoryLink(html: string): string | null {
  for (const m of html.matchAll(/href\s*=\s*(?:"([^"]+)"|'([^']+)')/g)) {
    const href = (m[1] ?? m[2]) as string;
    if (/Prices_History/i.test(href)) return /^https?:\/\//i.test(href) ? href : href.startsWith("/") ? ORIGIN + href : `${ORIGIN}/${href}`;
  }
  return null;
}

/** Resolve the date column and the pre-tax EU columns from header rows 1-3; row 1 (machine id) and row 2 (display text) must agree on the product. */
function resolveHeaderBlocks(byRow: Map<number, SheetRow>, shared: readonly string[]) {
  const text = (n: number) => new Map([...(byRow.get(n)?.cells ?? new Map())].map(([c, cell]) => [c, cellText(cell, shared).trim()] as const).filter(([, t]) => t));
  const [r1, r2, r3] = [text(1), text(2), text(3)];
  const cols = [...new Set([...r1.keys(), ...r2.keys(), ...r3.keys()])].sort((a, b) => colNum(a) - colNum(b));
  const dateCol = cols.find((c) => /\bdate\b/i.test([r1.get(c), r2.get(c), r3.get(c)].filter(Boolean).join(" ")));
  if (!dateCol) throw new StructureError('header rows 1-3 contain no column whose text matches "Date": cannot identify the date column');
  const eu = cols.filter((c) => c !== dateCol && r1.get(c)).flatMap((c) => {
    const m = /^EU_price_wo_tax_(.+)$/.exec(r1.get(c) as string);
    return m ? [{ col: c, id: r1.get(c) as string, suffix: m[1] as string }] : [];
  });
  if (!eu.length) throw new StructureError(`no column's row-1 header matched EU_price_wo_tax_* among ${cols.length} observed column(s)`);
  const warnings: string[] = [];
  const columns = eu.map((c) => {
    const slug = SUFFIX_SLUG[c.suffix] ?? null;
    if (!slug) {
      warnings.push(`EU column ${c.col} ("${c.id}") has an unrecognised suffix "${c.suffix}": left unmapped`);
      return { col: c.col, slug };
    }
    const shown = r2.get(c.col);
    const displaySlug = shown ? (DISPLAY_MATCHERS.find(([, t]) => t(shown))?.[0] ?? null) : null;
    if (displaySlug && displaySlug !== slug) throw new StructureError(`EU column ${c.col}: row-1 machine id "${c.id}" maps to "${slug}", but row-2 display text "${shown}" maps to "${displaySlug}": two independent keys disagree, refusing to guess`);
    if (!displaySlug) warnings.push(`EU column ${c.col} ("${c.id}") has no matching row-2 display text to cross-check: keeping the machine-id mapping to "${slug}"`);
    return { col: c.col, slug };
  });
  return { dateCol, columns, warnings };
}

/** An Excel serial (1900 system) or an ISO-ish string to YYYY-MM-DD; null when it is neither (a footer or legend row). */
function weekOf(raw: string | null, type: string): string | null {
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if ((type === "n" || type === "") && Number.isFinite(n)) {
    const iso = new Date((n - 25569) * 86_400_000).toISOString().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
  }
  return /^(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1] ?? null;
}

/** Every dated data row below the headers, newest first, with the prices that are usable numbers; a missing price is omitted with a warning, never zero-filled. */
function extractEuSeries(rows: SheetRow[], shared: readonly string[], header: ReturnType<typeof resolveHeaderBlocks>): BulletinWeek[] {
  const out: BulletinWeek[] = [];
  for (const row of rows) {
    if (row.rowNum <= 3) continue;
    const dateCell = row.cells.get(header.dateCol);
    const week = dateCell ? weekOf(dateCell.type === "s" ? cellText(dateCell, shared) : dateCell.raw, dateCell.type) : null;
    if (!week) continue;
    const prices: Record<string, number> = {};
    const shown: Record<string, string> = {};
    const warnings: string[] = [];
    for (const c of header.columns) {
      if (!c.slug) continue;
      const cell = row.cells.get(c.col);
      const raw = cell ? cellText(cell, shared) : "";
      const n = raw === "" ? NaN : Number(raw);
      if (Number.isFinite(n) && n > 0) {
        prices[c.slug] = n;
        shown[c.slug] = raw;
      } else warnings.push(`week ${week}: EU column ${c.col} (${c.slug}) has no usable price ("${raw}"): omitted, not fabricated`);
    }
    out.push({ week_ending: week, prices, shown, warnings });
  }
  return out.sort((a, b) => (a.week_ending < b.week_ending ? 1 : a.week_ending > b.week_ending ? -1 : 0));
}

/** The normalised `week_ending;product;price_eur[;n_member_states]` CSV to rows; a bad date, an unknown product and a bad price are each skipped by name. */
function parseEuWeeklyOilBulletinCsv(csv: string): { rows: Rec[]; warnings: string[]; sentences: Map<string, string> } {
  const lines = String(csv ?? "").split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const sentences = new Map<string, string>();
  if (!lines.length) return { rows: [], warnings: ["empty input: no header, no data rows"], sentences };
  const header = (lines[0] as string).split(";").map((h) => h.trim());
  const [iW, iP, iPr, iN] = ["week_ending", "product", "price_eur", "n_member_states"].map((n) => header.indexOf(n)) as [number, number, number, number];
  if (iW < 0 || iP < 0 || iPr < 0) return { rows: [], warnings: [`header missing required column(s): need week_ending, product, price_eur (n_member_states optional); got: ${header.join(", ")}`], sentences };
  const rows: Rec[] = [];
  const warnings: string[] = [];
  lines.slice(1).forEach((line, k) => {
    const cells = line.split(";").map((c) => c.trim());
    const [week, product, price] = [cells[iW] as string, cells[iP] as string, Number(cells[iPr])];
    const def = PRODUCTS[product];
    const at = `line ${k + 2}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return void warnings.push(`${at}: bad week_ending "${week}" (expected YYYY-MM-DD): row skipped`);
    if (!def) return void warnings.push(`${at}: unrecognised product "${product}": row skipped (not a fabricated unit)`);
    if (!Number.isFinite(price) || price <= 0) return void warnings.push(`${at}: bad price_eur "${cells[iPr]}" for ${product}: row skipped`);
    const nRaw = iN >= 0 ? cells[iN] : undefined;
    const n = nRaw ? Number(nRaw) : null;
    if (nRaw && !(Number.isInteger(n) && (n as number) > 0)) warnings.push(`${at}: bad n_member_states "${nRaw}" for ${product}: n_observations left NULL`);
    sentences.set(seriesCaptureQuery(`eu-oil-bulletin:${product}`, week), `Weekly Oil Bulletin, week of ${week}. ${def.product}, ${SCOPE}: ${cells[iPr]} ${def.unit}.`);
    rows.push({ series_key: `eu-oil-bulletin:${product}`, label: `${def.product} (${SCOPE})`, value_numeric: price, unit: def.unit, currency: "EUR", derivation: "observed", origin_class: "official", source_key: "ec_weekly_oil_bulletin", source_ref: `Weekly Oil Bulletin, week of ${week}`, n_observations: n !== null && Number.isInteger(n) && n > 0 ? n : null, method_version: null, as_at_date: week, reference_period: week });
  });
  return { rows, warnings, sentences };
}

const toCsv = (weeks: BulletinWeek[]): string => ["week_ending;product;price_eur", ...weeks.flatMap((w) => Object.keys(w.prices).map((slug) => `${w.week_ending};${slug};${w.shown[slug]}`))].join("\n");

export const euOilBulletin: ProducerSpec = {
  name: "eu-weekly-oil-bulletin",
  ...marketSeriesBase("eu-oil-bulletin"),
  licenceKey: "ec_weekly_oil_bulletin",
  enabled: true,
  enabledRuling: "operator 2026-10-23: population hold lifted for the structured-data producers (ADR-023 code change; rulings file 2026-10-23 and 2026-10-24)",
  killSwitchEnv: "MARKET_PRODUCER_EU_OIL_BULLETIN_ENABLED",
  async fetchDoc(ctx): Promise<Doc> {
    if (ctx.input.since && !/^\d{4}-\d{2}-\d{2}$/.test(ctx.input.since)) throw new StructureError(`since "${ctx.input.since}" is not a well-formed YYYY-MM-DD date`);
    let url = FALLBACK_XLSX;
    let linkError: string | null = null;
    try {
      url = findPricesHistoryLink(await (await ctx.get(PAGE_URL, { headers: { accept: "text/html" } })).text()) ?? FALLBACK_XLSX;
    } catch (e) {
      linkError = e instanceof Error ? e.message : String(e);
    }
    return { bytes: Buffer.from(await (await ctx.get(url)).arrayBuffer()), meta: { url, ...(linkError ? { linkFinderError: linkError } : {}) } };
  },
  parse(doc, ctx): ParseOut<Rec> {
    let csv = doc.text ?? "";
    const warnings: string[] = [];
    if (doc.bytes) {
      const { rows, shared } = readSheet(doc.bytes, PRICE_SHEET);
      const header = resolveHeaderBlocks(new Map(rows.map((r) => [r.rowNum, r])), shared);
      warnings.push(...header.warnings);
      // Without --since only the newest week is planned; with it, every week on or after the date.
      const all = extractEuSeries(rows, shared, header);
      const weeks = ctx.input.since ? all.filter((w) => w.week_ending >= (ctx.input.since as string)) : all.slice(0, 1);
      for (const w of weeks) warnings.push(...w.warnings);
      csv = toCsv(weeks);
    }
    const out = parseEuWeeklyOilBulletinCsv(csv);
    // Ruling 68: each row rendered to its one sentence by the declared transform is a capture of the bulletin file; a document injected without its URL is the bulletin's known file.
    const url = typeof doc.meta?.url === "string" ? doc.meta.url : FALLBACK_XLSX;
    ctx.state.seriesCaptures = new Map<string, SeriesCapture>([...out.sentences].map(([query, text]) => [query, { url, text, locale: "en" }]));
    return { rows: stampEntity(out.rows, ctx), warnings: [...warnings, ...out.warnings], counts: { captures_candidate: out.sentences.size } };
  },
};
