import units from "./data/units.json" with { type: "json" };
import { DOCUMENTS, licenceClass, type GoldenRow } from "./load.ts";

const RED_TOKEN = /^[\d.,\- %/*]+[A-Za-z/]{0,6}$/;
const escape = (a: string): string => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ATOM = [...units.atoms].sort((a, b) => b.length - a.length).map(escape).join("|");
const UNIT = `(?:${ATOM})(?:[/ -](?:${ATOM}))*`;
const MEASURE = new RegExp(`^(?:-?\\d[\\d.,]*\\d|-?\\d)(?: ?${UNIT})?$|^${UNIT}$`);
/** A probe against a licence-red document: a figure, a figure with its unit, or a unit expression from data/units.json. Never a formula, a phrase, a caption or a word of the publisher's sentence. */
export const isRedProbe = (token: string): boolean => RED_TOKEN.test(token) || MEASURE.test(token);
const WORD = /[a-z0-9]+/g;

/** Every string in a row, with where it sits, so a prose check cannot miss a field. */
function stringsOf(value: unknown, path = ""): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringsOf(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => stringsOf(v, `${path}.${k}`));
  return [];
}

const isRed = (doc: string): boolean => licenceClass(doc) === "prohibited";

/** Static structure of the licence-red rows: probes against a red document are a figure or a figure with its unit, never a phrase, and no string carries a quotation mark. */
export function structureProblems(rows: readonly GoldenRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const [path, s] of stringsOf(row)) if (/["“”]/.test(s)) out.push(`${row.id}${path}: a quotation mark (a row paraphrases and never quotes)`);
    for (const c of row.checks) if (isRed(c.doc)) for (const t of c.tokens) if (!isRedProbe(t)) out.push(`${row.id}: probe "${t}" against a licence-red document is not a figure or a figure with its unit`);
    for (const d of row.disagreements) for (const s of d.sides) if (isRed(s.doc)) for (const t of s.tokens) if (!isRedProbe(t)) out.push(`${row.id}: probe "${t}" against a licence-red document is not a figure or a figure with its unit`);
  }
  return out;
}

/** A window is prose when most of its words are alphabetic; a run of table figures is data, and the figures are the only thing a row may carry. */
const prose = (w: string[]): boolean => w.filter((x) => /^[a-z]{2,}$/.test(x)).length * 8 >= w.length * 5;

/** Eight-word prose windows of a text, lower-cased, punctuation dropped. */
function windows(text: string, n = 8): Set<string> {
  const w = text.toLowerCase().match(WORD) ?? [];
  const set = new Set<string>();
  for (let i = 0; i + n <= w.length; i += 1) if (prose(w.slice(i, i + n))) set.add(w.slice(i, i + n).join(" "));
  return set;
}

/** Strings of any row that share an eight-word run with the red document's text: zero is the cap (INV-R6a-2). */
export function proseOverlap(rows: readonly GoldenRow[], redText: string, n = 8): string[] {
  const doc = windows(redText, n);
  const hits: string[] = [];
  for (const row of rows) {
    for (const [path, s] of stringsOf(row)) {
      const w = s.toLowerCase().match(WORD) ?? [];
      for (let i = 0; i + n <= w.length; i += 1) if (doc.has(w.slice(i, i + n).join(" "))) { hits.push(`${row.id}${path}`); break; }
    }
  }
  return hits;
}

export const redDocs = (): string[] => Object.keys(DOCUMENTS).filter(isRed);
