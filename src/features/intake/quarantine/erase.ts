// Ported from old_repo/scripts/_reground/tombstone-delete.mjs (lines 10-107)
// Tombstone-then-delete of verified-correct ARCHIVED items (archive endgame). Rules, each enforced in the tool and none a judgment:
// the identity is written to disposition_ledger FIRST, every claim is archived to claim_versions, and only then the item goes, all in ONE database transaction (ledger_erase_item; INV-101); a bucket outside the
// deletable-reason allowlist is refused (accurate-but-archived reasons are never bucket-deleted); a bucket delete is limited to items
// the census verdicted archive_correct; `emptyOnly` keeps only items whose brief is empty AND that carry zero claims (a label is not
// proof, so a content-bearing row routes to review); `requireActiveSource` refuses an item whose source row is not ACTIVE (the content
// must survive somewhere before the item stops being the place it survives). The per-item claim count is a keyed count, not a table read.
import { exactCount, fetchAllRows, type Db } from "@/core/db";
import { eraseItem } from "@/core/grounding/ledger";
import { isUuid } from "@/core/http/parse";
import { runResult, type RunResult } from "@/core/intake/result";

import { acquireLease, releaseLease } from "./id-stamp";

/** archive_reason -> the disposition written to the ledger. A reason not in this map is never deleted by bucket. */
export const DELETABLE_REASONS: Readonly<Record<string, string>> = {
  reclassified_to_source: "tombstone_delete_reclassified",
  source_not_item: "tombstone_delete_source_not_item",
  portal_artifact: "tombstone_delete_artifact",
  error_page_artifact: "tombstone_delete_artifact",
  duplicate_instrument: "tombstone_delete_duplicate",
  duplicate_of_verified: "tombstone_delete_duplicate",
  duplicate: "tombstone_delete_duplicate",
};

interface Target { id: string; legacy_id: string | null; title: string | null; canonical_instrument_key: string | null; source_url: string | null; source_id: string | null; is_archived: boolean; archive_reason: string | null; full_brief: string | null }
export type EraseInput = { bucket: string; disposition?: string; mergedInto?: string | null; holder: string; apply?: boolean; emptyOnly?: boolean; requireActiveSource?: boolean }
  | { keys: string[]; disposition: string; mergedInto?: string | null; holder: string; apply?: boolean; emptyOnly?: boolean; requireActiveSource?: boolean };
export interface EraseOutcome { itemId: string; legacyId: string | null; outcome: "deleted" | "would_delete" | "skipped_content" | "refused_no_active_source" | "skipped_leased" | "failed"; detail: string }
export type EraseResult = RunResult & { targets: number; outcomes: EraseOutcome[] };
const COLUMNS = "id, legacy_id, title, canonical_instrument_key, source_url, source_id, is_archived, archive_reason, full_brief";

