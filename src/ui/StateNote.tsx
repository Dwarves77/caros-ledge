"use client";

// Ported from old_repo/src/components/ui/StateNote.tsx (lines 11-113)
// Ported from old_repo/src/components/ui/band-context.tsx (lines 22-38)
import Link from "next/link";
import { createContext, useContext, type ReactNode } from "react";

import type { UrgencyBand } from "@/core/lists";

interface BandContextValue {
  band: UrgencyBand | null;
  action: string | null;
}
const BandContext = createContext<BandContextValue>({ band: null, action: null });

/** The band a page section sits in; StateNote, ItemGroup and Timeline read it. */
export function BandProvider({ band, action = null, children }: { band: UrgencyBand | null; action?: string | null; children: ReactNode }) {
  return <BandContext.Provider value={{ band, action: action?.trim() ? action.trim() : null }}>{children}</BandContext.Provider>;
}
export const useBandContext = (): BandContextValue => useContext(BandContext);

interface StateNoteProps {
  band?: UrgencyBand | null;
  children: ReactNode;
  action?: { label: string; href?: string; onClick?: () => void };
  /** `error` tints the strip from the tokens when no band applies. */
  tone?: "note" | "error";
}

/** The state-note strip: band tint from props or context, one action (an internal href is a Link). */
export function StateNote({ band: bandProp, children, action, tone = "note" }: StateNoteProps) {
  const ctx = useBandContext();
  const band = bandProp ?? ctx.band;
  const color = band ? band.cssVar : tone === "error" ? "var(--immediate)" : "var(--brand)";
  const bg = band ? band.tintCssVar : tone === "error" ? "var(--immediate-tint)" : "var(--tag)";
  return (
    <div data-part="state-note" role={tone === "error" ? "alert" : undefined} className="cl-state-note" style={{ ["--note-rule" as string]: color, background: bg }}>
      <span className="cl-state-note-text">{children}</span>
      {action?.href ? (
        <Link href={action.href} prefetch={false} className="cl-state-note-action">
          {action.label}
        </Link>
      ) : action ? (
        <button type="button" onClick={action.onClick} className="cl-state-note-action cl-state-note-action--button">
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/** The empty variant of StateNote, exported by its own name: an honest empty (the read succeeded and returned nothing). */
export const EmptyState = ({ children, action }: { children: ReactNode; action?: StateNoteProps["action"] }) => <StateNote {...(action ? { action } : {})}>{children}</StateNote>;
