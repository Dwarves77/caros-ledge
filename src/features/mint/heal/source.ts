// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 1443-1493)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 1884-2014)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 3232-3482)
// Orphan figures, rule 18: "get the source, then rate the source". For a Gate A orphan no capture carries, take the URLs the item already cites (the owning section first,
// at most 5), capture each through the free transports, and when a capture carries the figure verbatim, register-and-rate that page through the registry (the tier is the
// class table's, never typed here; a host that places in no class or is permanently unregistered is worklisted and the figure stays an orphan) and ground the figure on it.
// A page that does not carry the figure is followed ONE hop to a link at the same institution (at most 3). Bounded per item. The source is registered only once the figure
// is found on it (the old pass registered first, then looked).
import type { Db } from "@/core/db";
import { capture, FetchHoldError, type CaptureResult } from "@/core/fetch";
import { institutionKey, registerAndRate } from "@/core/sources";
import { canonicalUrl } from "@/core/shared";
import type { LedgerOp } from "@/core/grounding/ledger";

import type { CaptureDeps } from "../deps";

import { briefSentenceOf, findOwningSection, locateSpan, NO_VERBATIM_SPAN, supportingSentence, type Capture, type HealClaim, type HealSource, type IndexCache, type Orphan, type SourcesIndex } from "./ground";

const MAX_CANDIDATES_PER_ORPHAN = 5;
const MAX_ATTEMPTS_PER_ITEM = 25;
const MAX_HOP_LINKS = 3;
const CITED_URL = /https?:\/\/(?:[^\s()\]}"'<>]|\([^\s()]*\))+/g;
const HREF = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gis;

export interface SourceCtx {
  sb: Db;
  fetch: CaptureDeps;
  dry: boolean;
  nowIso: string;
  itemId: string;
  idx: SourcesIndex;
  cache: IndexCache;
  /** Per-run capture cache keyed by canonical URL (a cited page is fetched once per run). */
  capCache: Map<string, CaptureResult>;
  captures: Capture[];
  claims: HealClaim[];
  /** The brief the orphans are in: the claim of a grounded orphan is the brief's own sentence. */
  fullBrief: string | null;
  /** The ledger writes this pass plans; the caller applies them as ONE transaction with the rest of the heal. */
  ops: LedgerOp[];
  sections: { id: string; content_md: string | null }[];
  /** The section a new claim belongs to: the owning section of the token, else the record_facts section (created when absent). */
  sectionFor(token: string): Promise<string>;
}
export interface SourceOutcome { token: string; outcome: string; url?: string; sourceId?: string; tier?: number | null }

