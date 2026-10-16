// Ported from old_repo/src/lib/connections/cluster.mjs (lines 1-187)
// Themes by label propagation over the scored undirected graph. Deterministic: ids and labels are visited in sorted order, a theme's id is its
// smallest member id (stable under shuffling), and the pass converges within MAX_ROUNDS. Convergence = surfaces spanned x density x recency.
import { surfaceOf } from "@/core/routing";

import { CONFIG } from "./config";
import type { BasisEntry } from "./discover";
import { basisEntryKey } from "./intersections";

const MAX_ROUNDS = CONFIG.cluster.maxRounds;
const PIVOT_K = CONFIG.cluster.pivotK;

export interface ClusterNode {
  id: string;
  item_type?: string | null;
  domain?: number | null;
  dates?: unknown;
}
export interface ClusterEdge {
  source: string;
  target: string;
  score?: number | null;
  basis?: BasisEntry[] | null;
}
export interface Theme {
  id: string;
  members: string[];
  dominantSignals: { signal: string; weight: number }[];
  surfaces: string[];
  density: number;
  convergence: number;
  pivots: { id: string; centrality: number }[];
}
interface Pair {
  a: string;
  b: string;
  score: number;
  basis: BasisEntry[];
}

function nodeDateMs(node: ClusterNode | undefined): number | null {
  const raw = node?.dates;
  const candidates = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  for (const c of candidates) {
    if (c == null) continue;
    const ms = c instanceof Date ? c.getTime() : typeof c === "number" ? c : Date.parse(String(c));
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}
const lc = (s: unknown): string => String(s ?? "").toLowerCase().trim();

export function clusterThemes(nodes: readonly ClusterNode[], edges: readonly ClusterEdge[]): { themes: Theme[]; nodesClustered: number; edgesUsed: number; rounds: number } {
  const nodeById = new Map<string, ClusterNode>();
  for (const n of nodes) if (n && typeof n.id === "string" && n.id) nodeById.set(n.id, n);
  const pair = new Map<string, Pair>();
  for (const e of edges) {
    if (!e || typeof e.source !== "string" || typeof e.target !== "string" || e.source === e.target) continue;
    if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue;
    const score = typeof e.score === "number" && Number.isFinite(e.score) ? e.score : 0;
    if (score <= 0) continue;
    const [a, b] = e.source < e.target ? [e.source, e.target] : [e.target, e.source];
    const key = `${a}|${b}`;
    const existing = pair.get(key);
    const incoming = (Array.isArray(e.basis) ? e.basis : []).filter((x) => x && x.signal);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      for (const bs of incoming) if (!existing.basis.some((x) => basisEntryKey(x) === basisEntryKey(bs))) existing.basis.push(bs);
    } else pair.set(key, { a, b, score, basis: incoming });
  }
  const adj = new Map<string, Map<string, number>>();
  const touch = (id: string): Map<string, number> => {
    let m = adj.get(id);
    if (!m) adj.set(id, (m = new Map()));
    return m;
  };
  for (const key of [...pair.keys()].sort()) {
    const { a, b, score } = pair.get(key) as Pair;
    touch(a).set(b, score);
    touch(b).set(a, score);
  }
  const connectedIds = [...adj.keys()].sort();
  const label = new Map(connectedIds.map((id) => [id, id]));
  let rounds = 0;
  for (; rounds < MAX_ROUNDS; rounds += 1) {
    let changed = false;
    for (const id of connectedIds) {
      const weightByLabel = new Map<string, number>();
      for (const [nb, w] of adj.get(id) as Map<string, number>) {
        const l = label.get(nb) as string;
        weightByLabel.set(l, (weightByLabel.get(l) || 0) + w);
      }
      if (!weightByLabel.size) continue;
      let best: string | null = null;
      let bestW = -Infinity;
      for (const l of [...weightByLabel.keys()].sort()) {
        const w = weightByLabel.get(l) as number;
        if (w > bestW) {
          bestW = w;
          best = l;
        }
      }
      if (best !== null && best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) {
      rounds += 1;
      break;
    }
  }
  const byLabel = new Map<string, string[]>();
  for (const id of connectedIds) {
    const l = label.get(id) as string;
    byLabel.set(l, [...(byLabel.get(l) ?? []), id]);
  }
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const id of connectedIds) {
    const ms = nodeDateMs(nodeById.get(id));
    if (ms !== null) {
      if (ms < minMs) minMs = ms;
      if (ms > maxMs) maxMs = ms;
    }
  }
  const dateRangeUsable = Number.isFinite(minMs) && Number.isFinite(maxMs) && maxMs > minMs;
  const themes: Theme[] = [];
  for (const memberIds of byLabel.values()) {
    if (memberIds.length < 2) continue;
    const members = memberIds.slice().sort();
    const memberSet = new Set(members);
    const intraPairs = [...pair.keys()].sort().map((k) => pair.get(k) as Pair).filter((p) => memberSet.has(p.a) && memberSet.has(p.b));
    const centrality = new Map(members.map((id) => [id, 0]));
    for (const p of intraPairs) {
      centrality.set(p.a, (centrality.get(p.a) as number) + p.score);
      centrality.set(p.b, (centrality.get(p.b) as number) + p.score);
    }
    const pivots = members
      .map((id) => ({ id, centrality: Number((centrality.get(id) as number).toFixed(6)) }))
      .sort((x, y) => (y.centrality !== x.centrality ? y.centrality - x.centrality : x.id < y.id ? -1 : 1))
      .slice(0, PIVOT_K);
    const signalWeight = new Map<string, number>();
    for (const p of intraPairs) for (const bs of p.basis) signalWeight.set(bs.signal, (signalWeight.get(bs.signal) || 0) + (typeof bs.weight === "number" && Number.isFinite(bs.weight) ? bs.weight : 0));
    const dominantSignals = [...signalWeight.keys()]
      .sort()
      .map((signal) => ({ signal, weight: Number((signalWeight.get(signal) as number).toFixed(6)) }))
      .sort((x, y) => (y.weight !== x.weight ? y.weight - x.weight : x.signal < y.signal ? -1 : 1));
    const surfaces = [...new Set(members.map((id) => {
      const n = nodeById.get(id);
      return lc(n?.item_type ? surfaceOf(n.item_type, n.domain) : n?.item_type) || "unknown";
    }))].sort();
    const n = members.length;
    const density = intraPairs.length / ((n * (n - 1)) / 2);
    let recency = 1;
    if (dateRangeUsable) {
      const norms: number[] = [];
      for (const id of members) {
        const ms = nodeDateMs(nodeById.get(id));
        if (ms !== null) norms.push((ms - minMs) / (maxMs - minMs));
      }
      if (norms.length) recency = norms.reduce((s, x) => s + x, 0) / norms.length;
    }
    const ordered = members.slice().sort((x, y) => {
      const dx = nodeDateMs(nodeById.get(x));
      const dy = nodeDateMs(nodeById.get(y));
      if (dx !== null && dy !== null && dx !== dy) return dx - dy;
      if (dx !== null && dy === null) return -1;
      if (dx === null && dy !== null) return 1;
      return x < y ? -1 : 1;
    });
    themes.push({ id: members[0] as string, members: ordered, dominantSignals, surfaces, density: Number(density.toFixed(6)), convergence: Number((surfaces.length * density * recency).toFixed(6)), pivots });
  }
  themes.sort((x, y) => (y.convergence !== x.convergence ? y.convergence - x.convergence : x.id < y.id ? -1 : 1));
  return { themes, nodesClustered: connectedIds.length, edgesUsed: pair.size, rounds };
}
