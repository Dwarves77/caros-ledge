// Ported from old_repo/src/lib/sources/verify-item.mjs (lines 1-151)
// Ported from old_repo/src/lib/sources/cheap-verify.mjs (lines 1-64)
// Ported from old_repo/src/lib/sources/holdings-gate.mjs (lines 1-34)
import type { Db } from "@/core/db";
import { toText } from "@/core/fetch/classify-body";

import { getSnapshot, probeFreshness, type Freshness } from "./snapshots";

export const SNAPSHOT_STUB_MAX = 1000;
/** One thin pool row is absence; two or more content-bearing pool rows is presence. */
export const MIN_USABLE_POOL_ROWS = 2;
/** Are usable holdings present? A real (non-stub) snapshot, or two or more content-bearing pool rows. Absence is the ONLY state that admits a fetch. */
export const holdingsPresent = ({ snapshotBytes = 0, usablePoolRows = 0 }: { snapshotBytes?: number; usablePoolRows?: number } = {}): boolean => Number(snapshotBytes) > SNAPSHOT_STUB_MAX || Number(usablePoolRows) >= MIN_USABLE_POOL_ROWS;

/** A text stripped the way grounding strips it, so a span matched at grounding cannot fail at re-verify. */
export const normalizeForMatch = (s: unknown): string => toText(s).replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
export const spanPresent = (span: string, normalizedText: string): boolean => {
  const n = normalizeForMatch(span);
  return n.length > 0 && normalizedText.includes(n);
};

export interface ClaimRow {
  claim_text?: string;
  claim_kind?: string;
  source_span?: string | null;
}
/** Are the item's FACT spans present in the stored snapshot? Pass needs at least one FACT claim and every FACT span present. Pure, no I/O. */
export function cheapVerifyClaims(claims: ClaimRow[] | null | undefined, snapshotHtml: string) {
  const text = normalizeForMatch(snapshotHtml);
  const list = Array.isArray(claims) ? claims : [];
  let matched = 0;
  let factTotal = 0;
  let factMatched = 0;
  const unmatched: Array<{ claim_text: string; claim_kind: string; source_span: string }> = [];
  for (const c of list) {
    const kind = String(c?.claim_kind ?? "").toLowerCase();
    const present = spanPresent(String(c?.source_span ?? ""), text);
    if (present) matched += 1;
    if (kind === "fact") {
      factTotal += 1;
      if (present) factMatched += 1;
    }
    if (!present) unmatched.push({ claim_text: String(c?.claim_text ?? ""), claim_kind: kind, source_span: String(c?.source_span ?? "") });
  }
  const hasFacts = factTotal > 0;
  const allFactsMatched = hasFacts && factMatched === factTotal;
  const reason = !hasFacts ? "no FACT claims to match against the snapshot (never span-grounded): cheap-verify cannot confirm" : allFactsMatched ? `all ${factTotal} FACT span(s) present in the stored snapshot` : `${factTotal - factMatched} of ${factTotal} FACT span(s) NOT present in the stored snapshot`;
  return { total: list.length, matched, factTotal, factMatched, allFactsMatched, hasFacts, unmatched, pass: allFactsMatched, reason };
}

export const STALE_FLAG = "stale_snapshot_content_changed";
export type VerifyOutcome = "verified_cheap" | "stale_flag" | "needs_capture";
/** The pure decision from the snapshot lookup, the freshness verdict and the cheap-verify result. */
export function decideVerify(snapshot: { found: boolean } | null, freshness: Pick<Freshness, "status"> | null, cheap: { pass: boolean; reason: string } | null): { outcome: VerifyOutcome; justification: string | null; flip: boolean; flag: string | null; reason: string } {
  if (!snapshot?.found) return { outcome: "needs_capture", justification: "missing_snapshot", flip: false, flag: null, reason: "no stored snapshot for this source" };
  if (freshness?.status === "changed") return { outcome: "stale_flag", justification: "content_changed", flip: false, flag: STALE_FLAG, reason: "freshness probe: source changed since snapshot capture" };
  if (cheap?.pass) return { outcome: "verified_cheap", justification: null, flip: true, flag: null, reason: cheap.reason };
  return { outcome: "needs_capture", justification: "cheap_verify_failed", flip: false, flag: null, reason: cheap ? cheap.reason : "no cheap-verify result" };
}

/** The stale-snapshot queue row (an open integrity flag); the insert is checked. */
export async function writeStaleFlag(db: Db, q: { itemId: string; reason: string }): Promise<void> {
  const { error } = await db.from("integrity_flags").insert({ category: "data_quality", subject_type: "item", subject_ref: q.itemId, description: `Stored snapshot is stale: ${q.reason}. Item verified against STORED text only; a capture was requested.`, recommended_actions: [{ action: "recapture", rationale: "content changed since snapshot" }], status: "open", created_by: STALE_FLAG });
  if (error) throw new Error(`stale-flag write failed: ${error.message}`);
}
/** A capture request replaces the paid acquire: queue the source on the capture worker's first-fetch queue. One open row per source (the partial unique index), so 23505 means already requested. */
export async function requestCapture(db: Db, sourceId: string): Promise<{ requested: boolean; alreadyOpen: boolean }> {
  const { error } = await db.from("pending_first_fetch").insert({ source_id: sourceId, status: "queued" });
  if (!error) return { requested: true, alreadyOpen: false };
  if ((error as { code?: string }).code === "23505") return { requested: false, alreadyOpen: true };
  throw new Error(`capture request failed for ${sourceId}: ${error.message}`);
}

export interface VerifyItemDeps {
  db: Db;
  loadItem: (id: string) => Promise<{ source_id: string | null; source_url: string | null } | null>;
  loadClaims: (id: string) => Promise<ClaimRow[]>;
  probe?: (url: string, stored: { fetchedAt?: string | null }) => Promise<Freshness>;
  act?: boolean;
}
/**
 * One item's snapshot-first verification. It reads by default and performs guarded side effects only when `act` is set: a stale flag, or a capture request. No paid
 * path exists. The provenance flip itself belongs to the caller.
 */
export async function verifyItem(deps: VerifyItemDeps, itemId: string) {
  const item = await deps.loadItem(itemId);
  if (!item) return { itemId, outcome: "needs_capture" as VerifyOutcome, reason: "item not found", acted: false };
  const sourceId = item.source_id;
  const snapshot = sourceId ? await getSnapshot(deps.db, { sourceId }) : ({ found: false } as const);
  const freshness = snapshot.found && item.source_url && deps.probe ? await deps.probe(item.source_url, { fetchedAt: snapshot.fetchedAt }) : null;
  const cheap = snapshot.found ? cheapVerifyClaims(await deps.loadClaims(itemId), snapshot.content) : null;
  const d = decideVerify(snapshot, freshness, cheap);
  const result = { itemId, sourceId, outcome: d.outcome, reason: d.reason, flip: d.flip, flag: d.flag, acted: false, captureRequested: false };
  if (!deps.act) return result;
  if (d.outcome === "stale_flag") await writeStaleFlag(deps.db, { itemId, reason: d.reason });
  else if (d.outcome === "needs_capture" && sourceId) result.captureRequested = (await requestCapture(deps.db, sourceId)).requested;
  return { ...result, acted: true };
}
export { probeFreshness };
