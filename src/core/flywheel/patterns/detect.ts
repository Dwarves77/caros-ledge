// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the five pattern detectors (C3), pure functions over the facts a loader joined: no read, no clock but `input.now`, no quantity, rate, price or factor typed here (each threshold is in data/patterns.json, each quantity a stored row's).
// Detection is symmetric across surfaces: any fact of any table may be the first vertex. A detector returns its patterns sorted by key, each with the evidence rows by edge kind.
//   P1 velocity: three or more independent sources citing one entity in a window, at a share of the corpus's flow above the share the entity held in the trailing baseline window; no flow and no earlier citations, no baseline.
//   P2 mandate and capacity: a dated ratchet and a capacity row filed under a shared entity, the capacity landing after the ratchet or holding less than it mandates in the same unit.
//   P3 lead and lag: a pending trigger a set number of days out and a move on a shared entity in the days before.
//   P4 cross-modal: a mandate or a move in one mode's entity and recent rows in a mode the entity's relation (feedstock, competition, grid zone, corridor) carries it to.
//   P5 penalty and abatement: a technology at the maturity floor whose derived abatement cost crosses, or comes within the band of, a statutory ceiling in the same unit.
import { couplingById, WINDOWS, type Relation } from "@/core/coupling/coupling";

import { PATTERNS } from "./config";
import type { Evidence, Fact, Pattern, PatternInput } from "./types";

const MS_PER_DAY = 86_400_000;
const dayStartMs = (d: string): number => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
const todayMs = (now: Date): number => dayStartMs(now.toISOString());
/** Whole days from `d` to now (negative for a day ahead). */
const ageDays = (d: string, now: Date): number => Math.floor((todayMs(now) - dayStartMs(d)) / MS_PER_DAY);
const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
const monthsBetween = (a: string, b: string): number => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
const ev = (f: Fact, kind: Evidence["kind"], relation?: Relation): Evidence => ({ table: f.table, pk: f.pk, kind, entities: f.entities, ...(relation ? { relation } : {}) });
const reach = (i: PatternInput, es: readonly string[]): Set<string> => new Set(es.flatMap((e) => [e, ...i.related(e).map((r) => r.entity)]));
const shared = (a: ReadonlySet<string>, b: readonly string[]): string | undefined => [...b].sort().find((e) => a.has(e));
const groupBy = <T>(xs: readonly T[], keys: (x: T) => readonly string[]): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const x of xs) for (const k of keys(x)) m.set(k, [...(m.get(k) ?? []), x]);
  return m;
};
const sorted = (ps: Pattern[]): Pattern[] => ps.sort((a, b) => a.key.localeCompare(b.key));
const latestFact = (fs: readonly Fact[]): Fact | undefined => [...fs].sort((a, b) => String(b.at ?? b.due).localeCompare(String(a.at ?? a.due)) || a.pk.localeCompare(b.pk))[0];
const horizonMonths = Math.max(...WINDOWS.map((w) => w.toMonths));

function velocity(i: PatternInput): Pattern[] {
  const c = PATTERNS.velocity;
  const claims = i.facts.filter((f) => f.role === "claim" && f.at && !c.excludeKinds.includes(f.kind ?? ""));
  const out: Pattern[] = [];
  for (const [entity, list] of groupBy(claims, (f) => f.entities)) {
    if (c.excludeClasses.includes(couplingById(entity)?.class ?? "")) continue;
    for (const w of [...c.windowsDays].sort((a, b) => a - b)) {
      const members = list.filter((f) => ageDays(f.at as string, i.now) >= 0 && ageDays(f.at as string, i.now) < w);
      const distinct = Math.max(new Set(members.map((f) => f.tier)).size, new Set(members.map((f) => f.surface)).size);
      if (new Set(members.map((f) => f.source).filter(Boolean)).size < c.minSources || distinct < c.minDistinct) continue;
      const base = list.filter((f) => ageDays(f.at as string, i.now) >= w && ageDays(f.at as string, i.now) < w + c.baselineDays);
      // an entity new to the corpus has no baseline: its first appearance is coverage, not velocity
      if (i.flow && base.length < c.minBaseline) continue;
      const flow = (from: number, to: number): number => (i.flow ? [...i.flow].reduce((n, [d, k]) => n + (ageDays(d, i.now) >= from && ageDays(d, i.now) < to ? k : 0), 0) : 0);
      const [inWindow, inBaseline] = [flow(0, w), flow(w, w + c.baselineDays)];
      // the share of the corpus's flow the entity holds in the window against the share it held before; a window or baseline with no flow defines none
      const [shareNow, shareBefore] = [members.length / inWindow, Math.max(base.length, 1) / inBaseline];
      if (i.flow ? !inWindow || !inBaseline || shareNow <= base.length / inBaseline : i.carry === undefined) continue;
      out.push({ kind: "velocity", key: `${entity}|${w}`, entity, value: i.flow ? shareNow / shareBefore : (i.carry as number), unit: "ratio", evidence: [...members.map((f) => ev(f, "member")), ...base.map((f) => ev(f, "key"))] });
      break;
    }
  }
  return sorted(out);
}

