// Ported from old_repo/src/lib/detail/action-card-common-props.tsx (lines 17-57)
// The ActionCard props every detail surface shares: the export state, the exposure cells that need no caller (who pays from the cost mechanism, the timeline) and the share handler. The tag
// popover, the watch control and the overflow are the caller's nodes. "Your lanes" is stated as an absence: the system stores no customer data (ADR-042).
import type { ReactNode } from "react";

import type { Resource } from "@/core/types";

import { shareResource } from "../actions";

export function commonActionCardProps(r: Resource, parts: { tagPopover: ReactNode; watch: ReactNode; onTag: () => void }) {
  // Derive whoPays from costMechanism or whoIsBound/topic/type
  let whoPaysVal: string | null = r.costMechanism || null;
  if (!whoPaysVal) {
    const ext = r as unknown as { whoIsBound?: string[] | string | null; complianceObjectTags?: string[] | null };
    const bound = ext.whoIsBound || ext.complianceObjectTags;
    if (bound) {
      if (Array.isArray(bound) && bound.length > 0) {
        whoPaysVal = `Obligated: ${bound.map((s) => s.replace(/-/g, " ")).join(", ")}`;
      } else if (typeof bound === "string" && bound.trim()) {
        whoPaysVal = `Obligated: ${bound.trim()}`;
      }
    } else if (r.topic && r.type) {
      whoPaysVal = `${r.type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())} targeting ${r.topic} duty holders`;
    } else if (r.topic) {
      whoPaysVal = `Duty holders in ${r.topic}`;
    }
  }

  if (whoPaysVal) {
    whoPaysVal = whoPaysVal.trim().replace(/\s+[a-zA-Z]{1,10}(?:\.{3}|…)$/, "…");
  }
  const modeStr = r.modes && r.modes.length > 0 ? r.modes.map((m) => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()).join(", ") : null;
  const jurisStr = r.jurisdiction || (r.jurisdictionIso && r.jurisdictionIso.length > 0 ? r.jurisdictionIso.join(", ") : null);
  const lanesVal = [jurisStr, modeStr].filter(Boolean).join(" · ") || null;

  return {
    tagPopover: parts.tagPopover,
    watch: parts.watch,
    onTag: parts.onTag,
    onShare: () => void shareResource(r),
    exportDisabled: !(r.fullBrief || r.url),
    whoPays: whoPaysVal ? { value: whoPaysVal } : { value: null, absenceReason: "pending" as const },
    yourLanes: lanesVal ? { value: lanesVal } : { value: null, absenceReason: "connect data" as const },
    timeline: r.timeline,
  };
}
