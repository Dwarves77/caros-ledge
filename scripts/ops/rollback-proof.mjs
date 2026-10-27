// A rolled-back production proof of the engine (ENGINE-CORE-FIX-1): in ONE transaction, apply the emissions of item-briefs batch files through the real apply path (residue entries write their emission blocks, candidates are minted),
// mine the refs for real, run the pattern step for real, count what the graph now holds, and ROLLBACK. It never commits: the connection is closed after the rollback, and a failure also rolls back.
//   node --env-file=<env file> scripts/ops/rollback-proof.mjs [--migrate <file.sql>]... [--skip <item uuid>]... [--dry-apply] [--no-mine] [--clusters] [--synthesis-check] <batch.json>...
// --synthesis-check writes ONE connection through the shared write-back with an EMPTY item id (as a synthesis finding does) and reads the relation row back: its basis, method version and asserting record.
// --skip names accepted items that are not part of the proof; --dry-apply validates only; --no-mine skips the mining; --clusters also runs one admin-opportunity-findings export over assembleClusters (export only, no authoring).
// Prints the emission counts (entities minted and reused, the duplicate rate), the refs mined, the patterns per detector (current, with the loader's input counts, and the missing input for a detector at 0), and the cluster summary.
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { parseArgs } from "node:util";

import { connect, makeDb } from "./pg-rollback-db.mjs";

register("./../lib/ts-hooks.mjs", import.meta.url, { data: {} });

const { values, positionals } = parseArgs({ allowPositionals: true, options: { migrate: { type: "string", multiple: true, default: [] }, skip: { type: "string", multiple: true, default: [] }, "dry-apply": { type: "boolean" }, "no-mine": { type: "boolean" }, clusters: { type: "boolean" }, "synthesis-check": { type: "boolean" } } });
if (!process.env.DATABASE_URL) {
  console.error("rollback-proof: DATABASE_URL is not set");
  process.exit(2);
}
const { applyBatch, drainExporters } = await import("../../src/features/batches/index.ts");
const { locateSpan } = await import("../../src/core/contracts/verbatim.ts");
const { runPatterns } = await import("../../src/core/flywheel/patterns/run.ts");
const { mineRefs } = await import("../../src/core/coupling/index.ts");
const { writeWriteback } = await import("../../src/features/batches/kit/writeback.ts");

