// The ledger functions of migrations 0074 to 0077 as the in-memory database runs them. The SQL is proven by each migration's own self-check on the real schema (the attacks, the injected failures); these stand-ins let the
// application tests run the code that calls them with the same rules: a FACT is accepted only when its capture holds its span and its source is registered on the capture's host, the tier is the source's own, a change
// archives to claim_versions first, and a call is ALL OR NOTHING (a failure after the first write restores every table the call touched).
import { isVerbatim } from "@/core/contracts/verbatim";
import { computeMemberHash } from "@/core/flywheel/themes";
import { hostOf } from "@/core/shared/url";

import staged from "../../src/features/intake/data/staged.json" with { type: "json" };

import type { MemCall, MemDb, Op, Row } from "./memdb.ts";

class Refusal extends Error {
  readonly code: string;
  constructor(message: string, code = "22023") {
    super(message);
    this.code = code;
  }
}
const related = (a: string, b: string): boolean => !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
const TOUCHED = ["section_claim_provenance", "claim_versions", "intelligence_item_sections", "intelligence_items", "disposition_ledger", "theme_briefs", "theme_brief_versions"];

/** The SQL's ledger_attribution: the tier of the source registered on the capture's host, or the reason it is refused. */
/** The columns update_item may write: the application's staged.json, which migration 0076's lists are pinned to (tests/ledger/structure.test.ts). */
const ALLOWED_COLUMNS: ReadonlySet<string> = new Set([...staged.contentColumns, ...staged.nonSubstantive]);

export function attribution(db: MemDb, sourceId: string | null, captureId: string | null, span: string | null): { tier: number | null; problem: string | null } {
  if (!captureId) return { tier: null, problem: "fact_missing_capture" };
  if (!span || !span.trim()) return { tier: null, problem: "fact_missing_span" };
  const cap = db.rows("agent_run_searches").find((r) => r.id === captureId);
  if (!cap) return { tier: null, problem: "capture_missing" };
  if (!isVerbatim(cap.result_content as string | null, span)) return { tier: null, problem: "span_not_in_capture" };
  const chost = hostOf(cap.result_url as string);
  if (!sourceId) return { tier: null, problem: chost && db.rows("sources").some((s) => s.status !== "suspended" && related(hostOf(s.url as string), chost)) ? "source_resolvable" : null };
  const src = db.rows("sources").find((s) => s.id === sourceId);
  if (!src) return { tier: null, problem: "source_missing" };
  if (src.status === "suspended") return { tier: null, problem: "source_suspended" };
  if (!related(hostOf(src.url as string), chost)) return { tier: null, problem: "source_host_mismatch" };
  return { tier: (src.tier_override ?? src.base_tier ?? null) as number | null, problem: null };
}

function write(db: MemDb, table: string, op: Op, payload: unknown): void {
  const call: MemCall = { table, op, payload, filters: [], orders: [] };
  const injected = db.failWhen?.(call) ?? db.takeFailure(call)?.message ?? null;
  if (injected) throw new Refusal(injected, "XX000");
  db.calls.push(call);
}
const after = (db: MemDb, table: string, op: Op, payload: unknown): void => db.afterWrite?.({ table, op, payload, filters: [], orders: [] }, db);

function archive(db: MemDb, old: Row, reason: string, proof: unknown, note: unknown, now: unknown): number {
  const rows = db.rows("claim_versions");
  const version = rows.filter((v) => v.current_claim_id === old.id).reduce((m, v) => Math.max(m, Number(v.version_number)), 0) + 1;
  const row: Row = { id: db.nextId(), current_claim_id: reason === "proven_inaccurate" || reason === "superseded_by_record_briefs" ? null : old.id, intelligence_item_id: old.intelligence_item_id, section_row_id: old.section_row_id ?? null, claim_text: old.claim_text, claim_kind: old.claim_kind, source_span: old.source_span ?? null, source_id: old.source_id ?? null, search_result_id: old.search_result_id ?? null, source_tier_at_grounding: old.source_tier_at_grounding ?? null, mint_hold_reason: old.mint_hold_reason ?? null, version_number: version, supersede_reason: reason, inaccuracy_proof: proof ?? null, note: note ?? null, superseded_at: now ?? db.now };
  write(db, "claim_versions", "insert", row);
  rows.push(row);
  return version;
}

