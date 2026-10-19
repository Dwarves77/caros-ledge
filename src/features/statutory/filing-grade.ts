// R2b I5 (register D:10, 69): which target years are FILING GRADE is derived, never typed. A year is filing grade for an instrument only when every quote that year's limit rests on is accepted by acceptQuote against the
// instrument's STORED capture (named by id, text exported to data/captures/<id>.txt) with a verified_at that parses. data/filing-grade.json is the output of deriveFilingGrade over data/filing-grade-inputs.json and
// those exports; tests/statutory/filing-grade.test.ts regenerates it and fails when the committed file differs (the drift guard), so a hand-typed year, or a capture that no longer holds its quote, turns CI red. An
// instrument with no stored capture yet derives no year: the filing gate refuses until the capture exists, which is the honest state. Adding an instrument is a data row plus its quotes, not a code change.
import { z } from "zod";

import { acceptQuote, type QuoteVerdict } from "@/core/producers/quote";

import constants from "./data/fueleu-annex-i-iv-constants.json";
import inputsJson from "./data/filing-grade-inputs.json";

export const FUELEU_INSTRUMENT = "fueleu-maritime-annex-iv";

export interface FilingInstrument {
  id: string;
  /** The stored capture (agent_run_searches id) of the instrument's text, or null when none is stored yet. */
  captureId: string | null;
  verifiedAt: string | null;
  /** Target year to every quote that year's limit rests on. */
  yearQuotes: Readonly<Record<string, readonly string[]>>;
}
export interface FilingGrade { years: number[]; refusals: { year: number; reason: string; detail: string }[] }
export type FilingGradeDoc = { instruments: Record<string, FilingGrade> };

/** One instrument's years: a year is filing grade iff every one of its quotes is accepted; the refusals say why each other year is not. */
export function deriveInstrument(i: FilingInstrument, captureText: string | null | undefined, now: Date): FilingGrade {
  const years: number[] = [];
  const refusals: FilingGrade["refusals"] = [];
  for (const [year, quotes] of Object.entries(i.yearQuotes).sort(([a], [b]) => Number(a) - Number(b))) {
    const verdicts: QuoteVerdict[] = quotes.map((quote) => acceptQuote({ quote, verifiedAt: i.verifiedAt, captureId: i.captureId, captureText, now }));
    const bad = verdicts.find((v) => !v.ok);
    if (!bad && verdicts.length) years.push(Number(year));
    else refusals.push({ year: Number(year), reason: bad && !bad.ok ? bad.reason : "no_quote", detail: bad && !bad.ok ? bad.detail : "the year lists no quote" });
  }
  return { years, refusals };
}
/** The whole document, from the instruments and the exported capture texts (`captures`: capture id to text). */
export function deriveFilingGrade(instruments: readonly FilingInstrument[], captures: ReadonlyMap<string, string>, now: Date): FilingGradeDoc {
  return { instruments: Object.fromEntries(instruments.map((i) => [i.id, deriveInstrument(i, i.captureId ? captures.get(i.captureId) : null, now)])) };
}

const evidence = z.object({ instruments: z.array(z.object({ id: z.string(), capture_id: z.string().nullable(), verified_at: z.string().nullable() })) }).parse(inputsJson);
const fueleu = z.object({
  reference_value: z.object({ source: z.object({ quote: z.string() }).loose() }).loose(),
  ghg_intensity_limit_by_period: z.object({ periods: z.array(z.object({ from_date: z.string(), quote: z.string() })) }),
}).loose().parse(constants);
/** FuelEU Annex IV (Regulation (EU) 2023/1805 Article 4(2)): a year's limit rests on the reference value's quote and the period's own quote. */
const FUELEU_YEAR_QUOTES: FilingInstrument["yearQuotes"] = Object.fromEntries(fueleu.ghg_intensity_limit_by_period.periods.map((p) => [p.from_date.slice(0, 4), [fueleu.reference_value.source.quote, p.quote]]));

/** The instruments the derivation covers: each evidence row of data/filing-grade-inputs.json with its quotes. A row naming an instrument that has no quotes defined here is a defect the drift test reports. */
export function filingInstruments(): FilingInstrument[] {
  return evidence.instruments.map((e) => ({ id: e.id, captureId: e.capture_id, verifiedAt: e.verified_at, yearQuotes: e.id === FUELEU_INSTRUMENT ? FUELEU_YEAR_QUOTES : {} }));
}