const client = await connect(process.env.DATABASE_URL);
const now = () => new Date();
const one = async (sql) => (await client.query(sql)).rows;
try {
  await client.query("begin");
  // --migrate: migrations the production database does not carry yet are applied INSIDE this transaction first (their own BEGIN and COMMIT lines removed), so the proof runs on the schema the PR will leave
  for (const m of values.migrate) {
    const text = readFileSync(m, "utf8").replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");
    client.on("notice", (n) => console.log("NOTICE:", n.message));
    await client.query(text);
    console.log("applied in the transaction:", m.split(/[\\/]/).pop());
  }
  const sb = makeDb(client);
  const snap = async () => ({
    entities: (await one("select count(*)::int n from entities"))[0].n,
    minted: (await one("select count(*)::int n from entities where method_version like 'reader@%'"))[0].n,
    refs: (await one("select count(*)::int n from entity_refs"))[0].n,
    reader_refs: (await one("select count(*)::int n from entity_refs where asserted_by = 'reader'"))[0].n,
    relations: (await one("select count(*)::int n from entity_relations"))[0].n,
    objects: (await one("select count(*)::int n from obligation_objects"))[0].n,
    events: (await one("select count(*)::int n from item_forward_events"))[0].n,
  });
  console.log("before", JSON.stringify(await snap()));
  const skip = new Set(values.skip);
  const totals = { entries: 0, residue: 0, refused: 0, residue_emitted: 0, entities_minted: 0, entities_reused: 0, candidates: 0 };
  for (const f of positionals) {
    const file = JSON.parse(readFileSync(f, "utf8"));
    const entries = file.entries.filter((e) => !skip.has(e.item_id));
    totals.candidates += entries.reduce((n, e) => n + (Array.isArray(e.new_entity_candidates) ? e.new_entity_candidates.length : 0), 0);
    const deps = { sb, now, intake: {}, verdicts: null, locate: locateSpan };
    const r = await applyBatch("item-briefs", deps, { content: JSON.stringify({ ...file, entries }), dry: !!values["dry-apply"], runId: "00000000-0000-4000-8000-0000000000aa", options: { allowBriefOverwrite: true } });
    const c = r.counts;
    totals.entries += entries.length;
    totals.residue += c.residue ?? 0;
    totals.refused += c.refused ?? 0;
    totals.residue_emitted += c.residue_emitted ?? 0;
    totals.entities_minted += (c.residue_entities_minted ?? 0) + (c.entities_minted ?? 0);
    totals.entities_reused += (c.residue_entities_reused ?? 0) + (c.entities_reused ?? 0);
    console.log(f.split(/[\\/]/).slice(-3).join("/"), "entries", entries.length, "outcome", r.outcome, JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k]) => /^(valid|refused|residue|applied|already_applied|residue_|entities_)/.test(k)))));
    for (const n of r.notes.filter((x) => /refused|failed|unknown entity|mint/.test(String(x))).slice(0, 12)) console.log("  note:", String(n).slice(0, 240));
  }
  const seen = totals.entities_minted + totals.entities_reused;
  console.log("emission totals", JSON.stringify(totals), "duplicate rate (reused / candidates written):", seen ? `${((100 * totals.entities_reused) / seen).toFixed(1)}%` : "n/a");
  console.log("after emission", JSON.stringify(await snap()));
  if (!values["no-mine"]) {
    const m = await mineRefs({ sb, now }, { dry: false });
    console.log("mineRefs", m.outcome, JSON.stringify(Object.fromEntries(Object.entries(m.counts).filter(([k]) => /^refs_|entity_classes|items_|rows_/.test(k)))));
    console.log("after mining", JSON.stringify(await snap()));
  }
  const p = await runPatterns({ sb, now }, { dry: false });
  const kinds = ["velocity", "mandateCapacity", "leadLag", "crossModal", "penaltyAbatement", "regulatoryStacking"];
  console.log("runPatterns", p.outcome, JSON.stringify(Object.fromEntries(kinds.map((k) => [k, p.counts[`patterns_${k}`] ?? 0]))), "total", p.counts.patterns ?? 0);
  console.log("loader input counts", JSON.stringify(Object.fromEntries(Object.entries(p.counts).filter(([k]) => !/^patterns|^pattern_needs|signpost/.test(k)))));
  const live = await one("select method_id, count(*)::int n from derived_values where method_id like 'pattern_%' and lifecycle not in ('falsified','obsolete','superseded') group by 1 order by 1");
  console.log("current derived_values by method", JSON.stringify(live));
  for (const n of p.notes.slice(0, 5)) console.log("  note:", String(n).slice(0, 240));
  if (values["synthesis-check"]) {
    // --synthesis-check: ONE connection through the shared write-back with an EMPTY item id, as a synthesis finding writes it; the relation row is read back
    const ends = await one("select entity_id from entities where status = 'active' and kind = 'organisation' order by entity_id limit 2");
    const cap = (await one("select id, left(result_content, 60) as t from agent_run_searches where result_content is not null limit 1"))[0];
    const plan = { signposts: [], gaps: [], connections: [{ parent: ends[0].entity_id, child: ends[1].entity_id, relation: "synthesis_proof_link", reason_token: "proof_only", quote: { capture_id: cap.id, text: cap.t } }] };
    const ctx = { kind: "admin-opportunity-findings", batch: "proof", subject: "cluster-proof", findingId: null, citedItemIds: [], inputs: [] };
    const w = await writeWriteback({ sb, now, intake: {}, verdicts: null, locate: locateSpan }, plan, ctx);
    const row = (await one("select parent_entity_id, child_entity_id, relation, asserted_by, method_version, basis from entity_relations where relation = 'synthesis_proof_link'"))[0];
    console.log("synthesis connection (empty itemId):", JSON.stringify(w.counts), JSON.stringify(w.notes), "row", JSON.stringify(row));
  }
  if (values.clusters) {
    const out = await drainExporters({ sb, now, intake: {}, verdicts: null, locate: locateSpan })["admin-opportunity-findings"]({ limit: 5 });
    const s = out.summary ?? {};
    const items = out.items ?? [];
    const tally = (key) => items.flatMap((i) => (Array.isArray(i[key]) ? i[key] : [])).reduce((a, x) => ((a[String(x)] = (a[String(x)] ?? 0) + 1), a), {});
    console.log("admin-opportunity-findings export ok:", out.ok, out.error ?? "", "clusters_assembled", s.clusters_assembled, "exported", items.length, "axes", JSON.stringify(tally("axes")), "angles", JSON.stringify(tally("angles")), "surfaces", JSON.stringify(tally("surfaces")));
  }
} finally {
  await client.query("rollback");
  await client.end();
  console.log("ROLLED BACK (nothing committed)");
}
