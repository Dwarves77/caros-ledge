// MINT-1 (ADR-050): the backfill that retires the sentences the record mint used to store. A record's absence is the line `[slot] <token>`; every line still in the sentence form
// (the legacy regex in core/brief) is rewritten to it in the section row, the claim row and the stub full_brief, so a customer surface never reads text the mint authored.
// Each item is one ledger transaction (core/grounding applyLedgerOps: the claim's prior text archived first); an item the transaction refuses is unchanged, reported, and found again by the next pass.
// A pass over rewritten rows finds nothing and writes nothing.
import { ABSENCE_TOKEN, LEGACY_GAP_LINE } from "@/core/brief";
import { boundedRead, exactCount, fetchAllRows, type Db } from "@/core/db";
import { buildGateARow, derivedCoveredTokens, upsertGateAState } from "@/core/grounding";
import { applyLedgerOps, type LedgerOp } from "@/core/grounding/ledger";
import { runResult, type RunResult } from "@/core/types/run-result";

import { STUB } from "./payload";

const HOLDS = "%A full-brief regrounding will re-examine this gap%";
const LINES = new RegExp(LEGACY_GAP_LINE.source, "gm");
const SECTIONS = ["identity", "record_facts"];
const retoken = (text: string | null): { out: string; n: number } => {
  let n = 0;
  const out = (text ?? "").replace(LINES, (_m, lead: string, slot: string) => {
    n += 1;
    return `${lead}[${slot}] ${ABSENCE_TOKEN}`;
  });
  return { out, n };
};
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The ids of up to `limit` items that hold a legacy line in a section, a GAP claim or a stub brief: the smallest ids of the union of three bounded reads; a string is the read error. */
async function candidateIds(db: Db, limit: number): Promise<string[] | string> {
  const reads = await Promise.all([
    boundedRead<{ item_id: string }>((n) => db.from("intelligence_item_sections").select("item_id").in("section_key", SECTIONS).like("content_md", HOLDS).order("item_id").limit(n), { limit }),
    boundedRead<{ intelligence_item_id: string }>((n) => db.from("section_claim_provenance").select("intelligence_item_id").eq("claim_kind", "GAP").like("claim_text", HOLDS).order("intelligence_item_id").limit(n), { limit }),
    boundedRead<{ id: string }>((n) => db.from("intelligence_items").select("id").like("full_brief", HOLDS).order("id").limit(n), { limit }),
  ]);
  const bad = reads.find((r) => r.error);
  if (bad?.error) return bad.error.message;
  const [secs, claims, briefs] = reads;
  return [...new Set([...(secs?.data ?? []).map((x) => x.item_id), ...(claims?.data ?? []).map((x) => x.intelligence_item_id), ...(briefs?.data ?? []).map((x) => x.id)])].sort().slice(0, limit);
}

