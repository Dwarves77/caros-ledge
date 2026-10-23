// Ported from old_repo/supabase/functions/capture-worker/index.ts (lines 68-70)
// Ported from old_repo/supabase/functions/capture-worker/index.ts (lines 222-256)
// Ported from old_repo/supabase/functions/capture-worker/index.ts (lines 589-614)
// The capture worker: an Edge Function that stays an Edge Function. The contract and the logic are in process.ts (five clauses, ADR-016); the fetch policy is src/core/fetch/policy.ts,
// imported relatively so this runtime and the Node transports share one policy. It reads no gate and no kill switch: the harness dispatcher is the one invoker and reads both before any call.
import { createClient } from "jsr:@supabase/supabase-js@2.118.0";
import { extractText, getDocumentProxy, getMeta } from "npm:unpdf@1.9.1";

import { extractPdfBudgeted } from "../../../src/core/fetch/policy.ts";

import { drain, isServiceRoleRequest, type Db, type WorkerDeps } from "./process.ts";

const json = (obj: unknown, status = 200): Response => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

/** PDF text under the budget (policy.ts): over MAX_PDF_PAGES it is refused before extractText runs, and an extraction that outlasts 30 s is abandoned; both are stated outcomes. */
const extractPdf = (bytes: Uint8Array) => extractPdfBudgeted(bytes, { getDocumentProxy, extractText, getMeta });

/** The addresses a host name resolves to, for the guard's private-address check. A name that does not resolve returns none: the fetch then fails on its own and says so. */
async function resolveHost(host: string): Promise<string[]> {
  const found: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    // No record of this type is not an error here: the other type, or the fetch itself, reports a name that does not resolve.
    await Deno.resolveDns(host, type).then((a) => void found.push(...a), () => undefined);
  }
  return found;
}

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "worker is not configured" }, 500);
  if (!isServiceRoleRequest(req.headers.get("authorization"), key)) return json({ error: "service role required" }, 401);
  let body: { limit?: number; queue_ids?: string[] | null } = {};
  const raw = await req.text();
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch (e) {
      return json({ error: `body is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }, 400);
    }
  }
  const deps: WorkerDeps = {
    db: createClient(url, key) as unknown as Db,
    extractPdf,
    env: { STORAGE_MAX_CHARS: Deno.env.get("STORAGE_MAX_CHARS") },
    now: () => Date.now(),
    resolveHost,
  };
  const out = await drain(deps, body);
  return json(out.body, out.status);
});
