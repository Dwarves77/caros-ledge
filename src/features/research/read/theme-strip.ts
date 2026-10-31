// Ported from old_repo/src/components/shell/ThemeStrip.tsx (lines 1-9)
// The theme strip of a list page: the shared cross-page read's chips for one surface, at most six. A failed read is a failed strip (the page says so with Retry), never an absent one.
import type { Db } from "@/core/db";
import { readThemeChips } from "@/core/detail";
import { log } from "@/core/shared/log";
import { radarClients, readFlywheelRadar, type RadarView } from "@/features/flywheel/radar/read";
import type { ThemeChip } from "@/ui/list-surface";

export async function readThemeStrip(db: Db, surface: string): Promise<{ chips: ThemeChip[]; failed: boolean; radar: RadarView | null }> {
  const radar = await readFlywheelRadar(radarClients(db), { kind: "surface", surface }).catch((e: unknown) => (log.warn("[radar] the read failed:", e instanceof Error ? e.message : String(e)), null));
  try {
    return { chips: await readThemeChips(db, { surface, max: 6 }), failed: false, radar };
  } catch (e) {
    log.warn("[theme-strip] the read failed:", e instanceof Error ? e.message : String(e));
    return { chips: [], failed: true, radar };
  }
}
