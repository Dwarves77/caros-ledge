// Ported from old_repo/src/lib/connections/theme-delta.mjs (lines 1-149)
// Ported from old_repo/src/lib/connections/theme-stats.mjs (lines 1-48)
// Ported from old_repo/src/lib/connections/brief-staleness.mjs (lines 1-70)
// The theme lifecycle: the delta between two runs (persisted, renamed, split, merged, dissolved, appeared), the lineage it implies, the stats and
// convergence bands, and the member hash that decides whether a stored theme brief is still about the live theme (INV-191).
import { createHash } from "node:crypto";

import { CONFIG, CONVERGENCE_BANDS } from "./config";

const OVERLAP_THRESHOLD = CONFIG.themeOverlapThreshold;

export interface ThemeLike {
  id: string;
  member_ids?: readonly string[] | null;
  members?: readonly string[] | null;
  surfaces?: readonly string[] | null;
  convergence?: number | null;
}
interface Norm {
  id: string;
  members: string[];
}
export interface ThemeDelta {
  persisted: { prior_id: string; new_id: string; added: string[]; removed: string[] }[];
  renamed: { prior_id: string; new_id: string; added: string[]; removed: string[] }[];
  split: { prior_id: string; new_ids: string[] }[];
  merged: { new_id: string; prior_ids: string[] }[];
  dissolved: string[];
  /** The dissolved themes whose members now cluster below the convergence floor (ruling 58): a subset of `dissolved`, reason below_floor. Absent on a delta stored before the floor. */
  below_floor?: string[];
  appeared: string[];
  summary: Record<"prior_count" | "new_count" | "persisted" | "renamed" | "split" | "merged" | "dissolved" | "appeared", number>;
}

function normalize(themes: readonly ThemeLike[] | null | undefined): Norm[] {
  const out: Norm[] = [];
  for (const t of themes ?? []) {
    if (!t || typeof t.id !== "string") continue;
    const members = t.member_ids ?? t.members ?? [];
    out.push({ id: t.id, members: [...new Set(members.filter((m) => typeof m === "string" && m))].sort() });
  }
  return out;
}

function overlapCoefficient(a: Iterable<string>, b: Iterable<string>): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const m of setA) if (setB.has(m)) inter += 1;
  return inter / Math.min(setA.size, setB.size);
}

const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Diff two theme sets by member overlap (>= the threshold counts as the same theme); a split, a merge, a 1:1 mutual best match is a rename or persist. */
export function diffThemes(priorThemes: readonly ThemeLike[] | null | undefined, newThemes: readonly ThemeLike[] | null | undefined, opts: { overlapThreshold?: number; belowFloor?: readonly ThemeLike[] } = {}): ThemeDelta {
  const threshold = opts.overlapThreshold ?? OVERLAP_THRESHOLD;
  const priors = normalize(priorThemes);
  const news = normalize(newThemes);
  const newById = new Map(news.map((t) => [t.id, t]));
  type Match = { id: string; coef: number };
  const priorMatches = new Map<string, Match[]>(priors.map((t) => [t.id, []]));
  const newMatches = new Map<string, Match[]>(news.map((t) => [t.id, []]));
  for (const p of priors) {
    for (const n of news) {
      const coef = overlapCoefficient(p.members, n.members);
      if (coef >= threshold) {
        (priorMatches.get(p.id) as Match[]).push({ id: n.id, coef });
        (newMatches.get(n.id) as Match[]).push({ id: p.id, coef });
      }
    }
  }
  const byCoef = (a: Match, b: Match): number => b.coef - a.coef || cmpId(a.id, b.id);
  for (const list of priorMatches.values()) list.sort(byCoef);
  for (const list of newMatches.values()) list.sort(byCoef);
  const persisted: ThemeDelta["persisted"] = [];
  const renamed: ThemeDelta["renamed"] = [];
  const split: ThemeDelta["split"] = [];
  const merged: ThemeDelta["merged"] = [];
  const dissolved: string[] = [];
  const appeared: string[] = [];
  const claimedPrior = new Set<string>();
  const claimedNew = new Set<string>();
  for (const p of priors) {
    const matches = priorMatches.get(p.id) as Match[];
    if (matches.length >= 2) {
      split.push({ prior_id: p.id, new_ids: matches.map((m) => m.id).sort() });
      claimedPrior.add(p.id);
      for (const m of matches) claimedNew.add(m.id);
    }
  }
  for (const n of news) {
    const matches = (newMatches.get(n.id) as Match[]).filter((m) => !claimedPrior.has(m.id));
    if (matches.length >= 2) {
      merged.push({ new_id: n.id, prior_ids: matches.map((m) => m.id).sort() });
      claimedNew.add(n.id);
      for (const m of matches) claimedPrior.add(m.id);
    }
  }
  for (const p of priors) {
    if (claimedPrior.has(p.id)) continue;
    const matches = (priorMatches.get(p.id) as Match[]).filter((m) => !claimedNew.has(m.id));
    if (matches.length !== 1) continue;
    const nId = (matches[0] as Match).id;
    const nBest = (newMatches.get(nId) as Match[]).filter((m) => !claimedPrior.has(m.id));
    if (nBest.length !== 1 || (nBest[0] as Match).id !== p.id) continue;
    const n = newById.get(nId) as Norm;
    const priorSet = new Set(p.members);
    const newSet = new Set(n.members);
    const row = { prior_id: p.id, new_id: n.id, added: n.members.filter((m) => !priorSet.has(m)), removed: p.members.filter((m) => !newSet.has(m)) };
    (p.id === n.id ? persisted : renamed).push(row);
    claimedPrior.add(p.id);
    claimedNew.add(n.id);
  }
  for (const p of priors) if (!claimedPrior.has(p.id)) dissolved.push(p.id);
  for (const n of news) if (!claimedNew.has(n.id)) appeared.push(n.id);
  dissolved.sort();
  appeared.sort();
  const floored = normalize(opts.belowFloor); const below_floor = dissolved.filter((id) => floored.some((f) => overlapCoefficient((priors.find((p) => p.id === id) as Norm).members, f.members) >= threshold));
  persisted.sort((a, b) => cmpId(a.prior_id, b.prior_id));
  renamed.sort((a, b) => cmpId(a.prior_id, b.prior_id));
  split.sort((a, b) => cmpId(a.prior_id, b.prior_id));
  merged.sort((a, b) => cmpId(a.new_id, b.new_id));
  return {
    persisted, renamed, split, merged, dissolved, below_floor, appeared,
    summary: { prior_count: priors.length, new_count: news.length, persisted: persisted.length, renamed: renamed.length, split: split.length, merged: merged.length, dissolved: dissolved.length, appeared: appeared.length },
  };
}

