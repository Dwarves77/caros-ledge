// Ported from old_repo/src/lib/sources/vertical-fit-gate.ts (lines 1-54)
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import { hostOf } from "@/core/shared";
import { classifyInstitutionalType, isOffVerticalByIdentity, type SourceRole } from "@/core/sources/classify";

export interface VerticalFitGateResult {
  allow: boolean;
  reason: string;
  /** Soft signal: classified as a general-legislature portal (kept by default; informational). */
  flaggedLegislature: boolean;
}

/**
 * Gate a would-be new source against the off-vertical negative list (hosts deliberately retired as off-vertical, suspended not deleted). The list is read whole
 * (paginated, total order). An unattended caller (the default) fails CLOSED on a read error; an operator-attended caller may pass `failOpen`.
 */
export async function checkVerticalFitGate(db: Db, source: { name?: string | null | undefined; url?: string | null | undefined; sourceRole?: SourceRole | null | undefined }, opts: { failOpen?: boolean } = {}): Promise<VerticalFitGateResult> {
  const flaggedLegislature = isOffVerticalByIdentity(classifyInstitutionalType(source.name, source.sourceRole));
  const host = hostOf(source.url);
  if (!host) return { allow: true, reason: "no parseable host: nothing to gate", flaggedLegislature };
  let rows: Array<{ url: string }>;
  try {
    rows = await fetchAllRows<{ url: string }>((from, to) => db.from("sources").select("url").eq("status", "suspended").ilike("notes", "%off_vertical_suspended%").order("id", { ascending: true }).range(from, to) as never, { cap: 100_000 });
  } catch (e) {
    const reason = `negative-list check unavailable (${(e as Error).message})`;
    return { allow: opts.failOpen === true, reason, flaggedLegislature };
  }
  if (rows.some((r) => hostOf(r.url) === host)) return { allow: false, reason: `host "${host}" is on the off-vertical negative list (deliberately retired as off-vertical); re-add requires an explicit operator decision`, flaggedLegislature };
  return { allow: true, reason: "not on off-vertical negative list", flaggedLegislature };
}
