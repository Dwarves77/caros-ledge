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

/** The instrument an EUR-Lex page is, from the CELEX in its URL: a consolidated text (0YYYYTNNNN-date) is of the instrument 3YYYYTNNNN. Null for a URL that names no CELEX. */
function citedInstrument(url: string): string | null {
  return /[?&]uri=CELEX:([\w()-]+)/i.exec(url)?.[1]?.replace(/^0(\d{4}[A-Z]\d{4}).*$/, "3$1") ?? null;
}

function parseScheduleRow(row: Rec, i: number): ParsedRow {
  const where = "statutory-schedule-producer";
  const citation = requireCitation(row, i, where);
  need(row, ["instrument", "article", "obligation", "formula_id", "scenario_key", "statute_citation", "result", "result_unit"], where, i);
  if (!/^[a-z][a-z0-9_]*$/.test(String(row.formula_id))) throw new RowsFileError(`${where}: row[${i}].formula_id "${row.formula_id}" must be lower-case words joined by underscores.`);
  const cited = citedInstrument(citation.url);
  if (cited && cited !== String(row.instrument)) return refuse(`row[${i}] (${row.formula_id} ${row.scenario_key}): keyed to instrument ${row.instrument} but its article is quoted from ${cited}; a schedule row belongs to the instrument whose article it cites.`);
  const result = Number(row.result);
  if (!Number.isFinite(result)) throw new RowsFileError(`${where}: row[${i}].result "${row.result}" is not a number.`);
  if (!figuresIn(citation.quote).includes(result)) return refuse(`row[${i}] (${row.formula_id} ${row.scenario_key}): the quote does not contain the figure ${result}; a figure is transcribed in the instrument's own words, never paraphrased.`);
  return { refused: false, citation, dbRow: { entity_id: entityId("instrument", String(row.instrument)), scenario_key: String(row.scenario_key), obligation_id: entityId("obligation", String(row.obligation)), formula_id: row.formula_id, formula_version: FORMULA_VERSION, statute_citation: String(row.statute_citation), unit_price: null, unit_price_unit: null, result, result_unit: String(row.result_unit), __instrument: row.instrument, __obligation: row.obligation, __article: String(row.article) } };
}

/** The obligation the instrument's own extraction already holds for the article a row cites (obligation_objects: the instrument entity and the pinpoint citation); the current version, not one a later version supersedes. Null when the instrument has none for that article. */
async function linkedObligation(sb: Db, instrumentId: string, article: string): Promise<string | null> {
  const { data, error } = await sb.from("obligation_objects").select("obligation_id, version, supersedes").eq("instrument_entity_id", instrumentId).eq("pinpoint_citation", article);
  if (error) throw new Error(`reading the obligation objects of ${instrumentId} failed: ${error.message}`);
  const held = (data ?? []) as Array<{ obligation_id: string; version: number; supersedes: string | null }>;
  const superseded = new Set(held.map((o) => o.supersedes));
  return held.filter((o) => !superseded.has(o.obligation_id)).sort((a, b) => b.version - a.version || a.obligation_id.localeCompare(b.obligation_id))[0]?.obligation_id ?? null;
}

/** The instrument a schedule row names, authored by the existing instrument path (entity and CELEX identifier), and, when the instrument holds no obligation for the article, the one obligation entity the statutory writer (rows.ts) also authors, named by its article; found held on a second call. */
async function mint(sb: Db, instrument: string, obligation: string | null, now: Date): Promise<void> {
  const [iid, oid] = [entityId("instrument", instrument), entityId("obligation", obligation ?? instrument)];
  const [ents, idents] = await Promise.all([sb.from("entities").select("entity_id").in("entity_id", [iid, oid]), sb.from("entity_identifiers").select("entity_id, scheme, value").eq("entity_id", iid)]);
  for (const r of [ents, idents]) if (r.error) throw new Error(`reading the entities of ${instrument} failed: ${r.error.message}`);
  const have = new Set((ents.data ?? []).map((e) => e.entity_id));
  const plan = planInstrument([instrument], { existingEntityIds: have, existingIdentifierKeys: new Set((idents.data ?? []).map((x) => `${x.entity_id}|${x.scheme}|${x.value}`)), assertedBy: ASSERTED_BY, now });
  const entities = [...plan.entities, ...(!obligation || have.has(oid) ? [] : [{ entity_id: oid, kind: "obligation", canonical_name: obligation, status: "active" }])];
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
    const { __instrument, __obligation, __article, ...rest } = row;
    const linked = await linkedObligation(sb, String(rest.entity_id), String(__article));
    await mint(sb, String(__instrument), linked ? null : String(__obligation), now);
    return { ...rest, ...(linked ? { obligation_id: linked } : {}), inputs: [{ table: "sources", pk: proof.source_id, version: proof.citation.url, capture_id: proof.capture_id, quote: proof.citation.quote, retrieved_at: proof.citation.retrieved_at, admissibility: "filing_ok", article: __article, linked_obligation_id: linked }] };
  },
  gap: "no schedule rows file given this run; the input is a reviewed rows file of the instruments' own published schedules",
});
