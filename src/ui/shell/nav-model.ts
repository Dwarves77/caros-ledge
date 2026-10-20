// Ported from old_repo/src/components/Sidebar.tsx (lines 48-104)
// Ported from old_repo/src/components/Sidebar.tsx (lines 135-151)
// Ported from old_repo/src/components/layout/TopBar.tsx (lines 70-75)
// Ported from old_repo/src/components/AppShell.tsx (lines 17-39)
// The nav as data plus the route matching around it. Every match is by path SEGMENT, never by string prefix: "/market" is not "/marketplace".
import { z } from "zod";

import navJson from "./data/nav.json";

const item = z.object({ href: z.string(), label: z.string(), countKey: z.enum(["regulations", "market", "research", "operations", "watchlist"]).optional() });
const NAV = z
  .object({
    appName: z.string(),
    tagline: z.string(),
    sections: z.array(z.object({ label: z.string(), items: z.array(item) })),
    extraTitles: z.array(z.object({ href: z.string(), label: z.string() })),
    chromeless: z.array(z.string()),
    noWorkspaceNoteSuppressed: z.array(z.string()),
  })
  .parse(navJson);

export const APP_NAME = NAV.appName;
export const APP_TAGLINE = NAV.tagline;
export const SECTIONS = NAV.sections;

/** True when `pathname` is `route` or a path under it ("/auth/callback" is under "/auth"; "/author" is not). */
const underRoute = (pathname: string, route: string): boolean => (route === "/" ? pathname === "/" : pathname === route || pathname.startsWith(`${route}/`));
export const isActivePath = (pathname: string, href: string): boolean => underRoute(pathname, href);

// Longest href first, so "/map" never shadows a longer match.
const TITLES = [...SECTIONS.flatMap((s) => s.items.map(({ href, label }) => ({ href, label }))), ...NAV.extraTitles].sort((a, b) => b.href.length - a.href.length);

/** The mobile top bar title for a path: the nav label of the route it is under, else the app name. */
export function navTitleForPath(pathname: string): string {
  if (pathname === "/") return "Dashboard";
  return TITLES.find((t) => t.href !== "/" && underRoute(pathname, t.href))?.label ?? APP_NAME;
}

/** Auth, onboarding, invitation and privacy pages render without the signed-in chrome (and without its polls). */
export const isChromeless = (pathname: string): boolean => NAV.chromeless.some((r) => underRoute(pathname, r));
export const suppressesWorkspaceNote = (pathname: string): boolean => NAV.noWorkspaceNoteSuppressed.some((r) => underRoute(pathname, r));

export type NavPriorityCounts = { CRITICAL: number; HIGH: number; MODERATE: number; LOW: number };
/** The band-rule counts from the priority tallies; null when the tallies are unknown (the nav cap then draws no split). */
export function gradientCountsFrom(byPriority: NavPriorityCounts | null | undefined): Record<string, number> | null {
  return byPriority ? { immediate: byPriority.CRITICAL, action: byPriority.HIGH, monitor: byPriority.MODERATE, awareness: byPriority.LOW } : null;
}
