// Ported from old_repo/scripts/research/research-walker.mjs (lines 28-205)
// Ported from old_repo/scripts/research/research-walker.mjs (lines 264-299)
// Ported from old_repo/scripts/research/research-walker.mjs (lines 303-436)
// The free research walker: OpenAlex searched for a topic and for the open needs, grey-literature sources rated by the class table, each work's publisher PLACED by a
// built-in class rule or a committed host verdict (an unplaceable host is named residue, never a rejection and never a guessed tier), and every candidate run through the
// ONE mint chokepoint (dry first; the real mint only on an apply that passed every gate). No metered call; the sources and needs are inputs, never hard-coded examples.
import { registerCitedSource } from "@/core/producers/rows-file";
import type { ProducerDeps } from "@/core/producers/deps";
import type { ParseOut, ProducerCtx, ProducerSpec } from "@/core/producers/runner";
import { runProducer, type RunInput } from "@/core/producers/runner";
import { openAlexGet, searchWorks, type OpenAlexDeps } from "@/core/http/openalex";
import type { Rec } from "@/core/producers/upsert-plan";
import { hostOf } from "@/core/shared";
import { isDoiResolverHost, placeHostWithVerdicts, registerSource, type HostVerdictRef } from "@/core/sources";
import { mintItem, type MintCtx } from "@/features/mint";

export const RESIDUE_REASON = "awaiting host verdict batch";
export const MAX_NEEDS = 10;
const PER_NEED = 5;
const MINT_NEW = ["minted", "retyped", "linked"];

/** The deps the walker adds to the producer deps: the mint chokepoint's context and the committed host verdicts. */
export type WalkerDeps = ProducerDeps & { mint: MintCtx; verdicts?: ReadonlyMap<string, HostVerdictRef> };
export interface Need { subject_ref: string; need: string; namespace?: string }
export interface WalkInput { query?: string; needs?: Need[]; greyLit?: Array<{ name: string; url: string }> }
export interface WalkCandidate { title: string; sourceUrl: string; publishedDate: string | null; openAlexId?: string | null; forNeed?: string }

/** A work with a landing page (or DOI) and a title; anything else is no candidate. */
export function normalizeOpenAlexWork(work: Rec | null | undefined): WalkCandidate | null {
  const url = ((work?.primary_location as { landing_page_url?: string } | undefined)?.landing_page_url) || (work?.doi as string | undefined) || null;
  return url && work?.title ? { title: String(work.title), sourceUrl: url, publishedDate: (work.publication_date as string) ?? null, openAlexId: (work.id as string) ?? null } : null;
}
export async function searchOpenAlexWorks(q: { query: string; perPage?: number }, deps: OpenAlexDeps = {}): Promise<WalkCandidate[]> {
  const body = await searchWorks({ search: q.query, perPage: q.perPage ?? 10 }, deps);
  return (body?.results ?? []).map(normalizeOpenAlexWork).filter((c): c is WalkCandidate => c !== null);
}
/** The first `max` needs by subject ref (a stable order), so a bounded pass is repeatable. */
export const boundNeeds = (needs: readonly Need[], max = MAX_NEEDS): Need[] => [...needs].sort((a, b) => a.subject_ref.localeCompare(b.subject_ref)).slice(0, max);

export type Placement = { placed: true; host: string; placedBy: "built-in rule" | "host verdict"; tier: number; verdictBatch: string | null } | { placed: false; host: string; reason: string };
/** Place a work's publisher: a DOI resolver host says nothing about the publisher; the class table, then a committed verdict; else the named residue (never a guessed tier). */
export function placePublisher(sourceUrl: string, verdicts: ReadonlyMap<string, HostVerdictRef> | null | undefined): Placement {
  const host = hostOf(sourceUrl);
  if (!host) return { placed: false, host: "", reason: "no resolvable host" };
  if (isDoiResolverHost(host)) return { placed: false, host: "", reason: "publisher host unresolved from DOI" };
  const p = placeHostWithVerdicts(host, null, verdicts);
  if (p.tier == null) return { placed: false, host, reason: RESIDUE_REASON };
  return p.via === "verdict" ? { placed: true, host, placedBy: "host verdict", tier: p.tier, verdictBatch: p.verdict?.batch ?? null } : { placed: true, host, placedBy: "built-in rule", tier: p.tier, verdictBatch: null };
}

