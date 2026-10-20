"use client";

// New in R2d: the Watch control of a detail page and of a Regulations row, LIVE (register surfaces:1 and 38). The kit's ItemWatch reads a context nothing provides, so on every detail page it was a permanently
// disabled "Watch"; this reads the one membership store the list rows read (features/watchlist/watch-store). While the membership read is under way the control is disabled and says nothing wrong; when that read
// FAILED it is replaced by a stated failure with Retry, never a dead control that looks like an unwatched item.
import { refusalSentence } from "@/core/http/failure";
import { useWatchMembership } from "@/features/watchlist/membership";
import { loadMembership, useWatchStore } from "@/features/watchlist/watch-store";
import type { WatchlistItemType } from "@/features/watchlist/links";
import { StateNote } from "@/ui";
import { WatchToggle } from "@/ui/WatchToggle";

export function DetailWatch({ type, id }: { type: WatchlistItemType; id: string }) {
  const m = useWatchMembership(type, id);
  // The hook above subscribes to this type's slice, so the component renders again when the read settles; the status is read from the store itself (server render included).
  if (useWatchStore.getState().byType[type]?.status === "failed") {
    return (
      <StateNote tone="error" action={{ label: "Retry", onClick: () => void loadMembership(type) }}>
        {refusalSentence("watch_status_unavailable")}
      </StateNote>
    );
  }
  return <WatchToggle variant={m.teamOnly ? "default" : "row"} {...m} />;
}
