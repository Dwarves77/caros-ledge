// Ported from old_repo/src/components/community/PeerOrgDirectoryTable.tsx (lines 1-142)
// The peer-organisation directory: counts by organisation type and region, and by sector. A cell is drawn only when it holds at least five distinct organisations (the database withholds smaller ones), so a row never
// names one member; the page says so. A failed read is a stated failure with Retry, never "0 members counted".
import { formatNumber } from "@/core/shared";
import { EmptyState, RowTable } from "@/ui";

import { ORG_TYPE_LABELS, regionLabel } from "../lib/labels";

import styles from "./community.module.css";
import { RailRetry } from "./RailRetry";

export interface DirectoryCell {
  dimension: "org_region" | "sector";
  org_type: string;
  region: string;
  sector: string;
  members: number;
  verified_members: number;
}

export function PeerOrgDirectory({ cells, sectorLabels }: { cells: DirectoryCell[] | null; sectorLabels: ReadonlyMap<string, string> }) {
  if (cells === null) return <RailRetry>The directory could not be loaded.</RailRetry>;
  const orgRegion = cells.filter((c) => c.dimension === "org_region");
  const sectors = cells.filter((c) => c.dimension === "sector");
  if (cells.length === 0) return <EmptyState>No group of five or more organisations has declared a profile yet, so nothing is shown. Counts appear here as more organisations join.</EmptyState>;
  return (
    <div className={styles.stack}>
      <p className={styles.muted}>Counts only: organisation type, region and sector. Never a name, never a company. A group appears once it holds at least five distinct organisations.</p>
      <RowTable
        columns={[{ label: "Organisation type", width: "minmax(0,1fr)" }, { label: "Region", width: "minmax(0,1fr)" }, { label: "Members", width: "96px" }, { label: "Verified", width: "96px" }]}
        rows={orgRegion.map((c) => ({ key: `${c.org_type}-${c.region}`, cells: [ORG_TYPE_LABELS[c.org_type] ?? c.org_type, c.region ? regionLabel(c.region) : "Not stated", formatNumber(c.members), formatNumber(c.verified_members)] }))}
      />
      {sectors.length > 0 && (
        <RowTable
          columns={[{ label: "Sector", width: "minmax(0,1fr)" }, { label: "Members", width: "96px" }, { label: "Verified", width: "96px" }]}
          rows={sectors.map((c) => ({ key: c.sector, cells: [sectorLabels.get(c.sector) ?? c.sector, formatNumber(c.members), formatNumber(c.verified_members)] }))}
        />
      )}
    </div>
  );
}
