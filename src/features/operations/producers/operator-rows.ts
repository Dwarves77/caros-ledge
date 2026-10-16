// Ported from old_repo/scripts/spec09/auxiliary-energy-producer.mjs (lines 9-66)
// Ported from old_repo/scripts/spec09/indexation-producer.mjs (lines 10-79)
// ONE operator-rows producer for the two kept tables (auxiliary_energy_profiles, indexation_clauses): an operator-supplied external-source CSV parsed through the shared
// contract, org-stamped by the caller (org_id is never read from the CSV), entity references now VALIDATED (the check the old producers never called), identical rows not re-inserted.
import { fetchAllRows, type Db } from "@/core/db";
import tables from "@/core/producers/data/operator-tables.json";
import { entityRefValuesForTable, parseOperatorRows, validateEntityRefs } from "@/core/producers/rows-file";
import type { ParseOut, ProducerCtx, ProducerSpec } from "@/core/producers/runner";
import type { Rec } from "@/core/producers/upsert-plan";

const GAP = "no operator rows file given this run; the table has no rows until an operator dispatches an external-source rows file";
const COLUMNS = tables as Record<string, { columns: Array<{ name: string }> }>;
/** The identity of an operator row: the org plus every contract column (numbers compared as numbers), so a re-run of the same file inserts nothing. */
const rowKey = (table: string) => (r: Rec): string => JSON.stringify([r.org_id, ...(COLUMNS[table]?.columns ?? []).map((c) => (r[c.name] == null ? null : typeof r[c.name] === "string" && r[c.name] !== "" && !Number.isNaN(Number(r[c.name])) ? Number(r[c.name]) : r[c.name]))]);

function operatorRowsSpec(table: "auxiliary_energy_profiles" | "indexation_clauses", pk: string, killSwitchEnv: string): ProducerSpec {
  return {
    name: `operator-rows-${table}`,
    table,
    licenceKey: null,
    enabled: false,
    enabledRuling: "operator 2026-10-04: no data population before every build layer is complete",
    killSwitchEnv,
    gap: GAP,
    async fetchDoc() {
      return { text: "" };
    },
    parse(doc, ctx: ProducerCtx): ParseOut<Rec> {
      if (!ctx.input.orgId) throw new Error("input.orgId is required whenever a CSV is given (org_id is never read from the CSV itself)");
      const parsed = parseOperatorRows(table, doc.text ?? "");
      if (!parsed.ok) throw new Error(parsed.error);
      const warnings = parsed.rejected.map((r) => `[rejected] row ${r.rowNumber}: ${r.errors.join("; ")}`);
      return { rows: parsed.accepted.map((a) => ({ ...a.data, org_id: ctx.input.orgId, __row: a.rowNumber })), warnings, counts: { rejected: parsed.rejected.length } };
    },
    /** Apply only: every entity reference must be a known entity; a row that names an unknown one is refused with its row number. */
    async resolve(ctx, rows) {
      const sb = ctx.sb as Db;
      const accepted = rows.map((r) => ({ rowNumber: r.__row as number, data: r }));
      const wanted = [...entityRefValuesForTable(table, accepted)];
      const known = new Set<string>();
      if (wanted.length) {
        const { data, error } = await sb.from("entities").select("entity_id").in("entity_id", wanted);
        if (error) throw new Error(`reading entities failed: ${error.message}`);
        for (const e of (data ?? []) as Array<{ entity_id: string }>) known.add(e.entity_id);
      }
      const { valid, invalid } = validateEntityRefs(table, accepted, known);
      return { rows: valid.map((v) => Object.fromEntries(Object.entries(v.data).filter(([k]) => k !== "__row"))), refused: invalid.map((i) => `row ${i.rowNumber}: ${i.errors.join("; ")}`) };
    },
    plan: {
      read: (sb) => fetchAllRows<Rec>((from, to) => sb.from(table).select("*").order(pk, { ascending: true }).range(from, to) as never, { cap: 100_000 }),
      key: rowKey(table),
      patchable: [],
      pk,
    },
  };
}
export const auxiliaryEnergyRows = operatorRowsSpec("auxiliary_energy_profiles", "profile_id", "OPERATIONS_PRODUCER_AUX_ENERGY_ROWS_ENABLED");
export const indexationRows = operatorRowsSpec("indexation_clauses", "clause_id", "MARKET_PRODUCER_INDEXATION_ROWS_ENABLED");
