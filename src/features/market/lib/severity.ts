// New in R2d: the ONE severity vocabulary (register surfaces:19). intelligence_items.severity admits thirteen values (Market's five kinds, the priority words, the catch-all four); each has one customer word, in
// data/severity.json, and every surface that draws the column reads it here. A value the table does not hold draws nothing, and no surface maps one value to another's word (HIGH was "Cost alert" on Research).
import { z } from "zod";

import raw from "./data/severity.json";

const SEVERITY_LABEL: Readonly<Record<string, string>> = Object.freeze(z.record(z.string(), z.string().min(1)).parse(raw));


/** The customer word of a stored severity, or null (an unclassified item has no kind). */
export const severityLabel = (stored: string | null | undefined): string | null => (typeof stored === "string" ? (Object.hasOwn(SEVERITY_LABEL, stored) ? (SEVERITY_LABEL[stored] as string) : null) : null);
