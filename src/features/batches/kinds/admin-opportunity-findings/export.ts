// The admin kind's export (DIGEST-1 D1): the derived patterns of the window that no current finding answers, grouped by the three lenses of HOW-TO-LOOK point 5 (mandated supply-demand bottlenecks; penalty-versus-abatement
// crossover; commercial capital, offtake and grant telemetry). A P2, P3 or P5 pattern is in on its method; a P1 or P4 pattern is in only when its packet holds a capital or capacity entity (the kind's memberLens). The reader sees the
// pattern's packet (read through the packets door; a P1 or P4 pattern with no packet is named residue, never guessed into a lens). The findings it authors are stored behind the platform-admin gate.
import type { Db } from "@/core/db";
import { allRows } from "@/core/db";
import { digestKind, LENSES, WINDOWS } from "@/core/digest/kinds";
import { packetReader, type Packet, type PacketReader } from "@/core/digest/packets-client";
import { secondReaderBlock } from "@/core/digest/review";

import { candidateMenu, menuBlock, packetSeed } from "../item-briefs/candidates";
import type { BatchExport, Obj } from "../../kit/session-batch";

type Lens = (typeof LENSES)[number];
interface PatternRow { value_id: string; method_id: string; method_version: string; entity_id: string | null; derivation: string; admissibility: string; lifecycle: string; base_confidence: number; asserted_at: string }
const COLUMNS = "value_id, method_id, method_version, entity_id, derivation, admissibility, lifecycle, base_confidence, asserted_at";
const SPENT = new Set(["superseded", "obsolete", "falsified"]);
const LENS_DEFINITIONS: Readonly<Record<Lens, string>> = {
  supply_demand_bottleneck: "Mandated supply-demand bottlenecks: a locked statutory demand ratchet against physical capacity (feedstock, grid, fleet, port) that cannot meet it on the date.",
  penalty_abatement_crossover: "Penalty versus abatement: where the statutory penalty per tonne crosses or nears the abatement cost of a technology or fuel that is ready (TRL 8 or above).",
  capital_offtake_grant: "Commercial capital, offtake and grant telemetry: filings, offtakes, capex and public grants that show where capital is forced to flow next, months before the market.",
};

export function adminFindingsExporter(sb: Db, now: () => Date, packets: PacketReader = packetReader(sb)) {
  return async (o: { limit: number; ids?: readonly string[] }): Promise<BatchExport> => {
    try {
      const cfg = digestKind("admin-opportunity-findings");
      if (!cfg?.lensOfMethod || !cfg.memberLens || !cfg.windowDays) throw new Error("the admin kind lacks its lensOfMethod, memberLens or windowDays");
      const since = new Date(now().getTime() - cfg.windowDays * 86_400_000).toISOString();
      const methods = [...Object.keys(cfg.lensOfMethod), ...(cfg.conditionalMethods ?? [])];
      const rows = (await allRows<PatternRow>(sb, "derived_values", COLUMNS, { order: "value_id", where: (q) => q.in("method_id", methods).neq("admissibility", "stale").is("invalidated_at", null).gte("asserted_at", since) })).filter((r) => !SPENT.has(r.lifecycle));
      const answered = new Set((await allRows<{ pattern_value_id: string }>(sb, "admin_opportunity_findings", "pattern_value_id", { where: (q) => q.is("superseded_by", null) })).map((f) => f.pattern_value_id));
      const wanted = o.ids?.length ? new Set(o.ids) : null;
      const pending = rows.filter((r) => (wanted ? wanted.has(r.value_id) : !answered.has(r.value_id))).sort((a, b) => a.asserted_at.localeCompare(b.asserted_at));
      const packetRead = await packets(pending.map((r) => r.value_id));
      const residue: Obj[] = [];
      const items: Obj[] = [];
      for (const r of pending) {
        const packets: Packet[] = packetRead.packets.filter((p) => p.id === r.value_id);
        const fixed = cfg.lensOfMethod[r.method_id];
        const byMember = packets.flatMap((p) => p.members.map((m) => (m.entity_kind ? cfg.memberLens?.[m.entity_kind] : undefined))).find((l): l is Lens => !!l);
        const lens = fixed ?? byMember;
        if (!lens) residue.push({ id: r.value_id, method_id: r.method_id, reason: packets.length ? "no capital or capacity entity is a member of the packet" : packetRead.marker ?? "no packet" });
        else items.push({ pattern_value_id: r.value_id, lens, method_id: r.method_id, method_version: r.method_version, entity_id: r.entity_id, derivation: r.derivation, admissibility: r.admissibility, lifecycle: r.lifecycle, base_confidence: r.base_confidence, created_at: r.asserted_at, packets, candidate_entities: menuBlock(await candidateMenu(sb, await packetSeed(sb, packets))) });
      }
      const byLens = (l: Lens) => items.filter((i) => i.lens === l);
      const ordered = LENSES.flatMap(byLens).slice(0, o.limit);
      return { ok: true, items: ordered, source: { type: "table", table: "derived_values" }, summary: { second_reader: secondReaderBlock("admin-opportunity-findings"), window_days: cfg.windowDays, patterns_in_window: rows.length, already_answered: rows.filter((r) => answered.has(r.value_id)).length, exported: ordered.length, windows: WINDOWS, per_lens: Object.fromEntries(LENSES.map((l) => [l, byLens(l).length])), lens_definitions: LENS_DEFINITIONS, packets: packetRead.marker ?? "read" }, residue };
    } catch (e) {
      return { ok: false, items: [], error: (e as Error).message };
    }
  };
}
