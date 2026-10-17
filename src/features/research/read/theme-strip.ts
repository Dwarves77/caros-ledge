// Ported from old_repo/src/components/shell/ThemeStrip.tsx (lines 1-9)
// The theme strip of a list page: the shared cross-page read's chips for one surface, at most six. A failed read is a failed strip (the page says so with Retry), never an absent one.
import type { Db } from "@/core/db";
import { readThemeChips } from "@/core/detail";
import { log } from "@/core/shared/log";
import type { ThemeChip } from "@/ui/list-surface";

export async function readThemeStrip(db: Db, surface: string): Promise<{ chips: ThemeChip[]; failed: boolean }> {
  try {
    return { chips: await readThemeChips(db, { surface, max: 6 }), failed: false };
  } catch (e) {
    log.warn("[theme-strip] the read failed:", e instanceof Error ? e.message : String(e));
    return { chips: [], failed: true };
  }
}
