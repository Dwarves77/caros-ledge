// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the five pattern detectors (C3), pure functions over the facts a loader joined: no read, no clock but `input.now`, no quantity, rate, price or factor typed here (each threshold is in data/patterns.json, each quantity a stored row's).
// Detection is symmetric across surfaces: any fact of any table may be the first vertex. A detector returns its patterns sorted by key, each with the evidence rows by edge kind.
//   P1 velocity: three or more independent sources citing one entity in a window, at a share of the corpus's flow above the share the entity held in the trailing baseline window; no flow and no earlier citations, no baseline. The clock is the document date of the capture a claim was read from
//      (never the day its item was added): an undated claim is in neither the window, the baseline nor the flow.
//   P2 mandate and capacity: a dated ratchet and a capacity row filed under a shared entity, the capacity landing after the ratchet or holding less than it mandates in the same unit.
//   P3 lead and lag: a pending trigger a set number of days out and a move on a shared entity in the days before.
//   P4 cross-modal: a mandate or a move in one mode's entity and recent rows in a mode the entity's relation (feedstock, competition, grid zone, corridor) carries it to.
//   P5 penalty and abatement: a technology at the maturity floor whose derived abatement cost crosses, or comes within the band of, a statutory ceiling in the same unit.
import { WINDOWS, type Relation } from "@/core/coupling/coupling";

import { PATTERNS } from "./config";
import type { Evidence, Fact, Pattern, PatternInput } from "./types";

const MS_PER_DAY = 86_400_000;
const dayStartMs = (d: string): number => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
const todayMs = (now: Date): number => dayStartMs(now.toISOString());
/** Whole days from `d` to now (negative for a day ahead). */
const ageDays = (d: string, now: Date): number => Math.floor((todayMs(now) - dayStartMs(d)) / MS_PER_DAY);
const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
const monthsBetween = (a: string, b: string): number => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
const ev = (f: Fact, kind: Evidence["kind"], relation?: Relation, marker?: Evidence["marker"]): Evidence => ({ table: f.table, pk: f.pk, kind, entities: f.entities, role: f.role, ...(f.dueSource ? { dueSource: f.dueSource } : {}), ...(f.trl !== null ? { trl: f.trl } : {}), ...(f.onto ? { onto: f.onto } : {}), ...(relation ? { relation } : {}), ...(marker ? { marker } : {}) });
const clsOf = (i: PatternInput, e: string): string => i.classOf?.(e) ?? "";
const modesOfE = (i: PatternInput, e: string): string[] => i.modesOf?.(e) ?? [];
/** Rows of one item that carry one copied date and one set of entities are one finding, not many: an item-level date copied onto every object of the item must not multiply a pattern. The representative is the lowest key; `members` says how many it stands for. */
const collapseCopies = (fs: readonly Fact[]): { fact: Fact; members: number }[] => {
  const by = new Map<string, Fact[]>();
  const keyOf = (f: Fact): string => `${f.item ?? f.pk}|${f.due ?? ""}|${f.dueSource ?? ""}|${[...f.entities].sort().join()}`;
  for (const f of fs) by.set(keyOf(f), [...(by.get(keyOf(f)) ?? []), f]);
  return [...by.values()].map((g) => ({ fact: [...g].sort((a, b) => a.pk.localeCompare(b.pk))[0] as Fact, members: g.length }));
};
/** The first specific entity (not a bare mode, jurisdiction or organisation) two rows meet at: an entity the second row is filed under that the first row's reach holds (the entities it is filed under and the entities one relation away from them). A jurisdiction or an organisation reaches nothing; a mode reaches only its lane corridors (genericReach), so the rows of a lane meet the rows filed under its mode, but the fuels of a mode are not reached from it; the mode itself is never the point two rows meet at. */
const meet = (i: PatternInput, from: readonly string[], to: readonly string[], memo: Map<string, Set<string>>): string | undefined => {
  const k = [...from].sort().join();
  let r = memo.get(k);
  if (!r) {
    // a specific entity reaches over every relation; a mode only over the relations of genericReach (its lane corridors); a jurisdiction or an organisation over none
    r = new Set(from.flatMap((e) => [e, ...(PATTERNS.inertClasses.includes(clsOf(i, e)) ? [] : i.related(e).filter((x) => !PATTERNS.genericClasses.includes(clsOf(i, e)) || PATTERNS.genericReach.includes(x.relation)).map((x) => x.entity))]));
    memo.set(k, r);
  }
  return [...to].sort().find((e) => r.has(e) && !PATTERNS.genericClasses.includes(clsOf(i, e)));
};
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
  const claims = i.facts.filter((f) => f.role === "claim" && f.docAt && !c.excludeKinds.includes(f.kind ?? ""));
  const out: Pattern[] = [];
  for (const [entity, list] of groupBy(claims, (f) => f.entities)) {
    if (c.excludeClasses.includes(clsOf(i, entity))) continue;
    for (const w of [...c.windowsDays].sort((a, b) => a - b)) {
      const members = list.filter((f) => ageDays(f.docAt as string, i.now) >= 0 && ageDays(f.docAt as string, i.now) < w);
      const distinct = Math.max(new Set(members.map((f) => f.tier)).size, new Set(members.map((f) => f.surface)).size);
      if (new Set(members.map((f) => f.source).filter(Boolean)).size < c.minSources || distinct < c.minDistinct) continue;
      const base = list.filter((f) => ageDays(f.docAt as string, i.now) >= w && ageDays(f.docAt as string, i.now) < w + c.baselineDays);
      // an entity new to the corpus has no baseline: its first appearance is coverage, not velocity
      if (i.flow && base.length < c.minBaseline) continue;
      const flow = (from: number, to: number): number => (i.flow ? [...i.flow].reduce((n, [d, k]) => n + (ageDays(d, i.now) >= from && ageDays(d, i.now) < to ? k : 0), 0) : 0);
      const [inWindow, inBaseline] = [flow(0, w), flow(w, w + c.baselineDays)];
      // the share of the corpus's flow the entity holds in the window against the share it held before; a window or baseline with no flow defines none
      const [shareNow, shareBefore] = [members.length / inWindow, Math.max(base.length, 1) / inBaseline];
      if (i.flow ? !inWindow || !inBaseline || shareNow <= base.length / inBaseline : i.carry === undefined) continue;
      // the pattern stands on every member, but its edges are the most recent ones (patterns.json caps them) and one summary edge, on the latest baseline claim, with the counts and the windows
      const kept = [...members].sort((a, b) => String(b.docAt).localeCompare(String(a.docAt)) || a.pk.localeCompare(b.pk)).slice(0, c.maxEvidence);
      const summary = { members: members.length, baseline: base.length, windowDays: w, baselineDays: c.baselineDays };
      const anchor = latestFact(base);
      out.push({ kind: "velocity", key: `${entity}|${w}`, entity, value: i.flow ? shareNow / shareBefore : (i.carry as number), unit: "ratio", evidence: [...kept.map((f) => ev(f, "member")), ...(anchor ? [{ ...ev(anchor, "key"), summary }] : [])] });
      break;
    }
  }
  return sorted(out);
}

