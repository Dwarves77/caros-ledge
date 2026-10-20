// New in the clean-room tree (UI-1 U7, customer strings I16): every facet label on every list is sentence case, from one table. The values stay as stored (a filter compares the stored value); only the words the reader sees are made here.
import { z } from "zod";

import raw from "./facet-labels.json";

const TABLE = z
  .object({ acronyms: z.array(z.string().regex(/^[A-Z0-9]+$/)), labels: z.record(z.string(), z.record(z.string(), z.string())) })
  .parse(raw);
const ACRONYMS = new Set(TABLE.acronyms);

export type FacetLabelGroup = "mode" | "topic" | "region";

const keyOf = (stored: string): string => stored.trim().replace(/_/g, " ").replace(/\s+/g, " ").toLowerCase();
const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "INLAND WATERWAY", "inland_waterway" and "Inland Waterway" all read "Inland waterway"; an acronym from the table keeps its capitals. */
function sentenceCase(stored: string): string {
  const words = keyOf(stored).split(" ");
  return words.map((w, i) => (ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : i === 0 ? upperFirst(w) : w)).join(" ");
}

/** The label of a stored facet value: the table's entry, else a region name as stored (a proper name keeps its capitals) unless it is shouted, else sentence case. */
export function facetLabel(group: FacetLabelGroup, stored: string): string {
  const entry = TABLE.labels[group]?.[keyOf(stored)];
  if (entry) return entry;
  const trimmed = stored.trim();
  if (group === "region" && trimmed !== trimmed.toUpperCase()) return upperFirst(trimmed);
  if (group === "region" && trimmed.length <= 3) return trimmed;
  return sentenceCase(trimmed);
}