function writeClaim(db: MemDb, itemId: string, claimId: string | null, row: Row, reason: string, note: unknown, now: unknown): Row {
  const claims = db.rows("section_claim_provenance");
  const old = claimId ? claims.find((c) => c.id === claimId) : undefined;
  if (claimId && !old) throw new Refusal(`claim ${claimId} not found`, "P0002");
  if (old && old.intelligence_item_id !== itemId) throw new Refusal(`claim ${claimId} belongs to another item`);
  if (old && reason !== "changed") throw new Refusal(`a change is archived as changed, not ${reason}`);
  const pick = (k: string): unknown => (k in row ? row[k] : old?.[k]) ?? null;
  const next: Row = { section_row_id: pick("section_row_id"), claim_text: pick("claim_text"), claim_kind: pick("claim_kind"), source_span: pick("source_span"), source_id: pick("source_id"), search_result_id: pick("search_result_id"), mint_hold_reason: pick("mint_hold_reason") };
  if (typeof next.claim_text !== "string" || !next.claim_text.trim()) throw new Refusal("a claim needs its text");
  if (!next.claim_kind) throw new Refusal("a claim needs its kind");
  let tier: number | null = null;
  if (next.claim_kind === "FACT") {
    const a = attribution(db, next.source_id as string | null, next.search_result_id as string | null, next.source_span as string | null);
    if (a.problem) throw new Refusal(`attribution refused: ${a.problem}`);
    tier = a.tier;
  }
  if (old) {
    archive(db, old, "changed", null, note, now);
    write(db, "section_claim_provenance", "update", { ...next, source_tier_at_grounding: tier });
    Object.assign(old, next, { source_tier_at_grounding: tier });
    after(db, "section_claim_provenance", "update", old);
    return old;
  }
  const fresh: Row = { id: db.nextId(), intelligence_item_id: itemId, ...next, source_tier_at_grounding: tier, extracted_at: db.now };
  write(db, "section_claim_provenance", "insert", fresh);
  claims.push(fresh);
  after(db, "section_claim_provenance", "insert", fresh);
  return fresh;
}

function removeClaim(db: MemDb, claimId: string, reason: string, proof: unknown, note: unknown, now: unknown): number {
  if (db.rows("item_forward_events").some((e) => e.source_claim_id === claimId)) throw new Refusal("update or delete on section_claim_provenance violates foreign key constraint item_forward_events_source_claim_id_fkey", "23503");
  if (!["proven_inaccurate", "superseded_by_record_briefs", "orphaned_no_prose_referent"].includes(reason)) throw new Refusal(`a claim leaves the ledger only as a listed reason (got ${reason})`);
  if (reason !== "superseded_by_record_briefs" && !(proof && typeof proof === "object" && (proof as Row).reason)) throw new Refusal(`removing a claim as ${reason} needs a proof object with a reason`);
  const claims = db.rows("section_claim_provenance");
  const old = claims.find((c) => c.id === claimId);
  if (!old) throw new Refusal(`claim ${claimId} not found`, "P0002");
  const version = archive(db, old, reason, proof, note, now);
  write(db, "section_claim_provenance", "delete", { id: claimId });
  claims.splice(claims.indexOf(old), 1);
  after(db, "section_claim_provenance", "delete", old);
  return version;
}

