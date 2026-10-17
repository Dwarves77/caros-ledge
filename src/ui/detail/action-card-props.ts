// Ported from old_repo/src/lib/detail/action-card-common-props.tsx (lines 17-57)
// The ActionCard props every detail surface shares: the export state, the exposure cells that need no caller (who pays from the cost mechanism, the timeline) and the share handler. The tag
// popover, the watch control and the overflow are the caller's nodes. "Your lanes" is stated as an absence: the system stores no customer data (ADR-042).
import type { ReactNode } from "react";

import type { Resource } from "@/core/types";

import { shareResource } from "../actions";

export function commonActionCardProps(r: Resource, parts: { tagPopover: ReactNode; watch: ReactNode; onTag: () => void }) {
  return {
    tagPopover: parts.tagPopover,
    watch: parts.watch,
    onTag: parts.onTag,
    onShare: () => void shareResource(r),
    exportDisabled: !(r.fullBrief || r.url),
    whoPays: { value: r.costMechanism || null },
    yourLanes: { value: null, absenceReason: "not in primary source" as const },
    timeline: r.timeline,
  };
}
