// Ported from old_repo/src/lib/portfolio/read.ts (lines 37-172)
// Ported from old_repo/src/lib/portfolio/portfolio-core.mjs (lines 242-291)
// The held read behind a portfolio's roll-ups: the members that are verified, not archived by the platform and not archived by THIS workspace, as the same rows the dashboard draws. A member this read does
// not return stays a member, counted in the denominator and named in `notHeld`, and is left out of every figure. A failed read rejects: it never makes an archived member look held (B-0280).
import type { Db } from "@/core/db";
import { canonicalSurface, dueInfo, toListRowFields } from "@/core/lists";
import { enrichSources, mapRows } from "@/features/lists";
import { readItemRows } from "@/features/dashboard/read/items";
import type { HeldRow } from "@/features/workspace/portfolio/types";

/** The member items among `uuids` that the platform holds for this workspace: the workspace's own rows (its priority and its archive already applied by the database). */
export async function readHeld(db: Db, orgId: string, uuids: readonly string[], now: Date): Promise<HeldRow[]> {
  const mapped = await mapRows(db, await readItemRows(db, orgId, uuids), { orgId });
  await enrichSources(db, mapped.active, { biasTags: true });
  return mapped.active.map((r): HeldRow => ({ uiId: r.id, title: r.title, priority: r.priority ?? null, surface: canonicalSurface(r), dueDays: dueInfo(r, now)?.daysNum ?? null, fields: toListRowFields(r, now) as unknown as Record<string, unknown> }));
}
