// Ported from old_repo/src/app/community/directory/page.tsx (lines 32-134)
// /community/directory: the peer-organisation aggregates. The numbers come from one SQL aggregate over the Community profile with the k = 5 floor applied inside it (community_directory_counts), on the caller's own client:
// no service-role read of every profile on every view. Where the aggregate is unavailable (production before the cutover) the page says so with Retry, and the rest of the page still draws.
import { log } from "@/core/shared/log";
import { ALL_SECTORS } from "@/core/workspace/vocabulary";

import { kAnonymity, K_ANONYMITY_FLOOR } from "../lib/antitrust";
import type { DirectoryCell } from "../ui/PeerOrgDirectory";

import { communityPage } from "./frame";
import { DirectoryScreen } from "./screens";

const SECTOR_LABELS = new Map(ALL_SECTORS.map((s) => [s.id, s.label] as const));

export async function DirectoryPage() {
  return communityPage("/community/directory", "The directory", async ({ db }) => {
    const { data, error } = await db.rpc("community_directory_counts");
    if (error) log.warn("[community] the directory aggregate is unavailable:", error.message);
    // The database withholds a cell under the floor; the page refuses one too (a floor held in one place only is a floor one migration from gone).
    const cells = error ? null : ((data ?? []) as Array<Omit<DirectoryCell, "members" | "verified_members"> & { members: number | string; verified_members: number | string }>).map((c) => ({ ...c, members: Number(c.members), verified_members: Number(c.verified_members) })).filter((c) => c.members >= K_ANONYMITY_FLOOR && kAnonymity(Array.from({ length: c.members }, (_, i) => String(i))).satisfied);
    return <DirectoryScreen cells={cells} sectorLabels={SECTOR_LABELS} />;
  });
}
