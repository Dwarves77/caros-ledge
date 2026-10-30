// Ported from old_repo/src/app/api/admin/statutory-rows/route.ts (lines 8-37)
// Ported from old_repo/src/app/api/admin/statutory-rows/logic.mjs (lines 14-57)
import { HttpError } from "@/core/http/errors";
import { statutoryRun } from "@/features/statutory";

import { adminDeps } from "./deps";
import { adminRoute, reply } from "./shared";

/**
 * Preview (default) or apply a statutory rows file through the one validated writer (INV-115, INV-141): the whole file is validated first and a violation refuses everything (422, nothing written);
 * each row then goes through the filing gate. Operator-entered platform data, never customer data. The formula the writer needs comes from the regulations slice; until it is wired this answers 503, never a guess.
 */
export const POST = adminRoute("/api/admin/statutory-rows", async (admin, request) => {
  const apply = new URL(request.url).searchParams.get("mode") === "apply";
  let file: unknown;
  try {
    file = await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const db = admin.service();
  const d = adminDeps(db);
  if (!d.statutory) throw new HttpError(503, "the statutory formula is owed by the regulations slice and is not wired yet");
  const run = await statutoryRun({ sb: db, now: () => new Date(performance.timeOrigin + performance.now()), statutory: d.statutory }, { dry: !apply, file });
  if (run.counts.violations) return reply(admin, { error: "rows-file failed validation - nothing written", violations: run.notes }, 422);
  return reply(admin, { mode: apply ? "apply" : "dry", total: run.counts.rows ?? 0, counts: run.counts, outcome: run.outcome, outcomes: run.data?.perItem ?? [], notes: run.notes });
});
