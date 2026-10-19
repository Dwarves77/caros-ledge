import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// INV-283 / INV-289 and the rejections count: what the console's routes call exists in migration 0035, is service-role only, and does its two writes in one function (one transaction).
const sql = readFileSync("supabase/migrations/0035_admin_triage_rpcs.sql", "utf8");
const triage = readFileSync("src/features/admin/api/triage.ts", "utf8");
const attention = readFileSync("src/features/admin/api/attention.ts", "utf8");

test("the jurisdiction resolve is one rpc: the item swap and the queue stamp share a function, a missing row is P0002 and a resolved row 22023", () => {
  assert.match(triage, /adminAct\(admin, "admin_resolve_jurisdiction_review"/, "R2e: the route calls the wrapper that writes the operator's reason and the event with the resolve");
  const wrapper = /CREATE FUNCTION public\.admin_resolve_jurisdiction_review[\s\S]*?\$\$;/.exec(readFileSync("supabase/migrations/0102_admin_action_rpcs.sql", "utf8"))?.[0] ?? "";
  assert.ok(wrapper.includes("public.resolve_pending_jurisdiction_review(") && wrapper.includes("record_admin_event"), "one function: the resolve and the event");
  const body = /CREATE FUNCTION public\.resolve_pending_jurisdiction_review[\s\S]*?\$\$;/.exec(sql)?.[0] ?? "";
  assert.ok(body.includes("UPDATE public.intelligence_items") && body.includes("UPDATE public.pending_jurisdiction_review"), "both writes are in the function");
  assert.ok(body.includes("FOR UPDATE"), "the row is locked before the check");
  assert.ok(/'row not found' USING ERRCODE = 'P0002'/.test(body) && /'row already resolved' USING ERRCODE = '22023'/.test(body));
  assert.ok(/REVOKE ALL ON FUNCTION public\.resolve_pending_jurisdiction_review\(uuid, text, text, uuid\) FROM PUBLIC, anon, authenticated;/.test(sql) && /GRANT EXECUTE ON FUNCTION public\.resolve_pending_jurisdiction_review\(uuid, text, text, uuid\) TO service_role;/.test(sql), "service role only");
  assert.ok(!/TO (anon|authenticated|PUBLIC)\b/.test(/resolve_pending_jurisdiction_review\(uuid, text, text, uuid\) TO [a-z_, ]+;/.exec(sql)?.[0] ?? ""));
});

test("admin_attention_counts reports untriaged ingest rejections and its total includes them", () => {
  assert.match(attention, /ingest_rejections_untriaged/);
  assert.ok(/ingest_rejections_untriaged integer, total integer/.test(sql));
  assert.ok(/\+ ingest_rejections_untriaged\) AS total/.test(sql), "the total sums the new count");
  assert.ok(/WHERE triaged_at IS NULL\) AS ingest_rejections_untriaged/.test(sql));
  assert.ok(/self-check|DO \$\$/.test(sql) && sql.includes("0035-admin-triage OK"), "the file ends in its self-check");
});
