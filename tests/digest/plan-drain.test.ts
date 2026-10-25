// The digest's plan-drain command: INV-DIG-1 (the kill switch exits before any queue read), INV-DIG-4 (every exit path releases the leases), the dry plan, and --finish's record in the ledger.
import assert from "node:assert/strict";
import { test } from "node:test";

import { planDrain, type DrainDeps, type Exporter } from "@/features/drain";

import { memoryDb } from "../_support/memory-db.ts";
import { runPlanDrain } from "../../scripts/digest/plan-drain.mjs";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const items = (...ns: number[]) => ns.map((n) => ({ id: U(n), title: `item ${n}` }));
const ex = (rows: Array<Record<string, unknown>>): Exporter => async () => ({ ok: true, items: rows });

/** The command over a memory database: the leases are RPCs the test answers and records; nothing is built, written or leased unless the test lets it. */
function world(o: { state?: Record<string, unknown>; flags?: Array<Record<string, unknown>>; exporters?: Record<string, Exporter>; failAcquireAt?: number; failReleaseFor?: string; failWrite?: boolean; noDb?: boolean } = {}) {
  const rpcs: string[] = [];
  let acquires = 0;
  const mem = memoryDb({ system_state: [{ id: true, global_processing_paused: false, judgement_drain: "on", ...o.state }], integrity_flags: o.flags ?? [] }, {
    rpc: (name, args) => {
      rpcs.push(`${name}:${(args as { p_item?: string }).p_item ?? ""}`);
      if (name === "acquire_mutation_lease") {
        acquires += 1;
        return o.failAcquireAt === acquires ? { data: null, error: { message: "rpc down" } } : { data: [{ acquired: true, cur_holder: (args as { p_holder: string }).p_holder }] };
      }
      if (name === "release_mutation_lease") return (args as { p_item: string }).p_item === o.failReleaseFor ? { data: null, error: { message: "rpc down" } } : { data: [{ released: true }] };
      return undefined;
    },
  });
  const out: string[] = [];
  const files = new Map<string, string>();
  let built = 0;
  const io = {
    env: {},
    now: () => NOW,
    makeDb: () => (o.noDb ? null : mem.db),
    buildExporters: async () => {
      built += 1;
      return o.exporters ?? {};
    },
    listBatchDir: () => [],
    planPath: (id: string) => `/scratch/plan-${id}.json`,
    writePlan: (path: string, text: string) => {
      if (o.failWrite) throw new Error("disk full");
      files.set(path, text);
    },
    readPlan: (path: string) => {
      const t = files.get(path);
      if (t === undefined) throw new Error(`no plan at ${path}`);
      return t;
    },
    log: (line: string) => out.push(line),
  };
  return { io, mem, rpcs, out, files, built: () => built };
}

test("INV-DIG-1: with any halt set the command prints `drain: off` and exits before any queue read, lease or plan file (a fake database counts every read)", async () => {
  const halts: Array<[string, Parameters<typeof world>[0]]> = [
    ["the switch is off", { state: { judgement_drain: "off" } }],
    ["the emergency pause is set", { state: { global_processing_paused: true } }],
    ["fleet-budget-halt is open", { flags: [{ id: U(9), subject_ref: "fleet-budget-halt", status: "open" }] }],
    ["no database credentials", { noDb: true }],
  ];
  for (const [why, o] of halts) {
    const w = world({ ...o, exporters: { "item-briefs": ex(items(1)) } });
    const code = await runPlanDrain([], w.io);
    assert.equal(code, 0, why);
    assert.match(w.out[0] ?? "", /^drain: off/, why);
    assert.deepEqual([...new Set(w.mem.reads.map((r) => r.table))].sort().filter((t) => t !== "system_state" && t !== "integrity_flags"), [], `${why}: only the switches may be read`);
    assert.deepEqual([w.built(), w.rpcs.length, w.files.size, w.mem.writes.length], [0, 0, 0, 0], `${why}: nothing built, leased, planned or written`);
  }
});

test("INV-DIG-1: with the switch on the exporters are built only after the switch read, and a plan file is written with the leases held", async () => {
  const w = world({ exporters: { "item-briefs": ex(items(1, 2)) } });
  assert.equal(await runPlanDrain(["--run-id", "r1", "--kind", "item-briefs"], w.io), 0);
  assert.equal(w.built(), 1);
  assert.match(w.out[0] ?? "", /^drain: on\. 2 item\(s\) in 1 batch\(es\) across 1 kind\(s\); 2 lease\(s\) held; plan \/scratch\/plan-r1\.json/);
  const plan = JSON.parse(w.files.get("/scratch/plan-r1.json") ?? "null") as { leases: unknown[]; kinds: Array<{ kind: string; authoring_guide: { schema: string } | null }> };
  assert.equal(plan.leases.length, 2);
  assert.equal(plan.kinds[0]?.authoring_guide?.schema, "docs/authoring/item-briefs.md");
});

