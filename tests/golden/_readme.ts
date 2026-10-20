import { DOCUMENTS, licenceClass, type GoldenRow } from "./load.ts";

const count = <T>(items: T[], key: (t: T) => string): Array<[string, number]> => {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return [...m].sort(([a], [b]) => a.localeCompare(b));
};
const table = (head: string, rows: Array<[string, number]>): string => [`| ${head} | rows |`, "|---|---|", ...rows.map(([k, n]) => `| ${k} | ${n} |`)].join("\n");
const ORDER = ["prohibited", "conditional", "terms_unverified", "permitted"];

/** A row's licence class is the worst class over every document it cites. */
function rowLicence(row: GoldenRow): string {
  const docs = [...row.checks.map((c) => c.doc), ...row.disagreements.flatMap((d) => d.sides.map((s) => s.doc))];
  return docs.map(licenceClass).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0] ?? "terms_unverified";
}

/** The data folder's README, generated from the rows: counts only, never a figure or a sentence of any source. */
export function renderReadme(rows: readonly GoldenRow[]): string {
  const all = [...rows];
  const verified = all.filter((r) => r.status === "verified").length;
  const unverifiedDocs = Object.entries(DOCUMENTS).filter(([k]) => licenceClass(k) === "terms_unverified").map(([k, d]) => `- ${k}: ${d.title} (${d.publisher})`);
  return [
    "# Golden corpus truth set (R6a)",
    "",
    "Generated from the rows by tests/golden/rows.test.ts (the drift guard); regenerate with `GOLDEN_WRITE_README=1 npm test`. Do not edit by hand.",
    "",
    "Each row carries inputs, expected outputs, locators and traps, never a source's prose. A value is `verified` (read at its locator on the retrieval date and re-checked by the tests) or the row is `unresolved`. GLEC and ISO text is licence-red: rows hold figures, units and locators only. GLEC rows are v3.0 pending v3.2.",
    "",
    "Conventions: `dp` locale is decimal point with comma thousands, `dc` is decimal comma with space or dot thousands; `sigDigits` counts the printed digits, trailing zeros of an integer without a decimal part not counted; a `rounded` figure is compared within half a unit of its last published digit, every other value exactly.",
    "",
    `Rows: ${all.length} (${verified} verified, ${all.length - verified} unresolved). Documents: ${Object.keys(DOCUMENTS).length}.`,
    "",
    table("framework", count(all, (r) => r.framework)),
    "",
    table("status", count(all, (r) => r.status)),
    "",
    table("kind", count(all, (r) => r.kind)),
    "",
    table("licence class (worst over cited documents)", count(all, rowLicence)),
    "",
    "Documents whose register verdict is `unverified`, or that have no register entry (`terms_unverified`):",
    "",
    ...unverifiedDocs,
    "",
  ].join("\n");
}