function mandateCapacity(i: PatternInput): Pattern[] {
  const caps = groupBy(i.facts.filter((f) => f.role === "capacity"), (f) => f.entities);
  const out: Pattern[] = [];
  for (const r of i.facts.filter((f) => f.role === "ratchet")) {
    if (r.due && (ageDays(r.due, i.now) > 0 || monthsBetween(dayOf(todayMs(i.now)), r.due) > horizonMonths)) continue;
    const near = reach(i, r.entities);
    for (const c of new Set([...near].flatMap((e) => caps.get(e) ?? []))) {
      const gap = r.due && c.due && c.due > r.due ? monthsBetween(r.due, c.due) : null;
      const short = r.qty !== null && c.qty !== null && r.unit === c.unit && r.qty > 0 && c.qty < r.qty ? (r.qty - c.qty) / r.qty : null;
      const entity = shared(near, c.entities);
      if ((gap === null && short === null) || !entity) continue;
      out.push({ kind: "mandateCapacity", key: `${r.pk}|${c.pk}`, entity, value: gap ?? (short as number), unit: gap !== null ? "months" : "ratio", evidence: [ev(r, "key"), ev(c, "evidence")] });
    }
  }
  return sorted(out);
}

function leadLag(i: PatternInput): Pattern[] {
  const c = PATTERNS.leadLag;
  const moves = i.facts.filter((f) => f.at && ageDays(f.at, i.now) >= 0 && ageDays(f.at, i.now) < c.moveWindowDays && ((f.role === "series" && Math.abs(f.qty ?? 0) >= c.minMove) || ["tech", "move", "capacity"].includes(f.role) || (f.role === "claim" && f.surface !== "regulations" && !PATTERNS.velocity.excludeKinds.includes(f.kind ?? ""))));
  const out: Pattern[] = [];
  for (const t of i.facts.filter((f) => f.role === "trigger" && c.triggerKinds.includes(f.kind ?? "") && f.due)) {
    const lead = -ageDays(t.due as string, i.now);
    if (lead < c.leadDays[0] || lead > c.leadDays[1]) continue;
    const near = reach(i, t.entities);
    const bySurface = groupBy(moves.filter((m) => shared(near, m.entities)), (m) => [m.surface]);
    const picked = [...bySurface.values()].map((fs) => latestFact(fs) as Fact);
    const entity = picked.length ? shared(near, picked[0]?.entities ?? []) : undefined;
    if (picked.length && entity) out.push({ kind: "leadLag", key: t.pk, entity, value: lead, unit: "days", evidence: [ev(t, "key"), ...picked.sort((a, b) => a.pk.localeCompare(b.pk)).map((m) => ev(m, "evidence"))] });
  }
  return sorted(out);
}

function crossModal(i: PatternInput): Pattern[] {
  const c = PATTERNS.crossModal;
  const modesOf = (e: string): string[] => couplingById(e)?.modes ?? [];
  const age = (f: Fact): number => (f.at ? Math.max(0, ageDays(f.at, i.now)) : f.due ? Math.abs(ageDays(f.due, i.now)) : Infinity);
  const starts = i.facts.filter((f) => (f.role === "ratchet" && f.due && age(f) <= c.recencyDays) || (f.role === "series" && Math.abs(f.qty ?? 0) >= c.minMove && age(f) <= c.recencyDays));
  const recent = i.facts.filter((f) => age(f) <= c.recencyDays);
  const out = new Map<string, Pattern>();
  for (const a of starts) {
    for (const from of a.entities) {
      for (const link of i.related(from)) {
        const weight = c.relations[link.relation];
        const spill = modesOf(link.entity).filter((m) => !modesOf(from).includes(m));
        const b = latestFact(recent.filter((f) => f !== a && f.entities.includes(link.entity)));
        const strength = (weight ?? 0) * Math.max(0, 1 - age(a) / c.recencyDays);
        if (!weight || !spill.length || !b || strength < c.minStrength) continue;
        const key = `${a.pk}|${link.relation}|${link.entity}`;
        if ((out.get(key)?.value ?? -1) < strength) out.set(key, { kind: "crossModal", key, entity: from, value: strength, unit: "strength", evidence: [ev(a, "member", link.relation), ev(b, "evidence", link.relation)] });
      }
    }
  }
  return sorted([...out.values()]);
}

function penaltyAbatement(i: PatternInput): Pattern[] {
  const c = PATTERNS.penaltyAbatement;
  const ceilings = i.facts.filter((f) => (f.role === "ceiling" || f.role === "ratchet") && f.qty !== null && f.qty > 0);
  const abatements = i.facts.filter((f) => f.role === "abatement" && f.qty !== null);
  const out: Pattern[] = [];
  for (const t of i.facts.filter((f) => f.role === "tech" && (f.trl ?? 0) >= c.minTrl)) {
    const near = reach(i, t.entities);
    for (const a of abatements.filter((x) => shared(near, x.entities))) {
      for (const k of ceilings.filter((x) => x.unit === a.unit && shared(reach(i, a.entities), x.entities))) {
        const ratio = (a.qty as number) / (k.qty as number);
        if (ratio >= 1 - c.band) out.push({ kind: "penaltyAbatement", key: `${t.pk}|${a.pk}|${k.pk}`, entity: shared(near, a.entities) as string, value: ratio, unit: "ratio", evidence: [ev(t, "key"), ev(a, "evidence"), ev(k, "evidence")] });
      }
    }
  }
  return sorted(out);
}

export const DETECTORS = { velocity, mandateCapacity, leadLag, crossModal, penaltyAbatement } as const;