export const buildMintSeed = (c: WalkCandidate, o: { sourceId?: string | null } = {}): Rec => ({ title: c.title, source_url: c.sourceUrl, item_type: "research_finding", domain: 7, ...(c.publishedDate ? { added_date: c.publishedDate } : {}), ...(o.sourceId ? { source_id: o.sourceId } : {}) });

const walkerDeps = (ctx: ProducerCtx): WalkerDeps => {
  const d = ctx.deps as WalkerDeps;
  if (!d.mint) throw new Error("the research walker needs deps.mint (the mint chokepoint's context): it mints only through mintItem");
  return d;
};

export const researchWalker: ProducerSpec = {
  name: "research-walker",
  table: "intelligence_items",
  licenceKey: null,
  enabled: false,
  enabledRuling: "operator 2026-10-04: no data population before every build layer is complete; the walk is proven dry",
  killSwitchEnv: "RESEARCH_WALKER_ENABLED",
  gap: "no walk input: pass a topic query, the open needs and the grey-literature sources",
  /** The document is `{ topic: works[], needs: [{...need, works}], greyLit }`: fetched from OpenAlex for the input's query and needs, or injected as a recorded response. */
  async fetchDoc(ctx) {
    const w = (ctx.input.rowsFile ?? {}) as WalkInput;
    const oa: OpenAlexDeps = { fetch: ctx.deps.fetch as never, ...(ctx.deps.sleep ? { sleep: ctx.deps.sleep } : {}) };
    const works = async (q: string, n: number) => ((await openAlexGet<{ results?: Rec[] }>("/works", { search: q, per_page: n }, oa))?.results ?? []);
    const needs = [];
    for (const n of boundNeeds(w.needs ?? [])) {
      try {
        needs.push({ ...n, works: await works(n.need, PER_NEED), error: null });
      } catch (e) {
        needs.push({ ...n, works: [], error: String((e as Error)?.message ?? e) });
      }
    }
    return { text: w.query || needs.length || w.greyLit?.length ? JSON.stringify({ topic: w.query ? await works(w.query, 10) : [], needs, greyLit: w.greyLit ?? [] }) : "" };
  },
  async parse(doc, ctx): Promise<ParseOut<Rec>> {
    const d = walkerDeps(ctx);
    const bundle = JSON.parse(doc.text ?? "{}") as { topic?: Rec[]; needs?: Array<Need & { works?: Rec[]; error?: string | null }>; greyLit?: Array<{ name: string; url: string }> };
    const seen = new Set<string>();
    const cands: WalkCandidate[] = [];
    for (const w of bundle.topic ?? []) {
      const c = normalizeOpenAlexWork(w);
      if (c && !seen.has(c.sourceUrl)) {
        seen.add(c.sourceUrl);
        cands.push(c);
      }
    }
    for (const n of bundle.needs ?? []) {
      for (const w of n.works ?? []) {
        const c = normalizeOpenAlexWork(w);
        if (c && !seen.has(c.sourceUrl)) {
          seen.add(c.sourceUrl);
          cands.push({ ...c, forNeed: n.subject_ref });
        }
      }
    }
    const warnings: string[] = (bundle.needs ?? []).filter((n) => n.error).map((n) => `need ${n.subject_ref}: search failed: ${n.error}`);
    const rows: Rec[] = [];
    const unplaced = new Map<string, string>();
    const counts = { needs_searched: (bundle.needs ?? []).length, candidates: 0, would_register: 0, would_mint: 0, already_held: 0, rejected: 0, residue: 0, grey_lit: 0, grey_lit_rated: 0 };
    // Grey-literature sources are rated by the class table (rule 18); an unclassifiable one is a named refusal.
    const grey: WalkCandidate[] = [];
    for (const g of bundle.greyLit ?? []) {
      counts.grey_lit += 1;
      const r = await registerCitedSource({ url: g.url, title: g.name }, { sb: null, verdicts: d.verdicts ?? null });
      if (r.refused && r.wouldRegisterTier === undefined) warnings.push(`grey-lit ${g.url}: source-resolution-failed: ${r.reason}`);
      else {
        counts.grey_lit_rated += 1;
        grey.push({ title: `Candidate from ${g.name}: ${g.url.split("/").pop()}`, sourceUrl: g.url, publishedDate: null });
      }
    }
    const placed = new Map<string, Placement>();
    for (const c of cands) {
      const p = placePublisher(c.sourceUrl, d.verdicts);
      if (!p.placed) {
        counts.residue += 1;
        warnings.push(`${c.sourceUrl}: residue: ${p.reason}${p.host ? ` (host ${p.host})` : ""}`);
        if (p.host) unplaced.set(p.host, c.sourceUrl);
      } else {
        placed.set(c.sourceUrl, p);
        counts.would_register += 1;
      }
    }
    for (const c of [...grey, ...cands.filter((x) => placed.has(x.sourceUrl))]) {
      counts.candidates += 1;
      const seed = buildMintSeed(c);
      // The publisher is registered only on an apply; the dry check runs the gates as if it already were (a preset source id), so dedup and relevance are still tested.
      const res = await mintItem({ seed: { ...seed, source_id: `preview:${hostOf(c.sourceUrl)}` } as never, origin: "first_fetch" }, d.mint, { dry: true });
      if (res.outcome === "exists") counts.already_held += 1;
      else if (MINT_NEW.includes(res.outcome)) {
        counts.would_mint += 1;
        rows.push({ ...seed, __tier: ((placed.get(c.sourceUrl) as { tier?: number } | undefined)?.tier) ?? null, __host: hostOf(c.sourceUrl) });
      } else {
        counts.rejected += 1;
        warnings.push(`${c.sourceUrl}: rejected:${res.outcome}: ${res.reasons.join("; ")}`);
      }
    }
    ctx.state.unplaced = [...unplaced].map(([host, sample_url]) => ({ host, sample_url }));
    return { rows, warnings, counts };
  },
  /** Apply: each publisher is registered (provisional) at its placed tier, then the item is minted through the chokepoint with its source id. */
  async persist(ctx, rows) {
    const d = walkerDeps(ctx);
    const c = { minted: 0, already_held: 0, mint_refused: 0, registered: 0 };
    for (const r of rows) {
      const { __tier, __host, ...seed } = r as Rec & { __tier: number | null; __host: string | null };
      let sourceId: string | null = null;
      if (__tier != null) {
        const reg = await registerSource(d.mint.sb, { url: String(seed.source_url), name: __host ?? String(seed.source_url), base_tier: __tier, extra: { status: "provisional" } });
        sourceId = reg.source_id;
        if (reg.created) c.registered += 1;
      }
      const res = await mintItem({ seed: { ...seed, ...(sourceId ? { source_id: sourceId } : {}) } as never, origin: "first_fetch" }, d.mint, { dry: false });
      if (MINT_NEW.includes(res.outcome)) c.minted += 1;
      else if (res.outcome === "exists") c.already_held += 1;
      else c.mint_refused += 1;
    }
    return c;
  },
};

/** Walk: a dry plan unless `dry: false` and every gate passes. The result's notes name the residue hosts awaiting a verdict batch. */
export const walkResearch = (deps: WalkerDeps, input: Omit<RunInput, "rowsFile"> & { walk: WalkInput }) => runProducer(deps, { ...input, rowsFile: input.walk, spec: researchWalker });
