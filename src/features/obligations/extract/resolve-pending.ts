// New in FLY-1 (ADR-050; no old source: the old tree never resolved a pending trigger). Pending regulatory triggers (implementing_act_due, delegated_act_due, guidance_expected) are resolved inside the turn: when a LATER capture of
// the item's source states the act or the guidance, the forward event is stamped with the capture id and the verbatim statement. The statement is located by the rules in data/resolution-rules.json and counts only when
// the one verbatim rule accepts it AND no capture the item held when the event was written already contained it (so a citation the instrument always carried never resolves its own pending duty). Code classifies and
// quotes; it composes no sentence. One statement resolves at most one pending event of its kind, so two pending acts are not both closed by one citation. Dry reads and decides the same and writes nothing.
import { z } from "zod";

import { allRows, rowsByIds, type Db } from "@/core/db";
import { isVerbatim } from "@/core/contracts/verbatim";
import { isForeignCapture, type InstrumentIdentity } from "@/core/fetch";
import type { RunResult } from "@/core/types/run-result";
import { runResult } from "@/core/types/run-result";

import raw from "./data/resolution-rules.json";

const rules = z.object({ itemsPerTurn: z.number().int().positive(), rules: z.array(z.object({ kind: z.string(), re: z.object({ source: z.string(), flags: z.string() }) })) }).parse(raw);
const RULES = rules.rules.map((r) => ({ kind: r.kind, re: new RegExp(r.re.source, r.re.flags) }));
const PENDING_KINDS: readonly string[] = RULES.map((r) => r.kind);

interface Pending { id: string; intelligence_item_id: string; event_kind: string; created_at: string; source_capture_id: string | null }
interface Capture { id: string; intelligence_item_id: string; result_content: string | null; searched_at: string | null; result_url: string | null; search_query: string | null }

/** The first statement in `text` that a rule of this kind finds and no text in `already` contains; null when none. Pure. */
function statementOf(kind: string, text: string, already: readonly string[], taken: ReadonlySet<string>): string | null {
  const rule = RULES.find((r) => r.kind === kind);
  if (!rule) return null;
  for (const m of text.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
    const span = m[0];
    if (taken.has(span.toLowerCase()) || !isVerbatim(text, span) || already.some((t) => isVerbatim(t, span))) continue;
    return span;
  }
  return null;
}

/** Resolve the pending triggers of `itemIds` (or, absent, the oldest pending ones, at most itemsPerTurn items per turn). Returns the resolved event ids as data.ids.resolved_event_ids. */
export async function resolvePendingTriggers(deps: { sb: Db; now(): Date }, input: { dry: boolean; itemIds?: readonly string[] }): Promise<RunResult<{ ids: { resolved_event_ids: string[] } }>> {
  const { sb } = deps;
  const cols = "id, intelligence_item_id, event_kind, created_at, source_capture_id";
  const all = input.itemIds
    ? (await rowsByIds<Pending & { resolved_at: string | null }>(sb, "item_forward_events", `${cols}, resolved_at`, input.itemIds, "intelligence_item_id")).filter((e) => e.resolved_at === null && PENDING_KINDS.includes(e.event_kind))
    : await allRows<Pending>(sb, "item_forward_events", cols, { where: (q) => q.in("event_kind", PENDING_KINDS).is("resolved_at", null), cap: 100_000 });
  const items = [...new Set(all.map((e) => e.intelligence_item_id))].sort();
  const chosen = new Set(input.itemIds ? items : items.slice(0, rules.itemsPerTurn));
  const events = all.filter((e) => chosen.has(e.intelligence_item_id));
  const c = { pending: all.length, items_checked: chosen.size, items_left: items.length - chosen.size, resolved: 0, still_pending: 0, write_failures: 0 };
  const notes: string[] = [];
  const resolved: string[] = [];
  // The item's own instrument only: the heal filed other instruments' captures under the items that cited them (POOL-FIX-1), and one of them states no act of this item's.
  const identity = new Map((await rowsByIds<InstrumentIdentity & { id: string }>(sb, "intelligence_items", "id, canonical_instrument_key, instrument_identifier, source_url", chosen)).map((i) => [i.id, i]));
  const captures = (chosen.size ? await rowsByIds<Capture>(sb, "agent_run_searches", "id, intelligence_item_id, result_content, searched_at, result_url, search_query", [...chosen], "intelligence_item_id") : []).filter((c) => !isForeignCapture(c, identity.get(c.intelligence_item_id) ?? {}));
  const taken = new Map<string, Set<string>>();
  for (const ev of events) {
    const own = captures.filter((c) => c.intelligence_item_id === ev.intelligence_item_id && c.result_content);
    const isLater = (c: Capture) => c.id !== ev.source_capture_id && (c.searched_at ?? "") > ev.created_at;
    const earlier = own.filter((c) => !isLater(c)).map((c) => c.result_content as string);
    let hit: { capture: Capture; span: string } | null = null;
    for (const c of own.filter(isLater).sort((a, b) => String(a.searched_at).localeCompare(String(b.searched_at)) || a.id.localeCompare(b.id))) {
      const span = statementOf(ev.event_kind, c.result_content as string, earlier, taken.get(ev.event_kind) ?? new Set());
      if (span) { hit = { capture: c, span }; break; }
    }
    if (!hit) { c.still_pending += 1; continue; }
    taken.set(ev.event_kind, new Set([...(taken.get(ev.event_kind) ?? []), hit.span.toLowerCase()]));
    if (input.dry) { c.resolved += 1; continue; }
    const w = await sb.from("item_forward_events").update({ resolved_at: deps.now().toISOString(), resolved_capture_id: hit.capture.id, resolved_span: hit.span }).eq("id", ev.id).is("resolved_at", null);
    if (w.error) { c.write_failures += 1; notes.push(`event ${ev.id}: resolution not written: ${w.error.message}`); continue; }
    c.resolved += 1;
    resolved.push(ev.id);
  }
  if (input.dry) notes.push("dry: nothing written");
  return { ...runResult(c.write_failures ? "partial" : "ok", c, notes), data: { ids: { resolved_event_ids: resolved } } };
}
