"use client";

// Ported from old_repo/src/components/community/CommunityRegionTabs.tsx (lines 30-118)
// The region strip on the group directory: one link per region with its group count, the active one marked. It filters (it writes ?region=), so it is drawn only where a page reads it; each tab is 44 px (the kit's tab row).
import { formatNumber } from "@/core/shared";
import { TabRow } from "@/ui";

import { REGION_CODES, regionLabel } from "../lib/labels";

export function RegionTabs({ counts, active }: { counts: Record<string, number>; active: string }) {
  return <TabRow ariaLabel="Region" tabs={REGION_CODES.map((code) => ({ key: code, label: `${regionLabel(code)} ${formatNumber(counts[code] ?? 0)}`, active: code === active, href: `/community/browse?region=${code}` }))} />;
}
