// Ported from old_repo/scripts/drain/plan-drain.mjs (lines 1-311); the planner itself is src/features/drain/plan.ts, this file is the command around it.
// `node scripts/digest/plan-drain.mjs [--kind K] [--mode M] [--limit N] [--dry] [--run-id R] [--out FILE]` plans one judgement drain run; `--finish PLAN [--prs kind=url,...]` ends it.
// STEP 0 is the first thing it does: the switch (system_state.judgement_drain), the emergency pause and an open fleet-budget-halt flag are read, and when any of them halts it prints `drain: off (reason)` and exits 0 having read
// nothing else, built nothing and taken no lease (a failed read is a halt). On: it builds the exporters, plans each kind oldest pending first, takes the mutation leases, and writes the plan file outside the repository.
// A plan that cannot be written releases its leases before the command exits 1; --finish releases every lease and records the run in the harness ledger (family judgement-drain).
import { register } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isMain } from "../lib/fs.mjs";

const defaultRunId = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "t");

function parse(argv, resolveKind, kindModes) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { out: { type: "string" }, "run-id": { type: "string" }, limit: { type: "string" }, finish: { type: "string" }, prs: { type: "string" }, kind: { type: "string" }, mode: { type: "string" }, dry: { type: "boolean", default: false } }, allowPositionals: false, strict: true }));
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const limit = values.limit === undefined ? null : Number(values.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) return { ok: false, error: "--limit must be a positive integer" };
  if (values.finish && (values.kind !== undefined || values.mode !== undefined || values.dry)) return { ok: false, error: "--finish cannot be combined with --kind, --mode or --dry" };
  const kind = values.kind === undefined ? null : resolveKind(values.kind);
  if (values.kind !== undefined && !kind) return { ok: false, error: `--kind must be a drain kind id or a prefix naming exactly one (got ${JSON.stringify(values.kind)})` };
  const mode = values.mode ?? "pending";
  if (mode !== "pending" && !(kind && kindModes(kind).includes(mode))) return { ok: false, error: `--mode ${mode} needs a --kind that registers it` };
  return { ok: true, out: values.out ?? null, runId: values["run-id"] ?? null, limit, finish: values.finish ?? null, prs: values.prs ?? null, kind: kind ? kind.id : null, mode, dry: values.dry };
}

/**
 * The command over injected I/O (a test passes a fake database): returns the exit code, never calls process.exit.
 * @param {string[]} argv
 * @param {{ now(): Date, makeDb(): object | null, buildExporters(sb: object): Promise<Record<string, Function>>, listBatchDir(kind: object): string[], planPath(runId: string, out: string | null): string, writePlan(path: string, text: string): void, readPlan(path: string): string, log(line: string): void }} io
 */
export async function runPlanDrain(argv, io) {
  const { readDrainSwitch } = await import("../../src/core/drain/switch.ts");
  const { finishDrain, leaseDeps, planDrain, resolveKind, kindModes } = await import("../../src/features/drain/index.ts");
  const parsed = parse(argv, resolveKind, kindModes);
  if (!parsed.ok) {
    io.log(`plan-drain: ${parsed.error}`);
    return 1;
  }
  const sb = io.makeDb();
  if (parsed.finish) return finish(parsed, sb, io, { finishDrain, leaseDeps });

  const sw = await readDrainSwitch(sb); // STEP 0: the first read, and the only one when anything halts.
  if (!sw.on) {
    io.log(`drain: off (${sw.reason})`);
    return 0;
  }
  const runId = parsed.runId ?? defaultRunId(io.now().toISOString());
  const exporters = await io.buildExporters(sb);
  const deps = { ...leaseDeps(sb), readSwitch: async () => sw, exporters, listBatchDir: io.listBatchDir, now: io.now };
  let plan;
  try {
    plan = await planDrain(deps, { runId, limit: parsed.limit, kindId: parsed.kind, mode: parsed.mode, dry: parsed.dry, kinds: Object.keys(exporters) });
  } catch (e) {
    io.log(`plan-drain: ${e.message}`);
    return 1; // planDrain has released any lease it took before it raised
  }
  const t = plan.totals;
  const counts = `${t.items} item(s) in ${t.batches} batch(es) across ${t.kinds_planned} kind(s)`;
  if (plan.dry) io.log(`drain: on (dry run: nothing written, no lease taken). ${counts}`);
  else {
    const path = io.planPath(runId, parsed.out);
    try {
      io.writePlan(path, JSON.stringify(plan, null, 2));
    } catch (e) {
      const { run } = await finishDrain({ release: deps.release, now: io.now }, plan);
      io.log(`plan-drain: the plan could not be written (${e.message}); ${run.metrics.leases_released} of ${run.metrics.leases_held} lease(s) released`);
      return 1;
    }
    io.log(`drain: on. ${counts}; ${t.leases_held} lease(s) held; plan ${path}`);
  }
  for (const k of plan.kinds) {
    const planned = k.batches.reduce((a, b) => a + b.count, 0);
    io.log(`  ${k.kind}${k.mode === "pending" ? "" : ` [${k.mode}]`}: exported ${k.pending_exported}, planned ${planned} in ${k.batches.length} batch(es)${k.apply_pending ? `, apply pending (${k.apply_pending})` : ""}${k.export_error ? `, export error: ${k.export_error}` : ""}${k.residue.lease_held.length ? `, ${k.residue.lease_held.length} lease-held` : ""}${plan.dry ? `, would lease ${k.would_lease ?? 0}` : ""}`);
    if (plan.dry) for (const b of k.batches) io.log(`    ${b.batch_path}: ${b.item_ids.join(", ")}`);
  }
  return 0;
}

