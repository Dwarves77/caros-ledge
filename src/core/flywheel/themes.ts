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

/** prior-to-new theme id pairs a delta implies (renamed, split daughters, merged parents), for the surfaces that follow a theme across runs. */
export function lineageFromThemeDelta(delta: Partial<ThemeDelta> | null | undefined): { prior_id: string; new_id: string }[] {
  const out: { prior_id: string; new_id: string }[] = [];
  for (const r of delta?.renamed ?? []) if (r?.prior_id && r.new_id) out.push({ prior_id: r.prior_id, new_id: r.new_id });
  for (const s of delta?.split ?? []) for (const n of s?.new_ids ?? []) if (s.prior_id && n) out.push({ prior_id: s.prior_id, new_id: n });
  for (const m of delta?.merged ?? []) for (const p of m?.prior_ids ?? []) if (m.new_id && p) out.push({ prior_id: p, new_id: m.new_id });
  return out;
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

/** theme_briefs has no status column: a brief retired by retire-orphan-theme-briefs carries this prefix in generated_by (the trigger of migration 0039 keeps the prior row), and a rewrite by apply_theme_brief replaces it. */
export const SUPERSEDED_PREFIX = "superseded:"; export const isSupersededBrief = (b: Record<string, unknown> | null | undefined): boolean => typeof b?.generated_by === "string" && b.generated_by.startsWith(SUPERSEDED_PREFIX);

export interface BriefLike {
  theme_id: string;
  member_hash?: string | null;
  member_ids?: readonly string[] | null;
  [k: string]: unknown;
}
/** The brief for a theme: exact id match, else (when the theme id moved) the dissolved theme's brief by member overlap or recorded lineage, always stale. */
export function resolveBriefForTheme<B extends BriefLike>(theme: ThemeLike | null | undefined, briefs: readonly B[] | null | undefined, opts: { liveThemeIds?: Set<string>; overlapThreshold?: number; lineage?: readonly { prior_id: string; new_id: string }[] } = {}): { brief: B | null; match: "exact" | "overlap" | "lineage" | null; stale: boolean; supersedes_theme_id: string | null } {
  const none = { brief: null, match: null, stale: false, supersedes_theme_id: null };
  if (!theme || typeof theme.id !== "string") return none;
  const live = theme.member_ids ?? [];
  const list = (briefs ?? []).filter((b) => b && typeof b.theme_id === "string" && !isSupersededBrief(b));
  const exact = list.find((b) => b.theme_id === theme.id);
  if (exact) return { brief: exact, match: "exact", stale: isBriefStale(exact.member_hash, live), supersedes_theme_id: null };
  const liveIds = opts.liveThemeIds ?? new Set<string>();
  const threshold = opts.overlapThreshold ?? OVERLAP_THRESHOLD;
  const lineageFor = new Set((opts.lineage ?? []).filter((p) => p && p.new_id === theme.id).map((p) => p.prior_id));
  type Cand = { b: B; coef: number; match: "overlap" | "lineage" };
  const cands: Cand[] = [];
  for (const b of list) {
    if (liveIds.has(b.theme_id)) continue;
    if (Array.isArray(b.member_ids) && b.member_ids.length > 0) {
      const coef = overlapCoefficient(b.member_ids, live);
      if (coef >= threshold) cands.push({ b, coef, match: "overlap" });
    } else if (lineageFor.has(b.theme_id)) cands.push({ b, coef: 0, match: "lineage" });
  }
  const best = cands.reduce<Cand | null>((acc, cand) => (!acc || cand.coef > acc.coef || (cand.coef === acc.coef && cand.b.theme_id < acc.b.theme_id) ? cand : acc), null);
  return best ? { brief: best.b, match: best.match, stale: true, supersedes_theme_id: best.b.theme_id } : none;
}
