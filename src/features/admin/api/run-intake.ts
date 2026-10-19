// Ported from old_repo/src/app/api/admin/run-intake/route.ts (lines 13-50)
import { z } from "zod";

import { runFamily, type HarnessDeps } from "@/core/harness";
import { parseJson } from "@/core/http/parse";
import { runIntakeCycle, type IntakeCandidate } from "@/features/intake";

import { adminDeps } from "./deps";
import { adminRoute, reply } from "./shared";

export const MAX_CANDIDATES = 5;
const candidate = z.object({ title: z.string().trim().min(1).max(500), source_url: z.string().trim().min(1).max(2000), item_type: z.string().trim().min(1).max(60) }).passthrough();
const body = z.object({ candidates: z.array(candidate).min(1).max(MAX_CANDIDATES), mode: z.enum(["plan", "apply"]).optional() });

/**
 * Run ONE intake cycle on a small candidate set and stop. It is a recorded firing of the ledger-consume family under its own root (the kill switch is read first, the build-mode gate decides the mode: while the cadence is
 * off an apply is planned, and the answer says so), and the cycle is the record-only path of the intake slice: the staged transit and the mint chokepoint, the change-sweep drain at its tail. There are no approve
 * affordances; the machine gates are the approval.
 */
export const POST = adminRoute("/api/admin/run-intake", async (admin, request) => {
  const b = await parseJson(request, body);
  const db = admin.service();
  const d = adminDeps(db);
  const h: HarnessDeps = {
    sb: db,
    env: process.env,
    now: () => new Date(),
    fns: { "ledger-consume": async (call) => runIntakeCycle(d.intake, { candidates: b.candidates as IntakeCandidate[], mode: call.dry ? "plan" : "apply" }) },
  };
  const run = await runFamily("ledger-consume", { mode: b.mode === "apply" ? "apply" : "dry", trigger: "dispatch", input: { control: "run-intake-now", candidates: b.candidates.length } }, h);
  return reply(admin, { ok: run.exit === 0, control: "run-intake-now", mode: run.row?.mode ?? "dry", forced_dry: run.row?.forced_dry ?? false, reason: run.row?.reason ?? null, outcome: run.row?.outcome ?? null, run_id: run.row?.id ?? null, cycle_stopped: true, result: run.result, error: run.error });
});