const CONDITION_RANK: Record<string, number> = { timing_gap: 3, quantity_shortfall: 2, dated_vs_measured: 1 };
const sideOf = (f: Fact): string => (f.due && f.qty !== null ? "full" : f.due ? "date_only" : f.qty !== null ? "qty_only" : "empty");

function mandateCapacity(i: PatternInput): Pattern[] {
  const capacities = i.facts.filter((f) => f.role === "capacity");
  const memo = new Map<string, Set<string>>();
  const out: Pattern[] = [];
  for (const { fact: r, members } of collapseCopies(i.facts.filter((f) => f.role === "ratchet"))) {
    if (r.due && (ageDays(r.due, i.now) > 0 || monthsBetween(dayOf(todayMs(i.now)), r.due) > horizonMonths)) continue;
    const best = new Map<string, { c: Fact; condition: string; value: number; unit: string; entity: string }>();
    for (const c of capacities) {
      const entity = meet(i, r.entities, c.entities, memo);
      if (!entity) continue;
      const gap = r.due && c.due && c.due > r.due ? monthsBetween(r.due, c.due) : null;
      const short = r.qty !== null && c.qty !== null && r.unit === c.unit && r.qty > 0 && c.qty < r.qty ? (r.qty - c.qty) / r.qty : null;
      // a dated mandate and a measured constraint on one entity, neither a timing gap nor a shortfall in itself: one side carries only a date, the other only a quantity (or the units differ), and the pattern says so
      const partial = (r.due && c.qty !== null) || (r.qty !== null && c.due);
      const [condition, value, unit] = gap !== null ? ["timing_gap", gap, "months"] : short !== null ? ["quantity_shortfall", short, "ratio"] : partial ? ["dated_vs_measured", c.qty ?? 0, c.unit ?? "qty"] : [null, 0, ""];
      if (!condition) continue;
      const held = best.get(c.table);
      if (!held || (CONDITION_RANK[condition as string] ?? 0) > (CONDITION_RANK[held.condition] ?? 0) || (condition === held.condition && (value as number) > held.value)) best.set(c.table, { c, condition: condition as string, value: value as number, unit: unit as string, entity });
    }
    for (const { c, condition, value, unit, entity } of best.values()) {
      const marker = { condition, ratchet_side: sideOf(r), capacity_side: sideOf(c), joined_class: clsOf(i, entity), ratchets_collapsed: members, ...(r.dueSource ? { due_source: r.dueSource } : {}) };
      out.push({ kind: "mandateCapacity", key: `${r.pk}|${c.pk}`, entity, value, unit, evidence: [ev(r, "key", undefined, marker), ev(c, "evidence")], ...(r.due ? { keyDue: r.due } : {}) });
    }
  }
  return sorted(out);
}

