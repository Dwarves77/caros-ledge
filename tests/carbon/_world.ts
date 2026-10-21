// The database the carbon tests read: the integration fixture (the real wiring, the real stages) plus two corridors, the modal-default factor of their mode, the allowance observation and the payload default, each a row of the table the turn reads.
// The numbers are fixture numbers: nothing in src holds them, and no production row is claimed to.
import { runTurn } from "@/core/turn";

import { fixture, NOW, type Fixture } from "../integration/world.ts";
import type { Row } from "../_support/memdb.ts";

export { NOW };
export const SHANGHAI_ROTTERDAM = "cl:corridor:0000000000000001";
/** Barcelona has no position in the port table (no Wikidata item is linked to its GeoNames id). */
export const BARCELONA_ROTTERDAM = "cl:corridor:0000000000000002";

export const entity = (id: string, name: string): Row => ({ entity_id: id, kind: "corridor", canonical_name: name, display_name: null, status: "active" });
export const series = (id: string, key: string, value: number, period: string, over: Row = {}): Row => ({ id, series_key: key, label: key, value_numeric: value, unit: "EUR/tCO2e", currency: "EUR", derivation: "observed", origin_class: "official", source_key: "ec_climate", source_ref: "fixture", n_observations: null, method_version: null, as_at_date: period, reference_period: period, ...over });
export const EUA = (value = 70, period = "2026-10-14", over: Row = {}): Row => series("e0000000-0000-4000-8000-000000000001", "eex-eua:primary-auction", value, period, over);
export const PAYLOAD = (value = 14, over: Row = {}): Row => series("e0000000-0000-4000-8000-000000000002", "feu-payload:default", value, "2026-09-01", { unit: "t/FEU", currency: null, ...over });
export const FACTOR: Row = { factor_id: "f0000000-0000-4000-8000-000000000001", mode: "ocean", vehicle_class: "container_ship", jurisdiction: "GLOBAL", quantity_basis: "tonne_km", ttw_co2e: 0.016, wtt_co2e: null, wtw_co2e: null, source_key: "ec_climate", tier: "modal_default", derivation: "calculated", origin_class: "official", method_version: "v1", n_observations: null, as_at_date: "2026-01-01", pedigree: 2, superseded_by: null };

/** The fixture turn's database with the carbon inputs a production database would hold once they are captured. `seed` replaces what the test wants different. */
export function carbonFixture(seed: { series?: Row[]; factors?: Row[]; corridors?: Row[] } = {}): Fixture {
  const f = fixture();
  f.db.seed("entities", seed.corridors ?? [entity(SHANGHAI_ROTTERDAM, "CNSHA-NLRTM:ocean"), entity(BARCELONA_ROTTERDAM, "ESBCN-NLRTM:ocean")]);
  f.db.seed("data_sources", [
    { source_key: "ec_climate", name: "European Commission, DG Climate Action", url: "https://climate.ec.europa.eu/eu-action/eu-emissions-trading-system-eu-ets_en" },
    { source_key: "eex", name: "European Energy Exchange", url: "https://www.eex.com/en/market-data/environmental-markets/auction-market" },
  ]);
  f.db.seed("emission_factors", seed.factors ?? [FACTOR]);
  f.db.seed("market_series", seed.series ?? [EUA(), PAYLOAD()]);
  return f;
}

/** One propagate stage, applied. */
export const propagate = (f: Fixture, now: Date = NOW) => runTurn({ stage: "propagate", mode: "apply", input: {} }, { d: f.d, env: {}, now: () => now });
export const state = (f: Fixture, scope: string, input: string): Row | undefined => f.db.rows("carbon_inputs").find((r) => r.scope === scope && r.input === input);
export const value = (f: Fixture, id: unknown): Row => f.db.rows("derived_values").find((v) => v.value_id === id) as Row;
/** Take the rows out of a table the way a delete would (the rows array is the table). */
export const removeRows = (f: Fixture, table: string, drop: (r: Row) => boolean): void => {
  const rows = f.db.rows(table);
  for (let i = rows.length - 1; i >= 0; i -= 1) if (drop(rows[i] as Row)) rows.splice(i, 1);
};
