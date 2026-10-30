"use client";

// Ported from old_repo/src/components/regulations/OwnerTeamCard.tsx (lines 29-174)
// Owner and team: one assignee chosen from the workspace roster, and the item's last-verified date. The select is the kit's 44 px control. A user with no workspace has no roster and no owner to
// choose: that is not a failure (the old card printed "Roster unavailable" for them); a roster that failed to load says so.
import { formatDate } from "@/core/shared";
import { useBootstrapStore } from "@/ui/shell/use-bootstrap";
import { RailCard, Select, SectionLabel } from "@/ui";
import { useItemStateStore } from "@/features/workspace/state";

export function OwnerCard({ itemId, assigneeName, lastVerifiedDate, hasWorkspace }: { itemId: string; assigneeName: string | null; lastVerifiedDate: string | null; hasWorkspace: boolean }) {
  const override = useItemStateStore((s) => s.overrides.get(itemId));
  const setOwner = useItemStateStore((s) => s.setOwner);
  const members = useBootstrapStore((s) => s.data?.members ?? null);
  const status = useBootstrapStore((s) => s.status);
  const ownerUserId = override?.ownerUserId ?? null;
  const ownerName = override ? (override.ownerName ?? null) : assigneeName;
  const rosterFailed = hasWorkspace && (status === "failed" || (status === "ready" && members === null));
  const value = ownerUserId && (members ?? []).some((m) => m.user_id === ownerUserId) ? ownerUserId : "";
  const last = lastVerifiedDate ? formatDate(lastVerifiedDate) : null;
  return (
    <RailCard title="Owner & team" dataAudit="owner-rail">
      <SectionLabel>Assignee</SectionLabel>
      {members === null ? (
        <p style={{ fontSize: "var(--fs-13)", fontWeight: 700, margin: "var(--sp-1) 0 var(--sp-2)", color: ownerName ? "var(--ink)" : "var(--ink-3)" }}>
          {ownerName || "Unassigned"}
          {rosterFailed && <span role="alert" data-part="state-note" style={{ display: "block", fontSize: "var(--fs-105)", fontWeight: 600, color: "var(--ink-3)", marginTop: "var(--sp-1)" }}>The roster did not load, so assignment is off for now. Reload the page to try again.</span>}
        </p>
      ) : (
        <div style={{ margin: "var(--sp-1) 0 var(--sp-2)" }}>
          <Select
            aria-label="Assign owner"
            value={value}
            onChange={(e) => {
              const m = members.find((x) => x.user_id === e.target.value);
              void setOwner(itemId, m ? m.user_id : null, m ? m.display_name : null);
            }}
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.display_name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <SectionLabel>Last verified</SectionLabel>
      <p style={{ fontSize: "var(--fs-125)", fontWeight: 600, margin: "var(--sp-1) 0 0", color: last ? "var(--ink)" : "var(--ink-3)" }}>{last ?? "Not recorded"}</p>
    </RailCard>
  );
}