function leadLag(i: PatternInput): Pattern[] {
  const c = PATTERNS.leadLag;
  const moves = i.facts.filter((f) => f.at && ageDays(f.at, i.now) >= 0 && ageDays(f.at, i.now) < c.moveWindowDays && ((f.role === "series" && Math.abs(f.qty ?? 0) >= c.minMove) || ["tech", "move", "capacity"].includes(f.role) || (f.role === "claim" && f.surface !== "regulations" && !PATTERNS.velocity.excludeKinds.includes(f.kind ?? ""))));
  const out: Pattern[] = [];
  const memo = new Map<string, Set<string>>();
  for (const t of i.facts.filter((f) => f.role === "trigger" && c.triggerKinds.includes(f.kind ?? "") && f.due)) {
    const lead = -ageDays(t.due as string, i.now);
    if (lead < c.leadDays[0] || lead > c.leadDays[1]) continue;
    const bySurface = groupBy(moves.filter((m) => meet(i, t.entities, m.entities, memo)), (m) => [m.surface]);
    const picked = [...bySurface.values()].map((fs) => latestFact(fs) as Fact);
    const entity = picked.length ? meet(i, t.entities, picked[0]?.entities ?? [], memo) : undefined;
    if (picked.length && entity) out.push({ kind: "leadLag", key: t.pk, entity, value: lead, unit: "days", evidence: [ev(t, "key", undefined, { joined_class: clsOf(i, entity), trigger_kind: t.kind ?? "" }), ...picked.sort((a, b) => a.pk.localeCompare(b.pk)).map((m) => ev(m, "evidence"))], keyDue: t.due as string });
  }
  return sorted(out);
}

