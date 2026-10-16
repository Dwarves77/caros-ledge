// Ported from old_repo/src/app/api/agent/run/route.ts (lines 1-140)
// POST /api/agent/run at the old URL. Platform admin only. The item is found by id or by source_url; a verified item short-circuits unless
// `refresh`; one run per item per hour (refresh does not bypass it); BOTH guard reads fail closed (503 guard_unavailable, the workflow does
// not start). The metered durable-workflow start is replaced by the free workflow run inline with the session-authored brief in the body.
import { z } from "zod";

import { boundedRead, type Db } from "@/core/db";
import { HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireAdmin } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";

import type { IntakeDeps } from "../deps";
import { startBriefWorkflow, type InjectedBrief } from "../workflow";

export const COOLDOWN_MS = 60 * 60 * 1000;

/** P2-08 wires the real dependency graph; until then the route answers 503 rather than running against nothing. */
let factory: ((sb: Db) => IntakeDeps) | null = null;
export function setIntakeDepsFactory(f: ((sb: Db) => IntakeDeps) | null): void {
  factory = f;
}

const injected = z.object({ body: z.string(), metadata: z.unknown(), sourcePoolHash: z.string(), ledger: z.unknown(), allowBriefOverwrite: z.boolean().optional(), confirmations: z.record(z.string(), z.object({ span: z.string(), url: z.string() })).optional() });
const bodySchema = z.object({ itemId: z.string().min(1).optional(), sourceUrl: z.string().min(1).optional(), refresh: z.boolean().optional(), dry: z.boolean().optional(), injected: injected.optional(), reresearch: injected.optional() });

export const POST = route("/api/agent/run", async (request) => {
  const admin = await requireAdmin(request);
  if (isRefusal(admin)) return admin;
  const body = await parseJson(request, bodySchema);
  if (!factory) throw new HttpError(503, "intake runtime is not wired");
  const sb = admin.service();
  const deps = factory(sb);
  let itemId = body.itemId;
  if (!itemId && body.sourceUrl) {
    const r = await boundedRead<{ id: string }>((n) => sb.from("intelligence_items").select("id").eq("source_url", body.sourceUrl as string).limit(n), { limit: 1 });
    if (r.error) throw new LookupError("intelligence_items by source_url", r.error);
    itemId = r.data[0]?.id;
    if (!itemId) throw new HttpError(404, `No intelligence_items row matches source_url=${body.sourceUrl}.`);
  }
  if (!itemId) throw new HttpError(400, "itemId or sourceUrl is required");

  // Guard 1 (fail closed): a certified item is not regenerated unless the caller refreshes.
  const item = await sb.from("intelligence_items").select("provenance_status").eq("id", itemId).maybeSingle();
  if (item.error) return Response.json({ error: "guard_unavailable", detail: item.error.message }, { status: 503, headers: { "Retry-After": "1" } });
  if ((item.data as { provenance_status?: string } | null)?.provenance_status === "verified" && body.refresh !== true) {
    return ok(admin.headers, { skipped: "already_verified", item_id: itemId, hint: "pass { refresh: true } to force a regeneration" });
  }
  // Guard 2 (fail closed): one run per item per hour.
  const since = new Date(deps.recorder.now().getTime() - COOLDOWN_MS).toISOString();
  const recent = await boundedRead<{ created_at: string }>((n) => sb.from("agent_runs").select("created_at").eq("intelligence_item_id", itemId as string).gte("created_at", since).limit(n), { limit: 1 });
  if (recent.error) return Response.json({ error: "guard_unavailable", detail: recent.error.message }, { status: 503, headers: { "Retry-After": "1" } });
  if (recent.data.length > 0) return Response.json({ error: "cooldown", item_id: itemId, hint: "an agent run for this item ran within the last hour; wait before retrying" }, { status: 429, headers: { "Retry-After": "3600" } });

  const result = await startBriefWorkflow(deps, { itemId, ...(body.injected ? { injected: body.injected as InjectedBrief } : {}), ...(body.reresearch ? { reresearch: body.reresearch as InjectedBrief } : {}), ...(body.dry ? { dry: true } : {}) });
  return ok(admin.headers, { item_id: itemId, status: result.status, outcome: result.outcome, counts: result.counts, steps: result.steps, notes: result.notes });
});
