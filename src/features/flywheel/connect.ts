// Ported from old_repo/src/lib/intake/flywheel-steps.mjs (lines 27-107)
// Ported from old_repo/src/lib/intake/mint-enrichment.ts (lines 33-64)
// The four flywheel steps a mint and a substantive update call (CLAUDE.md rule 17), as the ConnectDeps object P2-04 and P2-05 take. Each step is the one
// writer of its table and throws on a failed write, so the caller (flywheel-participation) records the failure as a rule-16(d) defect flag and the run
// is partial, never silently fine. The clock is the one injected at construction (the composition root, P2-08, passes its own).
import type { Db } from "@/core/db";
import { linkItemEntities } from "@/core/entities/link-entities";
import { linkItems } from "@/core/entities/link-items";
import { deriveObligationObjects } from "@/features/obligations/derive/derive-objects";
import { deriveRegister } from "@/features/obligations/derive/derive-register";
import { syncComplianceDeadline } from "@/features/obligations/derive/compliance-deadline";
import { readAndExtractForwardEvents } from "@/features/obligations/extract/verbatim-in-source";
import { insertForwardEvents } from "@/features/obligations/extract/write-forward-events";
import type { ConnectDeps } from "@/features/intake";

import { runConnectionDiscovery } from "./run-discovery";
import { tagPass } from "./tag-pass";

/** Build the ConnectDeps for a database handle and a clock. */
export function createConnectDeps(opts: { getDb: () => Db; now: () => Date }): ConnectDeps {
  return {
    async connect(itemId) {
      const sb = opts.getDb();
      const tags = await tagPass({ sb, now: opts.now }, { ids: [itemId], dry: false, discover: false });
      if (tags.outcome === "failed") throw new Error(`tag pass failed for ${itemId}: ${tags.notes.join("; ")}`);
      const d = await runConnectionDiscovery({ sb }, itemId);
      if (d.missing) throw new Error(`connection discovery: item ${itemId} does not exist`);
      if (d.write && d.write.failedChunks > 0) throw new Error(`connection discovery wrote with ${d.write.failedChunks} failed chunk(s) for ${itemId}: ${d.write.notes.join("; ")}`);
      if (tags.outcome === "partial") throw new Error(`tag pass was partial for ${itemId}: ${tags.notes.join("; ")}`);
      return { written: d.write?.written ?? 0 };
    },
    async extractAndInsertForwardEvents(itemId) {
      const sb = opts.getDb();
      const now = opts.now();
      const r = await readAndExtractForwardEvents(sb, itemId, now);
      const w = await insertForwardEvents(sb, itemId, r.events, { claimIds: new Set(r.claims.map((c) => c.claim_id)), sectionIds: new Set(r.sections.map((s) => s.section_id)) });
      const sync = await syncComplianceDeadline(sb, itemId, now.toISOString().slice(0, 10));
      return { attempted: w.attempted, inserted: w.inserted, collision: w.collision, staleIds: w.staleIds, complianceDeadline: { changed: sync.changed, value: sync.changed ? sync.value : null } };
    },
    async deriveObligations(itemId) {
      const sb = opts.getDb();
      const reg = await deriveRegister(sb, { dry: false, itemIds: [itemId] });
      if (reg.outcome !== "ok") throw new Error(`obligation register derivation ${reg.outcome} for ${itemId}: ${reg.notes.join("; ")}`);
      const objects = await deriveObligationObjects(sb, { dry: false, itemIds: [itemId] });
      if (objects.outcome !== "ok") throw new Error(`obligation object derivation ${objects.outcome} for ${itemId}: ${objects.notes.join("; ")}`);
      await syncComplianceDeadline(sb, itemId, opts.now().toISOString().slice(0, 10));
      return { derived: (reg.counts.inserted ?? 0) + (objects.counts.inserted ?? 0) };
    },
    async linkEntities(itemId) {
      const sb = opts.getDb();
      const { data, error } = await sb.from("intelligence_items").select("id, jurisdiction_iso, canonical_instrument_key").eq("id", itemId).maybeSingle();
      if (error) throw new Error(`link entities: item read failed: ${error.message}`);
      if (!data) throw new Error(`link entities: item ${itemId} does not exist`);
      const spine = await linkItemEntities(sb, data as { id: string; jurisdiction_iso: string[] | null; canonical_instrument_key: string | null }, { now: opts.now() });
      const lineage = await linkItems(sb, itemId);
      if (lineage.failed > 0) throw new Error(`lineage link wrote with ${lineage.failed} failure(s) for ${itemId}: ${lineage.notes.join("; ")}`);
      return { refs: spine.refs + lineage.edges, ...(spine.instrumentEntityId ? { instrumentEntityId: spine.instrumentEntityId } : {}) };
    },
  };
}