function crossModal(i: PatternInput): Pattern[] {
  const c = PATTERNS.crossModal;
  const modesOf = (e: string): string[] => modesOfE(i, e);
  const age = (f: Fact): number => (f.at ? Math.max(0, ageDays(f.at, i.now)) : f.due ? Math.abs(ageDays(f.due, i.now)) : Infinity);
  const starts = i.facts.filter((f) => (f.role === "ratchet" && f.due && age(f) <= c.recencyDays) || (f.role === "series" && Math.abs(f.qty ?? 0) >= c.minMove && age(f) <= c.recencyDays));
  const recent = i.facts.filter((f) => age(f) <= c.recencyDays);
  const out = new Map<string, Pattern>();
  for (const a of starts) {
    for (const from of a.entities) {
      // a mode or a hub is where a mandate is filed, not what it starts from: starting there fans one mandate out to every relation of the mode
      if (c.excludeClasses.includes(clsOf(i, from))) continue;
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
  const ceilings = i.facts.filter((f) => f.role === "ceiling" && f.qty !== null && f.qty > 0);
  const abatements = i.facts.filter((f) => f.role === "abatement" && f.qty !== null);
  const out = new Map<string, Pattern>();
  const memo = new Map<string, Set<string>>();
  for (const t of i.facts.filter((f) => f.role === "tech" && (f.trl ?? 0) >= c.minTrl)) {
    const lowTrl = (t.trl ?? 0) < c.maturityTrl;
    const paired = new Set<string>();
    for (const a of abatements.filter((x) => meet(i, t.entities, x.entities, memo))) {
      for (const k of ceilings.filter((x) => x.unit === a.unit && meet(i, a.entities, x.entities, memo))) {
        const ratio = (a.qty as number) / (k.qty as number);
        if (ratio < 1 - c.band) continue;
        paired.add(k.pk);
        const key = `${t.pk}|${a.pk}|${k.pk}`;
        out.set(key, { kind: "penaltyAbatement", key, entity: meet(i, t.entities, a.entities, memo) as string, value: ratio, unit: "ratio", evidence: [ev(t, "key", undefined, { trl: t.trl ?? 0, ...(lowTrl ? { gap: "maturity_gap" } : {}) }), ev(a, "evidence"), ev(k, "evidence")] });
      }
    }
    // a ceiling and a technology that share an entity or a reach are a finding even when no abatement cost in the ceiling's unit stands between them: the pattern says which gap it carries for the synthesis to read
    for (const k of ceilings.filter((x) => !paired.has(x.pk) && meet(i, t.entities, x.entities, memo))) {
      const sameUnit = abatements.some((a) => a.unit === k.unit && meet(i, t.entities, a.entities, memo));
      const gap = lowTrl ? "maturity_gap" : sameUnit ? "no_crossing" : "unit_gap";
      const key = `${t.pk}|-|${k.pk}`;
      out.set(key, { kind: "penaltyAbatement", key, entity: meet(i, t.entities, k.entities, memo) as string, value: t.trl ?? 0, unit: "trl", evidence: [ev(t, "key", undefined, { trl: t.trl ?? 0, gap, ceiling_unit: k.unit ?? "", abatement_present: abatements.some((a) => meet(i, t.entities, a.entities, memo) !== undefined) }), ev(k, "evidence")] });
    }
  }
  return sorted([...out.values()]);
}

/** P6 regulatory stacking: two or more distinct instruments (the item each obligation or forward event belongs to) with an active ratchet, ceiling or deadline on one non-generic entity (a fuel, feedstock, node, hub or corridor, or a mode together with a jurisdiction; a bare mode, a jurisdiction or an organisation is generic and stacks nothing) within one window. */
function regulatoryStacking(i: PatternInput): Pattern[] {
  const c = PATTERNS.regulatoryStacking;
  const today = dayOf(todayMs(i.now));
  const [lo, hi] = [dayOf(todayMs(i.now) - c.pastDays * MS_PER_DAY), dayOf(todayMs(i.now) + c.futureDays * MS_PER_DAY)];
  // a ceiling returned as a fact is in force today; a ratchet and a deadline count on the day they fall due
  const dated = i.facts.flatMap((f) => {
    const day = f.role === "ceiling" ? today : f.role === "ratchet" || (f.role === "trigger" && !f.resolved) ? f.due : null;
    return f.item && day && day >= lo && day <= hi ? [{ f, day }] : [];
  });
  const keysOf = (es: readonly string[]): string[] => {
    const own = es.filter((e) => c.entityClasses.includes(clsOf(i, e)));
    const modes = es.filter((e) => clsOf(i, e) === "mode");
    const juris = es.filter((e) => clsOf(i, e) === "jurisdiction");
    return [...own, ...modes.flatMap((m) => juris.map((j) => [m, j].sort().join("+")))];
  };
  const groups = groupBy(dated, (d) => keysOf(d.f.entities));
  const out: Pattern[] = [];
  for (const [key, list] of groups) {
    const rows = [...list].sort((a, b) => a.day.localeCompare(b.day) || a.f.pk.localeCompare(b.f.pk));
    let best: typeof rows = [];
    for (const start of rows) {
      const inWin = rows.filter((r) => r.day >= start.day && dayStartMs(r.day) - dayStartMs(start.day) <= c.windowDays * MS_PER_DAY);
      if (new Set(inWin.map((r) => r.f.item)).size > new Set(best.map((r) => r.f.item)).size) best = inWin;
    }
    const instruments = [...new Set(best.map((r) => r.f.item as string))].sort();
    if (instruments.length < c.minInstruments) continue;
    // every instrument keeps its earliest row, then the rest in date order up to the cap
    const first = instruments.map((ins) => best.find((r) => r.f.item === ins) as (typeof best)[number]);
    const picked = [...first, ...best.filter((r) => !first.includes(r))].slice(0, c.maxEvidence);
    const lead = [...picked].sort((a, b) => a.day.localeCompare(b.day) || a.f.pk.localeCompare(b.f.pk))[0] as (typeof best)[number];
    const marker = { instruments: instruments.length, rows: best.length, window_start: best[0]?.day ?? "", window_end: best[best.length - 1]?.day ?? "", fallback_dates: best.filter((r) => r.f.dueSource && r.f.dueSource !== "due_date" && r.f.dueSource !== "event_date").length, scope: key.includes("+") ? "mode_jurisdiction" : clsOf(i, key) || "entity" };
    out.push({ kind: "regulatoryStacking", key, entity: key.split("+").sort()[0] as string, value: instruments.length, unit: "instruments", evidence: picked.map((r) => ev(r.f, r === lead ? "key" : "member", undefined, r === lead ? marker : undefined)), keyDue: lead.day });
  }
  // one finding filed under several entity keys (a ceiling that names five modes) is one pattern: the keys that carry exactly the same rows merge into one, keyed by all of them
  const bySig = new Map<string, Pattern>();
  for (const p of sorted(out)) {
    const sig = p.evidence.map((e) => `${e.table}/${e.pk}`).sort().join();
    const held = bySig.get(sig);
    if (!held) bySig.set(sig, p);
    else bySig.set(sig, { ...held, key: [...new Set([...held.key.split("|"), p.key])].sort().join("|") });
  }
  return sorted([...bySig.values()]);
}

export const DETECTORS = { velocity, mandateCapacity, leadLag, crossModal, penaltyAbatement, regulatoryStacking } as const;
