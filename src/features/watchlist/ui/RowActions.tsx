"use client";

// Ported from old_repo/src/components/regulations/PriorityDropdown.tsx (lines 1-60)
// Ported from old_repo/src/components/ui/WatchButton.tsx (lines 412-448)
import { refusalSentence } from "@/core/http/failure";
import { Menu, StateNote } from "@/ui";
import type { MenuItem } from "@/ui/Menu";
import { WatchToggle } from "@/ui/WatchToggle";

import { useWatchMembership } from "../membership";
import type { WatchlistItemType } from "../links";
import { loadMembership, useWatchStore } from "../watch-store";

/** The Watch control for one item, as the menu row (a series, which only the workspace watches, shows the team control alone). */
export function RowWatch({ type, id }: { type: WatchlistItemType; id: string }) {
  const m = useWatchMembership(type, id);
  if (useWatchStore.getState().byType[type]?.status === "failed") return <StateNote tone="error" action={{ label: "Retry", onClick: () => void loadMembership(type) }}>{refusalSentence("watch_status_unavailable")}</StateNote>;
  return <WatchToggle variant={m.teamOnly ? "default" : "row"} {...m} />;
}

/** THE row overflow: one 44 px menu at the end of the row, holding the Watch toggle and any actions of the surface. The Watch toggle lives here and nowhere else on the row, never a second star. */
export function RowActions({ title, type, id, items = [] }: { title: string; type: WatchlistItemType; id: string; items?: MenuItem[] }) {
  return <Menu label={`Actions for ${title}`} items={items} extra={<RowWatch type={type} id={id} />} />;
}
