import { isMissingObject, type Db } from "@/core/db";

import type { HostVerdictRef } from "./host-class";
import { isKnownHostClass } from "./tier-contract";

const PAGE = 1000;

/**
 * The committed host verdicts (host_verdicts, migration 0042) as the map placeHostWithVerdicts reads. A verdict whose class the tier contract no longer carries is dropped with a note: it mints no tier the table lacks.
 * The table absent (production before the cutover) is an empty map with a note, the class table still places hosts and nothing invents a verdict; any other failed read is an empty map with the failure in the note,
 * never a partial map passed off as the whole.
 */
/** The verdicts, and whether the read failed (an absent table or a failed page): a caller keeps a good read for the life of its deps and reads again after a failed one. */
export interface HostVerdictsRead {
  verdicts: ReadonlyMap<string, HostVerdictRef>;
  failed: boolean;
}
export async function loadHostVerdicts(sb: Db, notes: string[] = []): Promise<HostVerdictsRead> {
  const out = new Map<string, HostVerdictRef>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from("host_verdicts").select("host, class, batch_id").order("host", { ascending: true }).range(from, from + PAGE - 1);
    if (error) {
      notes.push(isMissingObject(error) ? "host_verdicts is absent (migration 0042 is not applied): no committed host verdict applies this run, the class table still places hosts" : `host_verdicts could not be read, no committed host verdict applies this run: ${error.message}`);
      return { verdicts: new Map(), failed: true };
    }
    for (const r of (data ?? []) as { host: string; class: string; batch_id: string | null }[]) {
      if (isKnownHostClass(r.class)) out.set(r.host, { class: r.class, ...(r.batch_id ? { batch: r.batch_id } : {}) });
      else notes.push(`host verdict for ${r.host} names class ${r.class}, which the class table no longer carries: ignored`);
    }
    if ((data ?? []).length < PAGE) return { verdicts: out, failed: false };
  }
}
