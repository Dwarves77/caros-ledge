// New in R2e (M6). The factory behind the place-name table: one zod parse of a table (ports from GeoNames, countries from Wikidata, each entry naming the data source it came from) and the functions that serve it. Every served name passes
// licenceGate on the entry's source key at call time (INV-R2e-5). The committed table is bound in unlocode-names.ts; a test builds this over a planted table whose entries name the prohibited `un_locode` source and proves nothing is served.
import { z } from "zod";

import { licenceGate } from "@/core/contracts/source-licence";

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

/** The name functions over one table. Every entry is served through licenceGate on its own source key at the moment of the call, so a table whose entry names a source the register forbids serves nothing. */
export function nameTable(data: unknown) {
  const t = file.parse(data);
  const served = <T extends { source: string }>(e: T | undefined): T | null => (e && licenceGate(e.source).ok ? e : null);
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
  };
}
