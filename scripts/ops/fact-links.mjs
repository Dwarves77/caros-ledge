// Reads the structured figures joined to items, and the items joined to structured figures, through the entity graph (ENGINE-JOIN-1 addendum A), read-only: it writes nothing to the database.
//   node --env-file=<env file> scripts/ops/fact-links.mjs --item <uuid>... | --series <market_series uuid>... [--table <ref table>]
// --item prints, per item, the figures filed under its entities (hop 0) and one relation away (hop 1), a series with its latest value and its movement over the week and the month. --series (with --table, default market_series) prints, per row, the live items
// filed under its entity or one relation away, each with its next dated obligation and its penalty figure. Exit 0 when the read completed, 1 on a usage error or a failed read.
import { register } from "node:module";
import { parseArgs } from "node:util";

register("./../lib/ts-hooks.mjs", import.meta.url, { data: {} });

const { values } = parseArgs({ options: { item: { type: "string", multiple: true, default: [] }, series: { type: "string", multiple: true, default: [] }, table: { type: "string", default: "market_series" } } });
if (!values.item.length === !values.series.length) {
  console.error("fact-links: pass --item <uuid>... or --series <uuid>... (exactly one)");
  process.exit(1);
}
const { serviceClient } = await import("../../src/core/db/clients.ts");
const { readEntityFacts, readFactItems } = await import("../../src/core/flywheel/facts-join.ts");

const sb = serviceClient();
const joined = values.item.length ? await readEntityFacts(sb, values.item) : await readFactItems(sb, values.table, values.series, new Date());
for (const [id, links] of joined) console.log(JSON.stringify({ id, links }));
