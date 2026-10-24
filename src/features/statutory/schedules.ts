// New in ARM-2 (no old counterpart; scripts/ci/new-files/arm-2.txt): the instruments' OWN published schedules as statutory_computations rows. rows.ts computes a FuelEU Annex IV penalty for one named ship from inputs no instrument
// states; the schedule of an instrument (the ETS maritime phase-in shares, the FuelEU intensity reduction steps and penalty basis, the ReFuelEU blend shares, the CBAM factors) is a transcription with provenance, one row per
// (instrument, formula_id, scenario_key). Every row cites an article of an instrument page and the quote must (1) contain the row's figure as the article writes it and (2) stand verbatim on a stored capture of that page
// (checkQuotes in the shared rows-file driver). A figure the page does not state is a stated absence in the report, never a row. It computes nothing: computeStatutory stays the regulations slice's.
import type { Db } from "@/core/db";
import { entityId, planInstrument } from "@/core/entities";
import { requireCitation, RowsFileError } from "@/core/producers/rows-file";
import type { Rec } from "@/core/producers/upsert-plan";
import { need, refuse, rowsFileSpec, type ParsedRow } from "@/features/market/producers/rows-file-producers";

const FORMULA_VERSION = "1.0.0";
const ASSERTED_BY = "producer:statutory-schedules";

/** The numbers a quote states, as numbers: "14,5" is 14.5, "91,16" is 91.16 and "2 400" is 2400 (the Official Journal groups thousands with a space and writes decimals with a comma). */
function figuresIn(quote: string): number[] {
  const numbers = (re: RegExp) => [...quote.matchAll(re)].map((m) => Number(m[0].replaceAll(" ", "").replace(",", ".")));
  return [...numbers(/\d{1,3}(?: \d{3})+(?:,\d+)?/g), ...numbers(/\d+(?:[.,]\d+)?/g)];
}

function parseScheduleRow(row: Rec, i: number): ParsedRow {
  const where = "statutory-schedule-producer";
  const citation = requireCitation(row, i, where);
  need(row, ["instrument", "obligation", "formula_id", "scenario_key", "statute_citation", "result", "result_unit"], where, i);
  if (!/^[a-z][a-z0-9_]*$/.test(String(row.formula_id))) throw new RowsFileError(`${where}: row[${i}].formula_id "${row.formula_id}" must be lower-case words joined by underscores.`);
  const result = Number(row.result);
  if (!Number.isFinite(result)) throw new RowsFileError(`${where}: row[${i}].result "${row.result}" is not a number.`);
  if (!figuresIn(citation.quote).includes(result)) return refuse(`row[${i}] (${row.formula_id} ${row.scenario_key}): the quote does not contain the figure ${result}; a figure is transcribed in the instrument's own words, never paraphrased.`);
  return { refused: false, citation, dbRow: { entity_id: entityId("instrument", String(row.instrument)), scenario_key: String(row.scenario_key), obligation_id: entityId("obligation", String(row.obligation)), formula_id: row.formula_id, formula_version: FORMULA_VERSION, statute_citation: String(row.statute_citation), unit_price: null, unit_price_unit: null, result, result_unit: String(row.result_unit), __instrument: row.instrument, __obligation: row.obligation } };
}

/** The instrument and the obligation a schedule row names, authored by the existing instrument path (entity and CELEX identifier) and, for the obligation, the one entity row the statutory writer (rows.ts) also authors; found held on a second call. */
async function mint(sb: Db, instrument: string, obligation: string, now: Date): Promise<void> {
  const [iid, oid] = [entityId("instrument", instrument), entityId("obligation", obligation)];
  const [ents, idents] = await Promise.all([sb.from("entities").select("entity_id").in("entity_id", [iid, oid]), sb.from("entity_identifiers").select("entity_id, scheme, value").eq("entity_id", iid)]);
  for (const r of [ents, idents]) if (r.error) throw new Error(`reading the entities of ${instrument} failed: ${r.error.message}`);
  const have = new Set((ents.data ?? []).map((e) => e.entity_id));
  const plan = planInstrument([instrument], { existingEntityIds: have, existingIdentifierKeys: new Set((idents.data ?? []).map((x) => `${x.entity_id}|${x.scheme}|${x.value}`)), assertedBy: ASSERTED_BY, now });
  const entities = [...plan.entities, ...(have.has(oid) ? [] : [{ entity_id: oid, kind: "obligation", canonical_name: obligation, status: "active" }])];
  for (const [table, list] of [["entities", entities], ["entity_identifiers", plan.identifiers]] as const) {
    const { error } = list.length ? await sb.from(table).insert(list as never) : { error: null };
    if (error) throw new Error(`insert into ${table} failed: ${error.message}`);
  }
}

/** The row's provenance lives in `inputs` (the table has no source column): the registered source, the capture the quote was verified on and the filing-grade verdict, which is the rule of rows.ts (a quote accepted against a stored capture). */
export const statutorySchedules = rowsFileSpec({
  name: "statutory-schedules",
  table: "statutory_computations",
  entityKind: null,
  killSwitchEnv: "STATUTORY_PRODUCER_SCHEDULES_ENABLED",
  pk: "computation_id",
  keyFields: ["entity_id", "formula_id", "formula_version", "scenario_key"],
  storesSource: false,
  parseRow: parseScheduleRow,
  async settle(sb, row, proof, now) {
    const { __instrument, __obligation, ...rest } = row;
    await mint(sb, String(__instrument), String(__obligation), now);
    return { ...rest, inputs: [{ table: "sources", pk: proof.source_id, version: proof.citation.url, capture_id: proof.capture_id, quote: proof.citation.quote, retrieved_at: proof.citation.retrieved_at, admissibility: "filing_ok" }] };
  },
  gap: "no schedule rows file given this run; the input is a reviewed rows file of the instruments' own published schedules",
});
