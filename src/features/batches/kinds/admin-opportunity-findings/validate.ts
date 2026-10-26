// New in DIGEST-1 PR B (scripts/ci/new-files/digest-1b.txt): the admin finding validator, split from apply.ts so the kind registry names it (kinds.json). One entry against its pattern's packet: the refusals (a malformed or out-of-packet value) and the residue (the single-source test, the second reader).
import { isVerbatim } from "@/core/contracts/verbatim";
import { LENSES, WINDOWS } from "@/core/digest/kinds";
import { citableIds, uncitedIds } from "@/core/digest/packets";
import type { Packet, PacketMember } from "@/core/digest/packets-client";
import { review, singleSourceReason } from "@/core/digest/review";

import { isObj, nonEmpty, type Obj } from "../../kit/session-batch";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CITATION = /\[([a-z_]+:[^\]\s]+)\]/g;
const TOKENS = ["CONFIRMED", "HYPOTHESIS", "REFUTED"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export interface AdminLive { packets: Map<string, Packet>; current: Map<string, { id: string; title: string; sourced_finding_md: string }> }
export interface AdminPlan { packet: Packet; entry: Obj; items: string[]; score: number; reasons: string; reviewer: string }

/** One entry against its pattern's packet: the refusals (a malformed or out-of-packet value) and the residue (the single-source test, the second reader). */
export function validateAdminFindingEntry(e: unknown, i: number, live: AdminLive): { errors: string[]; residue?: string[]; plan?: AdminPlan } {
  if (!isObj(e)) return { errors: [`entries[${i}]: must be an object`] };
  const tag = `pattern ${String(e.pattern_value_id)}`;
  const errors: string[] = [];
  const at = (m: string) => void errors.push(`${tag}: ${m}`);
  if (typeof e.pattern_value_id !== "string" || !UUID.test(e.pattern_value_id)) return { errors: [`${tag}: pattern_value_id must be a UUID`] };
  const packet = live.packets.get(e.pattern_value_id);
  if (!packet) return { errors: [`${tag}: no packet for this pattern (the pattern is not exported or has no live packet); a finding cites nothing outside its packet`] };
  const members: PacketMember[] = packet.members;
  const rows = new Map(members.map((m) => [`${m.table}:${m.id}`, m]));
  if (!(LENSES as readonly unknown[]).includes(e.lens)) at(`lens must be one of ${LENSES.join(", ")}`);
  if (!(WINDOWS as readonly unknown[]).includes(e.window)) at(`window must be one of ${WINDOWS.join(", ")}`);
  if (!nonEmpty(e.title) || e.title.length > 160) at("title must be 1 to 160 characters");
  const finding = typeof e.sourced_finding_md === "string" ? e.sourced_finding_md : "";
  if (!finding.trim()) at("sourced_finding_md must be non-empty");
  const cited = new Set<string>();
  for (const m of finding.matchAll(CITATION)) { const id = m[1] as string; if (rows.has(id)) cited.add(id); else at(`cites ${id}, which is not a row of the packet`); }
  if (finding.trim() && !cited.size) at("the sourced finding cites no packet row ([table:id])");
  (Array.isArray(e.inferences) ? e.inferences : []).forEach((x, k) => {
    if (!isObj(x) || !nonEmpty(x.text) || !TOKENS.includes(x.status_token as string) || !Array.isArray(x.basis) || !x.basis.length) return at(`inferences[${k}] must be { text, status_token (${TOKENS.join(", ")}), basis: [packet rows] }`);
    for (const b of x.basis) if (typeof b !== "string" || !rows.has(b)) at(`inferences[${k}] basis ${JSON.stringify(b)} is not a row of the packet`); else cited.add(b);
  });
  const signposts = Array.isArray(e.signposts) ? e.signposts : [];
  if (!signposts.length) at("a finding carries at least one falsifiable signpost");
  signposts.forEach((s, k) => { if (!isObj(s) || !nonEmpty(s.claim_text) || !nonEmpty(s.falsification_condition) || typeof s.by !== "string" || !ISO.test(s.by)) at(`signposts[${k}] must be { claim_text, falsification_condition, by (ISO date) }`); });
  (Array.isArray(e.claim_provenance) ? e.claim_provenance : []).forEach((c, k) => {
    const m = isObj(c) && typeof c.row === "string" ? rows.get(c.row) : undefined;
    if (!isObj(c) || !m) return at(`claim_provenance[${k}] row ${JSON.stringify(isObj(c) ? c.row : c)} is not a row of the packet`);
    if (!isVerbatim(m.text, typeof c.span === "string" ? c.span : "")) at(`claim_provenance[${k}] span is not verbatim in the packet row ${String(c.row)}`); else cited.add(String(c.row));
  });
  const outside = uncitedIds(packet, [...cited].map((k) => rows.get(k)?.id ?? k));
  if (outside.length) at(`cites ${outside.join(", ")} outside its packet (INV-CN2-4); the packet offers ${citableIds(packet).size} ids`);
  if (errors.length) return { errors };
  const why = [...[singleSourceReason([...cited].map((id) => ({ table: (rows.get(id) as { table: string }).table, surface: rows.get(id)?.surface ?? null })))].flatMap((r) => r ?? []), ...review("admin-opportunity-findings", e).reasons.map((r) => `second reader: ${r}`)];
  if (why.length) return { errors: [], residue: why.map((r) => `${tag}: ${r}`) };
  const rv = review("admin-opportunity-findings", e);
  const prior = live.current.get(e.pattern_value_id);
  if (prior && prior.title === e.title && prior.sourced_finding_md === finding) return { errors: [] };
  const items = [...new Set([...cited].flatMap((id) => rows.get(id)?.item_id ?? (rows.get(id)?.table === "intelligence_items" ? [rows.get(id)?.id as string] : [])))];
  return { errors: [], plan: { packet, entry: e, items, score: rv.score, reasons: `${rv.required.length} required judges passed`, reviewer: rv.reviewed_by ?? "none" } };
}