export async function eraseQuarantined(deps: { sb: Db }, input: EraseInput): Promise<EraseResult> {
  const { sb } = deps;
  const outcomes: EraseOutcome[] = [];
  const counts: Record<string, number> = { targets: 0, deleted: 0, would_delete: 0, skipped: 0, refused: 0, failed: 0 };
  const fail = (msg: string): EraseResult => ({ ...runResult("failed", counts, [msg]), targets: 0, outcomes });
  let effDisp: string;
  let targets: Target[];
  try {
    if ("bucket" in input) {
      const mapped = DELETABLE_REASONS[input.bucket];
      if (!mapped) return fail(`REFUSED: bucket '${input.bucket}' is not in the deletable-reason allowlist (content-survives, duplicate or pure-artifact only)`);
      effDisp = input.disposition ?? mapped;
      const rows = await fetchAllRows<Target>((from, to) => sb.from("intelligence_items").select(COLUMNS).eq("is_archived", true).eq("archive_reason", input.bucket).order("id", { ascending: true }).range(from, to), { cap: 100_000 });
      const census = await fetchAllRows<{ intelligence_item_id: string }>((from, to) => sb.from("corpus_census").select("intelligence_item_id").eq("haiku_verdict", "archive_correct").order("intelligence_item_id", { ascending: true }).range(from, to), { cap: 200_000 });
      const correct = new Set(census.map((c) => c.intelligence_item_id));
      targets = rows.filter((r) => correct.has(r.id));
    } else {
      effDisp = input.disposition;
      targets = [];
      for (const k of input.keys) {
        const r = await sb.from("intelligence_items").select(COLUMNS).eq(isUuid(k as unknown) ? "id" : "legacy_id", k).limit(2);
        if (r.error) return fail(`item lookup failed for '${k}': ${r.error.message}`);
        const rows = (r.data ?? []) as Target[];
        if (rows.length === 1 && rows[0]) targets.push(rows[0]);
        else outcomes.push({ itemId: k, legacyId: null, outcome: "failed", detail: rows.length ? `key '${k}' is ambiguous` : `item not found: ${k}` });
      }
    }
    if (input.emptyOnly) {
      const keep: Target[] = [];
      for (const t of targets) {
        const claims = await exactCount(sb.from("section_claim_provenance").select("id", { count: "exact", head: true }).eq("intelligence_item_id", t.id));
        if ((t.full_brief ?? "").length === 0 && claims === 0) keep.push(t);
        else {
          counts.skipped = (counts.skipped ?? 0) + 1;
          outcomes.push({ itemId: t.id, legacyId: t.legacy_id, outcome: "skipped_content", detail: `content-bearing (brief ${(t.full_brief ?? "").length}ch, ${claims} claim(s)): routes to per-item review` });
        }
      }
      targets = keep;
    }
  } catch (e) {
    return fail(`erase read failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  counts.targets = targets.length;
  let active: Set<string> | null = null;
  if (input.requireActiveSource) {
    try {
      const srcs = await fetchAllRows<{ id: string }>((from, to) => sb.from("sources").select("id").eq("status", "active").order("id", { ascending: true }).range(from, to), { cap: 200_000 });
      active = new Set(srcs.map((s) => s.id));
    } catch (e) {
      return fail(`active-source read failed (nothing deleted): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const it of targets) {
    const o = (outcome: EraseOutcome["outcome"], detail: string) => outcomes.push({ itemId: it.id, legacyId: it.legacy_id, outcome, detail });
    if (active && !(it.source_id && active.has(it.source_id))) {
      counts.refused = (counts.refused ?? 0) + 1;
      o("refused_no_active_source", "no ACTIVE source row: the content would not survive; register the source first");
      continue;
    }
    if (!input.apply) {
      counts.would_delete = (counts.would_delete ?? 0) + 1;
      o("would_delete", `dry: would tombstone (${effDisp}) then delete`);
      continue;
    }
    let leased = false;
    try {
      const lease = await acquireLease(sb, it.id, input.holder, "A");
      if (!lease.acquired) {
        counts.skipped = (counts.skipped ?? 0) + 1;
        o("skipped_leased", `leased by ${lease.curHolder ?? "another holder"}`);
        continue;
      }
      leased = true;
      // The tombstone, the archive of every claim to claim_versions and the delete are ONE transaction: a failure at any step leaves the item, its claims and the ledger exactly as they were.
      await eraseItem(sb, it.id, { disposition: effDisp, mergedInto: input.mergedInto ?? null, holder: input.holder });
      counts.deleted = (counts.deleted ?? 0) + 1;
      o("deleted", `tombstoned (${effDisp}) and deleted`);
    } catch (e) {
      counts.failed = (counts.failed ?? 0) + 1;
      o("failed", e instanceof Error ? e.message : String(e));
    } finally {
      if (leased) await releaseLease(sb, it.id, input.holder).catch(() => false);
    }
  }
  return { ...runResult((counts.failed ?? 0) > 0 ? "partial" : "ok", counts, outcomes.filter((x) => x.outcome === "failed").map((x) => `${x.legacyId ?? x.itemId}: ${x.detail}`)), targets: targets.length, outcomes };
}
