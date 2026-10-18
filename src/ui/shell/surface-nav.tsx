"use client";

// Ported from old_repo/src/components/community/CommunityShell.tsx (lines 189-200)
// The surface-nav slot: a surface that owns its own navigation (Community) mounts <SurfaceNav render=... /> and the shell draws it in place of the global nav card, on the desktop column and in the phone drawer, with no
// global style injected (the old Community shell hid the global sidebar with a <style> keyed to its class names). The slot empties when the surface unmounts. It is plain context: PageFrame is unchanged.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type SurfaceNavRender = (o: { variant: "card" | "drawer"; onNavigate?: (() => void) | undefined }) => ReactNode;

const Read = createContext<SurfaceNavRender | null>(null);
const Write = createContext<(r: SurfaceNavRender | null) => void>(() => undefined);

export function SurfaceNavProvider({ children }: { children: ReactNode }) {
  const [render, setRender] = useState<SurfaceNavRender | null>(null);
  const write = useCallback((r: SurfaceNavRender | null) => setRender(() => r), []);
  return (
    <Write.Provider value={write}>
      <Read.Provider value={render}>{children}</Read.Provider>
    </Write.Provider>
  );
}

/** What the shell draws instead of the global nav card, or null when no surface has claimed the slot. */
export const useSurfaceNav = (): SurfaceNavRender | null => useContext(Read);

/** Claim the slot for as long as this is mounted. */
export function SurfaceNav({ render }: { render: SurfaceNavRender }) {
  const write = useContext(Write);
  useEffect(() => {
    write(render);
    return () => write(null);
  }, [write, render]);
  return null;
}