interface Claim { id: string; claim_kind: string; claim_text: string; source_span: string | null }
/** One item as ONE ledger transaction (the claims archived to claim_versions first): the brief, the section rows, the GAP claims. The Gate A state for the new brief goes in first, so every validation the transaction fires finds a current hash; a refused transaction puts the old state back. Returns the lines rewritten, or the error that stopped the item. */
async function rewriteItem(db: Db, id: string, o: { dry: boolean; nowIso: string }): Promise<number | { error: string }> {
  const item = await db.from("intelligence_items").select("full_brief").eq("id", id).maybeSingle();
  const secs = await db.from("intelligence_item_sections").select("id, content_md").eq("item_id", id).in("section_key", SECTIONS);
  const readError = item.error ?? secs.error;
  if (readError) return { error: `read: ${readError.message}` };
  let claims: Claim[];
  try {
    claims = await fetchAllRows<Claim>((from, to) => db.from("section_claim_provenance").select("id, claim_kind, claim_text, source_span").eq("intelligence_item_id", id).order("id", { ascending: true }).range(from, to), { cap: 20_000 });
  } catch (e) {
    return { error: `claims read: ${msg(e)}` };
  }
  const old = (item.data as { full_brief: string | null } | null)?.full_brief ?? null;
  const brief = old?.includes(STUB.marker) ? retoken(old) : { out: old, n: 0 };
  const sections = ((secs.data ?? []) as { id: string; content_md: string | null }[]).map((s) => ({ id: s.id, ...retoken(s.content_md) })).filter((s) => s.n > 0);
  const gaps = claims.filter((c) => c.claim_kind === "GAP").map((c) => ({ id: c.id, ...retoken(c.claim_text) })).filter((c) => c.n > 0);
  const lines = brief.n + sections.reduce((n, s) => n + s.n, 0) + gaps.length;
  if (o.dry || lines === 0) return lines;
  const ops: LedgerOp[] = [
    ...(brief.n > 0 ? [{ op: "brief" as const, full_brief: brief.out ?? "" }] : []),
    ...sections.map((s) => ({ op: "section_content" as const, id: s.id, content_md: s.out })),
    ...gaps.map((c) => ({ op: "claim" as const, claim_id: c.id, row: { claim_text: c.out }, note: "MINT-1 retokenise" })),
  ];
  const facts = claims.filter((c) => c.claim_kind === "FACT").map((c) => ({ claim_text: c.claim_text, source_span: c.source_span ?? "" }));
  const state = async (fullBrief: string | null) => upsertGateAState(db, buildGateARow({ itemId: id, fullBrief, factClaims: facts, derivedCovered: await derivedCoveredTokens(db, id), nowIso: o.nowIso }));
  if (brief.n > 0) {
    const first = await state(brief.out);
    if (first.error) return { error: `gate state: ${first.error}` };
  }
  try {
    await applyLedgerOps(db, id, ops, o.nowIso);
  } catch (e) {
    if (brief.n > 0) await state(old);
    return { error: msg(e) };
  }
  return lines;
}

/** The legacy lines still stored, per store: sections, GAP claims, stub briefs. The backfill is finished when all three are zero. */
const remainingCounts = (db: Db): Promise<number[]> =>
  Promise.all([
    exactCount(db.from("intelligence_item_sections").select("id", { count: "exact", head: true }).in("section_key", SECTIONS).like("content_md", HOLDS)),
    exactCount(db.from("section_claim_provenance").select("id", { count: "exact", head: true }).eq("claim_kind", "GAP").like("claim_text", HOLDS)),
    exactCount(db.from("intelligence_items").select("id", { count: "exact", head: true }).like("full_brief", HOLDS)),
  ]);

/**
 * Rewrite the legacy absence lines of up to `limit` (at most 200) items to the token. Counts: items_scanned, items_rewritten (items_planned when dry), items_failed, lines_rewritten
 * (lines_planned when dry), remaining (the largest of the three stores' leftover row counts: an upper bound on items, zero only when every store is clean).
 */
export async function retokeniseRecordGaps(db: Db, o: { limit: number; dry?: boolean; now: () => Date }): Promise<RunResult> {
  const dry = o.dry === true;
  const ids = await candidateIds(db, Math.min(200, Math.max(1, Math.floor(o.limit))));
  if (typeof ids === "string") return runResult("failed", {}, [`retokenise: candidate read failed: ${ids}`]);
  const notes: string[] = [];
  let failed = 0;
  let touched = 0;
  let lines = 0;
  for (const id of ids) {
    const r = await rewriteItem(db, id, { dry, nowIso: o.now().toISOString() });
    if (typeof r !== "number") {
      failed += 1;
      notes.push(`item ${id}: ${r.error}`);
    } else if (r > 0) {
      touched += 1;
      lines += r;
    }
  }
  let left: number[];
  try {
    left = await remainingCounts(db);
  } catch (e) {
    return runResult("failed", { items_scanned: ids.length }, [...notes, `retokenise: remaining count failed: ${msg(e)}`]);
  }
  const counts = { items_scanned: ids.length, [dry ? "items_planned" : "items_rewritten"]: touched, items_failed: failed, [dry ? "lines_planned" : "lines_rewritten"]: lines, remaining: Math.max(...left) };
  return runResult(failed ? "partial" : "ok", counts, notes);
}
