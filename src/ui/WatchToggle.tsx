"use client";

// Ported from old_repo/src/components/ui/WatchButton.tsx (lines 165-217)
// Ported from old_repo/src/components/ui/WatchButton.tsx (lines 228-280)
// Ported from old_repo/src/components/ui/WatchButton.tsx (lines 331-361)
// Ported from old_repo/src/components/ui/WatchButton.tsx (lines 412-529)
import { useState } from "react";

import { Button } from "./Button";

export type WatchScope = "personal" | "team";

export interface WatchToggleProps {
  variant?: "default" | "row" | "icon";
  watched: boolean;
  teamWatched?: boolean;
  /** The workspace has a team watchlist this reader may write to (the feature computes it from the role and the item type). */
  teamAvailable?: boolean;
  /** Item types that only the team list holds (no personal watching). */
  teamOnly?: boolean;
  /** True while the membership read has not answered: the control is disabled, never shown as unwatched. */
  loaded: boolean;
  /** The last personal / team save failed (the toggle was reverted). */
  failed?: boolean;
  teamFailed?: boolean;
  onToggle: (scope: WatchScope) => void;
}

/** Every string the toggle shows or titles, in one table. */
const WATCH_COPY = {
  failed: "Save failed. Click to retry.",
  watching: "Watching. Click to unwatch.",
  idle: "Watch this item on your dashboard watchlist",
  teamOn: "On the workspace watchlist: every member sees this. Click to remove it for everyone.",
  teamSole: "Watch on the workspace watchlist: every member sees it. Personal watching is not available for this item.",
  teamIdle: "Add to the workspace watchlist so every member sees it",
  teamBlocked: "Watching this item needs a workspace role that can write to the team watchlist",
} as const;

const titleFor = (watched: boolean, failed: boolean | undefined): string => (failed ? WATCH_COPY.failed : watched ? WATCH_COPY.watching : WATCH_COPY.idle);

function useHover() {
  const [hovered, setHovered] = useState(false);
  return { hovered, on: { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false), onFocus: () => setHovered(true), onBlur: () => setHovered(false) } };
}

function PersonalPill({ watched, loaded, failed, onToggle }: Pick<WatchToggleProps, "watched" | "loaded" | "failed" | "onToggle">) {
  const { hovered, on } = useHover();
  return (
    <button type="button" aria-pressed={watched} disabled={!loaded} onClick={() => onToggle("personal")} title={titleFor(watched, failed)} className={`cl-watch-pill${watched ? " cl-watch-pill--on" : ""}`} {...on}>
      <span aria-hidden="true">{watched ? "★" : "☆"}</span>
      {watched ? (hovered ? "Unwatch" : "Watching") : "Watch"}
    </button>
  );
}

/** The watch control in three variants over one copy table: the dual pill (personal and team), the action-row button, the 44 px list-row icon. A failed save is a visible line, not a title. */
export function WatchToggle(p: WatchToggleProps) {
  const { variant = "default", watched, teamWatched = false, teamAvailable = false, teamOnly = false, loaded, failed = false, teamFailed = false, onToggle } = p;
  const { hovered, on } = useHover();
  const failure = (failed || teamFailed) && (
    <span role="alert" className="cl-watch-fail">
      {WATCH_COPY.failed}
    </span>
  );
  if (variant === "icon") {
    const label = titleFor(watched, failed);
    return (
      <button type="button" aria-label={label} aria-pressed={watched} disabled={!loaded} title={label} onClick={() => onToggle("personal")} className="cl-watch-icon" {...on}>
        <span aria-hidden="true" className={`cl-watch-icon-box${hovered ? " cl-watch-icon-box--hot" : ""}${watched ? " cl-watch-icon-box--on" : ""}`}>
          {watched ? "★" : "☆"}
        </span>
      </button>
    );
  }
  if (variant === "row") {
    return (
      <span className="cl-watch-wrap">
        <Button aria-pressed={watched} disabled={!loaded} onClick={() => onToggle("personal")} title={titleFor(watched, failed)} onFocus={on.onFocus} onBlur={on.onBlur}>
          <span aria-hidden="true">{watched ? "★" : "☆"}</span>
          {watched ? "Watching" : "Watch"}
        </Button>
        {failure}
      </span>
    );
  }
  const team = (sole: boolean) => (
    <button
      type="button"
      aria-pressed={teamWatched}
      disabled={!loaded}
      onClick={() => onToggle("team")}
      title={teamFailed ? WATCH_COPY.failed : teamWatched ? WATCH_COPY.teamOn : sole ? WATCH_COPY.teamSole : WATCH_COPY.teamIdle}
      className={`cl-watch-pill cl-watch-pill--team${teamWatched ? " cl-watch-pill--on" : ""}${sole ? " cl-watch-pill--sole" : ""}`}
    >
      {sole ? (teamWatched ? "Watching (team)" : "Watch (team)") : teamWatched ? "Team ✓" : "Team"}
    </button>
  );
  if (teamOnly) {
    return teamAvailable ? (
      <span className="cl-watch-wrap">
        {team(true)}
        {failure}
      </span>
    ) : (
      <span title={WATCH_COPY.teamBlocked} className="cl-watch-pill cl-watch-pill--blocked">
        Watch
      </span>
    );
  }
  return (
    <span className="cl-watch-wrap">
      <span className="cl-watch-pair">
        <PersonalPill watched={watched} loaded={loaded} failed={failed} onToggle={onToggle} />
        {teamAvailable && team(false)}
      </span>
      {failure}
    </span>
  );
}
