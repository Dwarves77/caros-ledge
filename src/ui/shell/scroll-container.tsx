"use client";

// Ported from old_repo/src/lib/hooks/useNearestScrollParent.ts (lines 54-94)
// Ported from old_repo/src/components/AppShell.tsx (lines 254-256)
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

interface ScrollValue {
  el: HTMLElement | null;
  setEl: (el: HTMLElement | null) => void;
}
const ScrollContext = createContext<ScrollValue>({ el: null, setEl: () => {} });

/** Holds the one element the page scrolls in (the shell's <main>) so the virtualizer and BackToTop read the same box. */
export function ScrollProvider({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ el, setEl }), [el]);
  return <ScrollContext.Provider value={value}>{children}</ScrollContext.Provider>;
}

/** The shell's <main>: the scroll box. It registers itself, and re-registers if it is remounted (the old hook resolved once and never again: B-0261). */
export function ScrollContainer({ children, className }: { children: ReactNode; className?: string }) {
  const { setEl } = useContext(ScrollContext);
  return (
    <main ref={setEl} className={className ?? "cl-shell-main"}>
      {children}
    </main>
  );
}

/** The registered scroll element, or null before mount or outside a shell (callers then use the window). */
export const useScrollContainer = (): HTMLElement | null => useContext(ScrollContext).el;