export function computeThemeStats(themes: readonly ThemeLike[] | null | undefined): { total: number; avg_convergence: number; cross_surface_count: number; single_surface_count: number } {
  const list = themes ?? [];
  let sum = 0;
  let cross = 0;
  let single = 0;
  for (const t of list) {
    sum += typeof t?.convergence === "number" && Number.isFinite(t.convergence) ? t.convergence : 0;
    const n = Array.isArray(t?.surfaces) ? t.surfaces.length : 0;
    if (n >= 2) cross += 1;
    else if (n === 1) single += 1;
  }
  return { total: list.length, avg_convergence: list.length > 0 ? Number((sum / list.length).toFixed(6)) : 0, cross_surface_count: cross, single_surface_count: single };
}

export function convergenceBand(convergence: unknown): "high" | "medium" | "low" {
  const c = typeof convergence === "number" && Number.isFinite(convergence) ? convergence : 0;
  return c >= CONVERGENCE_BANDS.high ? "high" : c >= CONVERGENCE_BANDS.medium ? "medium" : "low";
}

/** md5 of the sorted member ids joined: the one recipe for "is this brief still about this theme". */
export function computeMemberHash(memberIds: readonly string[] | null | undefined): string {
  return createHash("md5").update([...(memberIds ?? [])].sort().join("")).digest("hex");
}
export const isBriefStale = (storedHash: string | null | undefined, memberIds: readonly string[] | null | undefined): boolean => computeMemberHash(memberIds) !== storedHash;

export interface BriefLike {
  theme_id: string;
  member_hash?: string | null;
  member_ids?: readonly string[] | null;
  superseded_at?: string | null;
}
/** The brief for a theme: the one stored under the theme's own id and not retired (superseded_at null), stale when its member hash no longer matches. A brief of another theme id is never attached, whatever its member overlap; a theme without one needs a brief. */
export function resolveBriefForTheme<B extends BriefLike>(theme: ThemeLike | null | undefined, briefs: readonly B[] | null | undefined): { brief: B | null; stale: boolean } {
  const brief = theme ? ((briefs ?? []).find((b) => b && b.theme_id === theme.id && !b.superseded_at) ?? null) : null;
  return { brief, stale: brief ? isBriefStale(brief.member_hash, theme?.member_ids ?? theme?.members) : false };
}
