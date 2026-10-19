// Ported from old_repo/src/lib/entities/unlocode-names.mjs (lines 10-86)
// Place names for the UN/LOCODEs in use, the corridor labels built from them, and country names for ISO 3166-1 codes. The names are data (data/unlocode-names.json) and every entry names the data source it came from: ports from
// GeoNames (CC BY 4.0, the credit travels with attributionsFor), countries from Wikidata (CC0). Nothing is served from a source the licence register does not allow: unlocodeName and nameForJurisdiction ask licenceGate for the
// entry's source key on every call and return null when it refuses (INV-R2e-5), so a table pointed at the prohibited `un_locode` serves no name at all. A code with no name is the caller's raw code, never a guess.
import { z } from "zod";

import { licenceGate } from "@/core/contracts/source-licence";

import raw from "./data/unlocode-names.json";

const port = z.object({ place: z.string().min(1), countryIso: z.string().regex(/^[A-Z]{2}$/), geonameId: z.number().int().positive(), source: z.string().min(1), aliasBasis: z.enum(["geonames-unlc", "caros-ledge-seed"]) });
const country = z.object({ name: z.string().min(1), source: z.string().min(1) });
const provenance = z.object({ source: z.string().min(1), url: z.string().url(), retrievedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), terms: z.string().url(), note: z.string() });
const file = z.object({ provenance: z.record(z.string(), provenance), ports: z.record(z.string().regex(/^[A-Z]{2}[A-Z2-9]{3}$/), port), countries: z.record(z.string().regex(/^[A-Z]{2}$/), country) });

interface Ends {
  origin?: unknown;
  dest?: unknown;
  mode?: unknown;
}
const key = (v: unknown): string => String(v ?? "").trim().toUpperCase();

/** The name functions over one table and one gate. The module's own are built over the committed table and the licence register; a test builds them over a planted table to prove the gate refuses. */
export function nameTable(data: unknown, gate: (sourceKey: string) => { ok: boolean } = licenceGate) {
  const t = file.parse(data);
  const served = <T extends { source: string }>(e: T | undefined): T | null => (e && gate(e.source).ok ? e : null);
  const portOf = (code: unknown) => served(t.ports[key(code)]);
  const place = (code: unknown, withIso: boolean): string => {
    const e = portOf(code);
    return e ? (withIso ? `${e.place} (${e.countryIso})` : e.place) : String(code ?? "");
  };
  return {
    unlocodeName: (code: unknown): string | null => portOf(code)?.place ?? null,
    nameForJurisdiction: (iso: unknown): string | null => served(t.countries[key(iso)])?.name ?? null,
    /** "Shanghai (CN) → Rotterdam (NL), ocean" */
    formatCorridorLabel: ({ origin, dest, mode }: Ends): string => `${place(origin, true)} → ${place(dest, true)}${String(mode ?? "").trim() ? `, ${String(mode).trim()}` : ""}`,
    /** "Shanghai – Rotterdam · ocean" */
    formatCorridorLabelCompact: ({ origin, dest, mode }: Ends): string => `${place(origin, false)} – ${place(dest, false)}${String(mode ?? "").trim() ? ` · ${String(mode).trim()}` : ""}`,
    /** The data sources the table's entries name, for the credit lines a surface prints beside a name (the register's `attribution`, through attributionsFor). */
    sources: (): string[] => [...new Set([...Object.values(t.ports).map((e) => e.source), ...Object.values(t.countries).map((e) => e.source)])].sort(),
    portCodes: (): string[] => Object.keys(t.ports),
    countryCodes: (): string[] => Object.keys(t.countries),
  };
}

export const { unlocodeName, nameForJurisdiction, formatCorridorLabel, formatCorridorLabelCompact, sources: nameSources, portCodes: namedPortCodes, countryCodes: namedCountryCodes } = nameTable(raw);
