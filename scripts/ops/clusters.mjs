// Reads the clusters of the live graph (PATTERN-SYNTHESIS-1), read-only: it writes nothing to the database. Prints the counts of the clusters by surface count, by angle and by axis, the truncation, and with --sample N the first N clusters with their rows.
//   node --env-file=<env file> scripts/ops/clusters.mjs [--limit N] [--min-surfaces N] [--max-rows N] [--sample N] [--plan-refs]
// --plan-refs reads the refs the mining would write (a dry plan, never written) as if they were held, so the clusters shown are those of the graph after the next propagate stage. Exit 0 when the read completed, 1 on a usage error or a failed read.
import { register } from "node:module";
import { parseArgs } from "node:util";

register("./../lib/ts-hooks.mjs", import.meta.url, { data: {} });

const { values } = parseArgs({ options: { limit: { type: "string", default: "100000" }, "min-surfaces": { type: "string", default: "2" }, "max-rows": { type: "string", default: "40" }, sample: { type: "string", default: "0" }, "plan-refs": { type: "boolean", default: false } } });
const { serviceClient } = await import("../../src/core/db/clients.ts");
const { planRefs } = await import("../../src/core/coupling/index.ts");
const { loadPatternInput } = await import("../../src/core/flywheel/patterns/load.ts");
const { assembleClusters } = await import("../../src/core/flywheel/clusters.ts");

const sb = serviceClient();
const now = new Date();
const planned = values["plan-refs"] ? await planRefs(sb) : null;
const extraRefs = planned ? planned.plan.filter((r) => !planned.heldKeys.has(`${r.ref_table}|${r.ref_id}|${r.entity_id}|${r.role}`)) : [];
const { input } = await loadPatternInput(sb, now, { extraRefs });
const { clusters, truncated } = await assembleClusters(sb, { limit: Number(values.limit), minSurfaces: Number(values["min-surfaces"]), maxRows: Number(values["max-rows"]), now, input });
const tally = (keys) => clusters.flatMap(keys).reduce((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});
console.log(JSON.stringify({ clusters: clusters.length, truncated, by_surfaces: tally((c) => [String(c.surfaces.length)]), by_angle: tally((c) => (c.angles.length ? c.angles : ["none"])), by_axis: tally((c) => c.axes), by_hops: tally((c) => [String(c.hops)]), planned_refs: extraRefs.length }));
for (const c of clusters.slice(0, Number(values.sample))) console.log(JSON.stringify(c));
