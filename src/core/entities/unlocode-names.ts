// Ported from old_repo/src/lib/entities/unlocode-names.mjs (lines 10-86)
// Place names for five confirmed UN/LOCODEs and the corridor labels built from them. The names are data (data/unlocode-names.json). Licence: the
// UN/LOCODE terms are recorded as redistribution "prohibited" in the source-licence table while five names are published on customer surfaces
// (B-0258): a ruling is owed and is listed in the report; the file stays exactly the five names the old tree published.
import { z } from "zod";

import raw from "./data/unlocode-names.json";

const table = z.object({ unlocode: z.record(z.string(), z.object({ place: z.string(), countryIso: z.string(), countryName: z.string() })) }).parse(raw);
export const UNLOCODE_NAMES: Readonly<Record<string, { place: string; countryIso: string; countryName: string }>> = table.unlocode;
export const JURISDICTION_NAMES: Readonly<Record<string, string>> = Object.fromEntries(Object.values(UNLOCODE_NAMES).map((e) => [e.countryIso, e.countryName]));

export const unlocodeName = (code: unknown): string | null => UNLOCODE_NAMES[String(code ?? "").trim().toUpperCase()]?.place ?? null;
export const nameForJurisdiction = (iso: unknown): string | null => JURISDICTION_NAMES[String(iso ?? "").trim().toUpperCase()] ?? null;

interface Ends {
  origin?: unknown;
  dest?: unknown;
  mode?: unknown;
}
const place = (code: unknown, withIso: boolean): string => {
  const e = UNLOCODE_NAMES[String(code ?? "").toUpperCase()];
  return e ? (withIso ? `${e.place} (${e.countryIso})` : e.place) : String(code ?? "");
};
/** "Shanghai (CN) → Rotterdam (NL), ocean" */
export function formatCorridorLabel({ origin, dest, mode }: Ends): string {
  const m = String(mode ?? "").trim();
  return `${place(origin, true)} → ${place(dest, true)}${m ? `, ${m}` : ""}`;
}
/** "Shanghai – Rotterdam · ocean" */
export function formatCorridorLabelCompact({ origin, dest, mode }: Ends): string {
  const m = String(mode ?? "").trim();
  return `${place(origin, false)} – ${place(dest, false)}${m ? ` · ${m}` : ""}`;
}