test("INV-DIG-4: a lease call that fails part way releases every lease already taken before the error is raised", async () => {
  const taken: string[] = [];
  const released: string[] = [];
  const deps: DrainDeps = {
    readSwitch: async () => ({ on: true, reason: null, judgementDrain: "on", emergencyPaused: false, fleetHalted: false, readFailed: false }),
    exporters: { "item-briefs": ex(items(1, 2, 3)) },
    listBatchDir: () => [],
    acquire: async (id) => {
      if (taken.length === 2) throw new Error("rpc down");
      taken.push(id);
      return { acquired: true, cur_holder: "h" };
    },
    release: async (id) => (released.push(id), true),
    now: () => NOW,
  };
  await assert.rejects(() => planDrain(deps, { runId: "r2", kindId: "item-briefs" }), /rpc down/);
  assert.deepEqual(released, taken, "both leases taken before the failure are released");
  assert.equal(taken.length, 2);
  // A release that also fails is said in the error, never lost.
  const stuck: DrainDeps = { ...deps, acquire: async (id) => (taken.length === 2 ? Promise.reject(new Error("rpc down")) : (taken.push(id), { acquired: true, cur_holder: "h" })), release: async () => { throw new Error("release down"); } };
  taken.length = 0;
  await assert.rejects(() => planDrain(stuck, { runId: "r3", kindId: "item-briefs" }), /rpc down \(2 lease\(s\) taken before the failure could not be released/);
});

test("INV-DIG-4: a plan file that cannot be written releases the leases the plan took and the command exits 1", async () => {
  const w = world({ exporters: { "theme-briefs": ex([{ theme_id: U(1) }, { theme_id: U(2) }]) }, failWrite: true });
  assert.equal(await runPlanDrain(["--run-id", "r4", "--kind", "theme-briefs"], w.io), 1);
  assert.deepEqual(w.rpcs.filter((r) => r.startsWith("release_mutation_lease")).sort(), [`release_mutation_lease:${U(1)}`, `release_mutation_lease:${U(2)}`]);
  assert.match(w.out.join("\n"), /disk full/);
});

test("INV-DIG-4: --finish releases every lease and records the run in the ledger, a release that throws is recorded and the rest still release", async () => {
  for (const [failing, outcome, released] of [[undefined, "success", 3], [U(2), "partial", 2]] as const) {
    const w = world({ exporters: { "item-briefs": ex(items(1, 2, 3)) }, ...(failing ? { failReleaseFor: failing } : {}) });
    await runPlanDrain(["--run-id", "r5", "--kind", "item-briefs"], w.io);
    w.rpcs.length = 0;
    assert.equal(await runPlanDrain(["--finish", "/scratch/plan-r5.json", "--prs", "item-briefs=https://example.test/pr/1"], w.io), 0);
    assert.equal(w.rpcs.filter((r) => r.startsWith("release_mutation_lease")).length, 3, "every lease is tried even when one release fails");
    const rows = w.mem.tables.harness_runs ?? [];
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]?.family, rows[0]?.outcome, rows[0]?.mode], ["judgement-drain", outcome, "apply"]);
    const out = rows[0]?.outputs as { counts: Record<string, number>; notes: string[] };
    assert.deepEqual([out.counts.leases_held, out.counts.leases_released, out.counts.prs_opened, out.counts.items], [3, released, 1, 3]);
    if (failing) assert.match(out.notes.join(";"), /not released.*rpc down/);
  }
});

test("the dry plan takes no lease and writes no file: it counts what a run would hand out", async () => {
  const w = world({ exporters: { "item-briefs": ex(items(1, 2, 3, 4, 5)) } });
  assert.equal(await runPlanDrain(["--dry", "--run-id", "r6", "--kind", "item-briefs"], w.io), 0);
  assert.match(w.out[0] ?? "", /^drain: on \(dry run: nothing written, no lease taken\)\. 5 item\(s\) in 1 batch\(es\) across 1 kind\(s\)/);
  assert.deepEqual([w.rpcs.length, w.files.size, w.mem.writes.length], [0, 0, 0]);
});

test("a kind whose apply is pending is counted and never leased or batched; its plan entry says why", async () => {
  const w = world({ exporters: { "admin-opportunity-findings": ex([{ pattern_value_id: U(7), created_at: "2026-10-01" }]) } });
  assert.equal(await runPlanDrain(["--run-id", "r7", "--kind", "admin-opportunity-findings"], w.io), 0);
  const plan = JSON.parse(w.files.get("/scratch/plan-r7.json") ?? "null") as { leases: unknown[]; kinds: Array<{ pending_exported: number; batches: unknown[]; apply_pending: string | null }> };
  assert.deepEqual([plan.leases.length, plan.kinds[0]?.pending_exported, plan.kinds[0]?.batches.length], [0, 1, 0]);
  assert.match(plan.kinds[0]?.apply_pending ?? "", /DIGEST-1 PR B/);
});