/** Cited URLs for a token: the owning section's first, then the cited-source URLs of the item's claims, deduplicated, at most 5. */
function candidateUrls(token: string, sections: SourceCtx["sections"], claims: HealClaim[], idx: SourcesIndex): string[] {
  const owning = findOwningSection(token, sections);
  const urls: string[] = [];
  for (const s of owning ? [owning] : sections) for (const m of (s.content_md ?? "").matchAll(CITED_URL)) urls.push(m[0]);
  for (const c of claims) {
    const u = c.source_id ? idx.byId.get(c.source_id)?.url : null;
    if (u) urls.push(u);
  }
  return [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(0, MAX_CANDIDATES_PER_ORPHAN);
}
/** Same-institution links of a captured page, at most 3. */
function hopLinks(html: string | null | undefined, base: string): string[] {
  const out = new Set<string>();
  for (const m of String(html ?? "").matchAll(HREF)) {
    const raw = (m[2] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel):/i.test(raw)) continue;
    if (!URL.canParse(raw, base)) continue;
    const abs = new URL(raw, base).toString();
    if (/^https?:\/\//i.test(abs) && institutionKey(abs) && institutionKey(abs) === institutionKey(base)) out.add(abs);
  }
  return [...out].slice(0, MAX_HOP_LINKS);
}

export async function capturePage(ctx: SourceCtx, url: string): Promise<Capture | null> {
  const key = canonicalUrl(url) ?? url;
  const have = ctx.captures.find((c) => canonicalUrl(c.result_url) === key && c.result_content.trim().length > 200);
  if (have) return have;
  let res = ctx.capCache.get(key);
  if (!res) {
    res = await capture(url, { family: "generic" }, ctx.fetch);
    ctx.capCache.set(key, res);
  }
  if (!res.usable || !res.text) return null;
  const ins = await ctx.sb.from("agent_run_searches").insert({ intelligence_item_id: ctx.itemId, search_query: "heal-provenance:source", result_url: url, result_title: res.title, result_index: ctx.captures.length, result_content: res.text, searched_at: ctx.nowIso }).select("id").single();
  const id = (ins.data as { id?: string } | null)?.id;
  if (ins.error || !id) throw new Error(`pool row for ${url} not written: ${ins.error?.message ?? "no row"}`);
  const cap = { id, result_url: url, result_content: res.text, html: res.html };
  ctx.captures.push(cap);
  return cap;
}
/** The rated source for a page: the registry row when known, else register-and-rate. Null when the host cannot be rated (worklist or never registered). */
async function ratedSource(ctx: SourceCtx, url: string): Promise<{ source: HealSource; tier: number | null } | { refused: string }> {
  const known = ctx.idx.byCanonUrl.get(canonicalUrl(url) ?? "");
  if (known) return { source: known, tier: known.base_tier };
  const reg = await registerAndRate(ctx.sb, url);
  if (reg.status === "worklist" || reg.status === "refused") return { refused: `${reg.status}:${reg.reason.slice(0, 80)}` };
  const row: HealSource = { id: reg.source_id, url, base_tier: reg.tier, institution_id: reg.institution_id };
  ctx.idx.byId.set(row.id, row);
  ctx.idx.byCanonUrl.set(canonicalUrl(url) ?? url, row);
  return { source: row, tier: reg.tier };
}

async function groundOn(ctx: SourceCtx, o: Orphan, url: string, cap: Capture, via?: string): Promise<SourceOutcome | null> {
  if (!locateSpan(o.token, cap, ctx.cache)) return null;
  const sentence = briefSentenceOf(o.token, ctx.fullBrief);
  const span = sentence ? supportingSentence(o.token, sentence, cap, ctx.cache) : null;
  // The page carries the figure but no sentence that says what the brief says: withheld, and the source is NOT registered for it.
  if (!sentence || !span) return { token: o.token, url, outcome: NO_VERBATIM_SPAN };
  const rated = await ratedSource(ctx, url);
  if ("refused" in rated) return { token: o.token, url, outcome: `unrated_host:${rated.refused}` };
  const sectionId = await ctx.sectionFor(o.token);
  ctx.ops.push({ op: "claim", claim_id: null, row: { section_row_id: sectionId, claim_text: sentence, claim_kind: "FACT", source_span: span, source_id: rated.source.id, search_result_id: cap.id } });
  ctx.claims.push({ id: `pending:${ctx.ops.length}`, claim_kind: "FACT", claim_text: sentence, source_span: span, source_id: rated.source.id, search_result_id: cap.id, section_row_id: sectionId });
  return { token: o.token, url, sourceId: rated.source.id, tier: rated.tier, outcome: via ? `grounded_one_hop_from:${via}` : "grounded" };
}

/** Source-and-rate every orphan; returns one outcome per orphan. A fetch hold stops the pass (the orphans stay orphans) and is reported, never thrown past the item. */
export async function sourceOrphans(ctx: SourceCtx, orphans: Orphan[]): Promise<SourceOutcome[]> {
  const out: SourceOutcome[] = [];
  let attempts = 0;
  for (const o of orphans) {
    if (attempts >= MAX_ATTEMPTS_PER_ITEM) { out.push({ token: o.token, outcome: "bound_hit" }); continue; }
    const urls = candidateUrls(o.token, ctx.sections, ctx.claims, ctx.idx);
    if (!urls.length) { out.push({ token: o.token, outcome: "no_candidate_url" }); continue; }
    if (ctx.dry) { attempts += urls.length; out.push({ token: o.token, outcome: "would_capture_and_ground" }); continue; }
    let done: SourceOutcome | null = null;
    // Only a grounded outcome ends the search; an unrated host is recorded and the next candidate still gets its turn.
    const settle = (r: SourceOutcome | null): SourceOutcome | null => (r && r.outcome.startsWith("grounded") ? r : (r && out.push(r), null));
    try {
      for (const url of urls) {
        attempts += 1;
        const cap = await capturePage(ctx, url);
        if (!cap) { out.push({ token: o.token, url, outcome: "unfetchable" }); continue; }
        const direct = await groundOn(ctx, o, url, cap);
        done = settle(direct);
        for (const hop of done ? [] : hopLinks(cap.html, url)) {
          if (attempts >= MAX_ATTEMPTS_PER_ITEM) break;
          attempts += 1;
          const hopCap = await capturePage(ctx, hop);
          done = hopCap ? settle(await groundOn(ctx, o, hop, hopCap, url)) : null;
          if (done) break;
        }
        if (done) break;
        if (!direct) out.push({ token: o.token, url, outcome: "token_not_in_page" });
      }
    } catch (e) {
      if (!(e instanceof FetchHoldError)) throw e;
      out.push({ token: o.token, outcome: "fetch_held" });
      return out;
    }
    out.push(done ?? { token: o.token, outcome: "unresolved" });
  }
  return out;
}