/** --finish: release every lease the plan holds, then record the run (the family artifact) in the harness ledger. */
async function finish(parsed, sb, io, { finishDrain, leaseDeps }) {
  if (!sb) {
    io.log("plan-drain: no database credentials, so the leases cannot be released or the run recorded");
    return 1;
  }
  let plan;
  try {
    plan = JSON.parse(io.readPlan(parsed.finish));
  } catch (e) {
    io.log(`plan-drain: cannot read plan ${parsed.finish}: ${e.message}`);
    return 1;
  }
  const prs = Object.fromEntries(String(parsed.prs ?? "").split(",").filter(Boolean).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
  const { run } = await finishDrain({ release: leaseDeps(sb).release, now: io.now }, plan, prs);
  const { newRunId, recordRun } = await import("../../src/core/harness/index.ts");
  const m = run.metrics;
  const counts = { items: m.items, batches: m.batches, kinds_planned: m.kinds_planned, leases_held: m.leases_held, leases_released: m.leases_released, prs_opened: m.prs_opened };
  const wrote = counts.items + counts.leases_released;
  const open = m.leases_held - m.leases_released;
  const id = newRunId();
  const row = {
    id, family: "judgement-drain", root_run_id: id, upstream_run_id: null, trigger: "manual", mode: "apply", forced_dry: false,
    outcome: wrote === 0 ? "noop" : run.defectsFound.length || open ? "partial" : "success",
    reason: open ? `${open} lease(s) not released` : run.defectsFound[0]?.description ?? null,
    inputs: run.config, outputs: { counts, notes: run.defectsFound.slice(0, 50).map((d) => `${d.description}: ${d.root_cause}`) },
    error: null, code_sha: null, github_run_id: null, started_at: plan.generated_at, finished_at: io.now().toISOString(),
  };
  const rec = await recordRun(sb, row);
  io.log(`plan-drain: leases held ${m.leases_held}, released ${m.leases_released}; ${rec.error ? `ledger row NOT recorded (${rec.error})` : `ledger row ${id} (${row.outcome})`}`);
  return rec.error ? 1 : 0;
}

async function main() {
  register("../lib/ts-hooks.mjs", import.meta.url, { data: {} });
  const { isServiceConfigured, serviceClient } = await import("../../src/core/db/index.ts");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const io = {
    now: () => new Date(),
    makeDb: () => (isServiceConfigured() ? serviceClient() : null),
    // The exporters are the batch kit's own, over the turn's deps; they are built only after STEP 0 says the drain is on.
    buildExporters: async (sb) => {
      const { buildDeps, enforceWired, startupCheck } = await import("../../src/core/turn/wiring.ts");
      const { batchDeps } = await import("../../src/core/turn/stages/briefs.ts");
      const { drainExporters } = await import("../../src/features/batches/index.ts");
      const d = buildDeps(sb, process.env);
      await d.loadReferenceData();
      enforceWired(startupCheck(d));
      return drainExporters(batchDeps(d));
    },
    listBatchDir: (kind) => (existsSync(resolve(root, kind.batchDir)) ? readdirSync(resolve(root, kind.batchDir)) : []),
    // The plan names item ids and bundles live outside the repository (a bundle holds pool text); the default is the system temporary directory.
    planPath: (runId, out) => resolve(out ?? join(tmpdir(), "caros-drain", `plan-${runId}.json`)),
    writePlan: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
    readPlan: (path) => readFileSync(resolve(path), "utf8"),
    log: (line) => console.log(line),
  };
  process.exit(await runPlanDrain(process.argv.slice(2), io));
}

if (isMain(import.meta.url)) await main();