/** All or nothing: every table a call may touch is restored when it throws. */
function atomic(db: MemDb, fn: () => unknown): { data?: unknown; error?: { message: string; code?: string } | null } {
  const snap = new Map(TOUCHED.map((t) => [t, structuredClone(db.tables[t] ?? [])]));
  try {
    return { data: fn() };
  } catch (e) {
    for (const [t, rows] of snap) db.tables[t] = rows;
    return { error: { message: e instanceof Error ? e.message : String(e), code: e instanceof Refusal ? e.code : "XX000" } };
  }
}
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function installLedgerRpcs(db: MemDb): void {
  db.rpcs.ledger_write_claim = (a, d) => atomic(d, () => {
    const c = writeClaim(d, a.p_item_id as string, (a.p_claim_id as string | null) ?? null, a.p_row as Row, str(a.p_reason) ?? "changed", a.p_batch, a.p_now);
    return { id: c.id, tier: c.source_tier_at_grounding };
  });
  db.rpcs.ledger_remove_claim = (a, d) => atomic(d, () => removeClaim(d, a.p_claim_id as string, a.p_reason as string, a.p_proof, a.p_note, a.p_now));
  db.rpcs.ledger_apply_ops = (a, d) => atomic(d, () => {
    const itemId = a.p_item_id as string;
    if (!d.rows("intelligence_items").some((i) => i.id === itemId)) throw new Refusal(`item ${itemId} not found`, "P0002");
    const out = { claims: 0, removed: 0, sections: 0 };
    for (const o of a.p_ops as Row[]) {
      if (o.op === "claim") { writeClaim(d, itemId, (o.claim_id as string | null) ?? null, o.row as Row, str(o.reason) ?? "changed", o.note, a.p_now); out.claims += 1; }
      else if (o.op === "remove") { removeClaim(d, o.claim_id as string, o.reason as string, o.proof, o.note, a.p_now); out.removed += 1; }
      else if (o.op === "section_insert") { write(d, "intelligence_item_sections", "insert", o); d.rows("intelligence_item_sections").push({ id: o.id, item_id: itemId, section_key: o.section_key, section_order: o.section_order, content_md: o.content_md, is_conditional: o.is_conditional }); out.sections += 1; }
      else if (o.op === "section_content") {
        const s = d.rows("intelligence_item_sections").find((x) => x.id === o.id && x.item_id === itemId);
        if (!s) throw new Refusal(`section ${o.id} of item ${itemId} not found`, "P0002");
        write(d, "intelligence_item_sections", "update", o);
        s.content_md = o.content_md;
        out.sections += 1;
      } else if (o.op === "brief") { write(d, "intelligence_items", "update", { full_brief: o.full_brief }); Object.assign(d.rows("intelligence_items").find((i) => i.id === itemId) as Row, { full_brief: o.full_brief }, o.keep_updated_at === true ? {} : { updated_at: d.now }); } // update_updated_at() (0130): stamped unless the op keeps it
      else throw new Refusal(`unknown ledger op ${String(o.op)}`);
    }
    return out;
  });
  db.rpcs.ledger_reconcile_sections = (a, d) => atomic(d, () => {
    const itemId = a.p_item_id as string;
    const next = a.p_sections as Row[];
    if (!Array.isArray(next) || !next.length) throw new Refusal("ledger_reconcile_sections needs an item and a non-empty sections array");
    const keys = new Set(next.map((s) => s.section_key));
    const out = { removed: 0, claims_archived: 0, updated: 0, inserted: 0 };
    for (const s of d.rows("intelligence_item_sections").filter((x) => x.item_id === itemId && !keys.has(x.section_key))) {
      for (const c of d.rows("section_claim_provenance").filter((x) => x.section_row_id === s.id)) {
        // item_forward_events_source_claim_id_fkey (no cascade): a claim a forward event is sourced from cannot go
        if (d.rows("item_forward_events").some((e) => e.source_claim_id === c.id)) throw new Refusal(`update or delete on section_claim_provenance violates foreign key constraint item_forward_events_source_claim_id_fkey (${String(c.id)})`, "23503");
        archive(d, c, "orphaned_no_prose_referent", { reason: "section_removed", section_key: s.section_key }, null, a.p_now);
        out.claims_archived += 1;
      }
      write(d, "intelligence_item_sections", "delete", { id: s.id });
      d.tables.section_claim_provenance = d.rows("section_claim_provenance").filter((x) => x.section_row_id !== s.id);
      d.tables.intelligence_item_sections = d.rows("intelligence_item_sections").filter((x) => x.id !== s.id);
      out.removed += 1;
    }
    for (const s of next) {
      const have = d.rows("intelligence_item_sections").find((x) => x.item_id === itemId && x.section_key === s.section_key);
      write(d, "intelligence_item_sections", have ? "update" : "insert", s);
      if (have) { Object.assign(have, { section_order: s.section_order, content_md: s.content_md, is_conditional: s.is_conditional }); out.updated += 1; }
      else { d.rows("intelligence_item_sections").push({ id: d.nextId(), item_id: itemId, section_key: s.section_key, section_order: s.section_order, content_md: s.content_md, is_conditional: s.is_conditional }); out.inserted += 1; }
    }
    return out;
  });
  db.rpcs.ledger_erase_item = (a, d) => atomic(d, () => {
    const it = d.rows("intelligence_items").find((i) => i.id === a.p_item_id);
    if (!it) throw new Refusal(`item ${String(a.p_item_id)} not found`, "P0002");
    if (!str(a.p_disposition)?.trim() || !str(a.p_holder)?.trim()) throw new Refusal("an erase needs a disposition and a holder");
    const row: Row = { id: d.nextId(), intelligence_item_id: it.id, item_key: it.legacy_id ?? null, canonical_instrument_key: it.canonical_instrument_key ?? null, title: it.title ?? null, source_url: it.source_url ?? null, archive_reason: it.archive_reason ?? null, disposition: a.p_disposition, merged_into_item_id: a.p_merged_into ?? null, snapshot_pointer: it.source_id ?? null, disposition_by: a.p_holder, disposition_date: a.p_now ?? d.now };
    write(d, "disposition_ledger", "insert", row);
    d.rows("disposition_ledger").push(row);
    const claims = d.rows("section_claim_provenance").filter((c) => c.intelligence_item_id === it.id);
    for (const c of claims) archive(d, c, "orphaned_no_prose_referent", { reason: "item_erased", disposition: a.p_disposition }, a.p_holder, a.p_now);
    write(d, "intelligence_items", "delete", { id: it.id });
    d.tables.section_claim_provenance = d.rows("section_claim_provenance").filter((c) => c.intelligence_item_id !== it.id);
    d.tables.intelligence_item_sections = d.rows("intelligence_item_sections").filter((s) => s.item_id !== it.id);
    d.tables.intelligence_items = d.rows("intelligence_items").filter((i) => i.id !== it.id);
    return { claims_archived: claims.length };
  });
  db.rpcs.ledger_attribution_violations = (a, d) => ({
    data: d.rows("section_claim_provenance").filter((c) => c.intelligence_item_id === a.p_item_id && c.claim_kind === "FACT").flatMap((c) => {
      const x = attribution(d, (c.source_id as string | null) ?? null, (c.search_result_id as string | null) ?? null, (c.source_span as string | null) ?? null);
      const reason = x.problem ?? (((c.source_tier_at_grounding as number | null) ?? null) !== x.tier ? "tier_not_the_sources" : null);
      return reason ? [{ claim_id: c.id, reason }] : [];
    }),
  });

  db.rpcs.apply_theme_brief = (a, d) => atomic(d, () => {
    const theme = d.rows("connection_themes").find((r) => r.id === a.p_theme_id);
    if (!theme) throw new Refusal(`theme ${String(a.p_theme_id)} does not exist in connection_themes`, "P0002");
    if (!a.p_sections || typeof a.p_sections !== "object" || !Array.isArray(a.p_claims)) throw new Refusal("a theme brief carries its sections (object) and claims (array)");
    const ids = [...(theme.member_ids as string[])].sort();
    const live = computeMemberHash(ids);
    if (a.p_member_hash !== live) throw new Refusal(`member_hash mismatch: authored against ${String(a.p_member_hash)}, the live membership hashes to ${live}`);
    const row: Row = { theme_id: a.p_theme_id, member_hash: live, member_count: ids.length, title: a.p_title, brief_md: a.p_brief_md, generated_at: a.p_now, generated_by: a.p_generated_by, sections: a.p_sections, claims: a.p_claims, member_ids: ids };
    const prior = d.rows("theme_briefs").find((r) => r.theme_id === a.p_theme_id);
    write(d, "theme_briefs", prior ? "update" : "upsert", row);
    if (prior) {
      d.rows("theme_brief_versions").push({ id: d.nextId(), theme_key: String(a.p_theme_id), version: d.rows("theme_brief_versions").filter((v) => v.theme_key === String(a.p_theme_id)).length + 1, row: { ...prior }, generated_by: prior.generated_by });
      Object.assign(prior, row);
    } else d.rows("theme_briefs").push(row);
    return { written: 1, member_count: ids.length, member_hash: live };
  });
  db.rpcs.apply_staged_item_patch = (a, d) => atomic(d, () => {
    const patch = a.p_patch as Row;
    if (!patch || typeof patch !== "object" || !Object.keys(patch).length) throw new Refusal("empty patch refused: nothing to write");
    const bad = Object.keys(patch).filter((k) => !ALLOWED_COLUMNS.has(k));
    if (bad.length) throw new Refusal(`column ${bad[0]} is outside the allowlist`);
    const item = d.rows("intelligence_items").find((i) => i.id === a.p_item_id);
    if (!item) throw new Refusal(`item ${String(a.p_item_id)} not found`, "P0002");
    for (const k of ["entry_into_force", "compliance_deadline"]) {
      if (patch[k] === undefined || patch[k] === null) continue;
      const e = (a.p_evidence as Row | null)?.[k] as { capture_id?: string; span?: string } | undefined;
      const cap = d.rows("agent_run_searches").find((r) => r.id === e?.capture_id && r.intelligence_item_id === a.p_item_id);
      if (!e || !cap || !isVerbatim(cap.result_content as string | null, e.span ?? null)) throw new Refusal(`date ${k} has no verbatim span in a capture of this item`);
    }
    write(d, "intelligence_items", "update", patch);
    Object.assign(item, patch);
    return { columns: Object.keys(patch) };
  });
  db.rpcs.capture_holding_quote = (a, d) => {
    const url = hostOf(String(a.p_url ?? ""));
    const hits = d.rows("agent_run_searches").filter((r) => hostOf(String(r.result_url ?? "")) === url && String(r.result_url ?? "").replace(/\/+$/, "") === String(a.p_url ?? "").replace(/\/+$/, "") && isVerbatim(r.result_content as string | null, a.p_quote as string | null));
    return { data: hits.length ? (hits[hits.length - 1] as Row).id : null };
  };
}
