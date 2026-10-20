// Ported from old_repo/src/app/api/ask/route.ts (lines 153-184, 260-317, 346-432, 591-626)
import { z } from "zod";

import { LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";
import { detailHref, jurisdictionCode, metaLine } from "@/core/lists";
import { readOperationsAskLines } from "@/features/operations/read/operations-reads";
import { loadSuppressedClaims, redactDeep, redactSuppressedClaims } from "@/features/corrections";
import { embeddedTier, runSearch } from "@/features/search/run-search";

import { matchPassages } from "../passages";
import { readAnswers } from "../read/answers";
import { ASK_DISCLAIMER, type AskHit, type AskResponse } from "../types";

// POST /api/ask { question }: the Intelligence Assistant, a research helper that is FREE by construction. It retrieves with Standard Search on the caller's own client (the same hit set the command bar
// shows), reads the answers a session wrote to the hit items' standard questions (an inference, labelled), quotes the platform guide where the question names its vocabulary, and adds the Operations
// facts the hits name. No model is called and no model id exists here; the citations ARE the hit set, so nothing generated needs validating. Everything is read on the caller's own client under RLS (the inference records and the fact_suppressions view are member-readable, migration 0031): no service key is needed. A suppressed claim is removed from every excerpt and withholds any
// answer that quotes it; if the corrections cannot be read the route says so (503) rather than answer unredacted.
const NAME = "/api/ask";
const HIT_LIMIT = 8;
const EXCERPT_CHARS = 800;
const INTERSECTION_CHARS = 600;
const SELECT =
  "id, title, summary, priority, severity, item_type, domain, category, jurisdictions, transport_modes, source_id, source_url, intersection_summary, related_items, full_brief, source:sources!source_id(id, name, url, base_tier, effective_tier, tier_override)";
const body = z.object({ question: z.string().trim().min(2).max(500) });

interface Source {
  id: string;
  name: string | null;
  url: string | null;
  base_tier: number | null;
  effective_tier: number | null;
  tier_override: number | null;
}
interface Raw {
  id: string;
  title: string;
  summary: string | null;
  priority: string | null;
  item_type: string | null;
  domain: number | null;
  category: string | null;
  jurisdictions: string[] | null;
  transport_modes: string[] | null;
  source_id: string | null;
  source_url: string | null;
  intersection_summary: string | null;
  related_items: string[] | null;
  full_brief: string | null;
  source: Source | Source[] | null;
}
const clip = (text: string | null, max: number): string | null => {
  const t = (text ?? "").replace(/^#+\s*/gm, "").replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();
  return t ? (t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, "")}...` : t) : null;
};
export const POST = route(NAME, async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const { question } = await parseJson(request, body);
  const found = await runSearch<Raw>(auth.client, question, { maxRows: HIT_LIMIT, select: SELECT, shape: (r) => r as unknown as Raw });
  if (!found.ok) throw new LookupError("search", { message: found.reason });
  const rows = found.rows;
  const passages = matchPassages(question).map(({ id, heading, text }) => ({ id, heading, text }));
  const reply = (r: Partial<AskResponse>) => ok(auth.headers, { question, hits: [], answers: [], passages, operations: [], disclaimer: ASK_DISCLAIMER, empty: rows.length === 0, ...r });
  if (rows.length === 0) return reply({});

  const suppressed = await loadSuppressedClaims(auth.client, rows.map((r) => r.id)).catch((e: unknown) => {
    throw new LookupError("corrections", e);
  });
  const sourceIds = [...new Set(rows.map((r) => r.source_id).filter((id): id is string => !!id))];
  const stats = sourceIds.length ? await auth.client.rpc("get_source_citation_stats", { source_ids: sourceIds }) : { data: [], error: null };
  if (stats.error) throw new LookupError("citation stats", stats.error);
  const statOf = new Map((stats.data as { source_id: string; citation_count: number | null; recency: string | null }[]).map((s) => [s.source_id, s]));
  const hits = rows.map((r): AskHit => {
    const src = Array.isArray(r.source) ? (r.source[0] ?? null) : r.source;
    const mine = suppressed.filter((c) => c.item_id === r.id);
    const brief = mine.length && r.full_brief ? (redactSuppressedClaims({ fullBrief: r.full_brief, claims: mine }).fullBrief ?? r.full_brief) : r.full_brief;
    const stat = r.source_id ? statOf.get(r.source_id) : undefined;
    return {
      id: r.id,
      title: r.title,
      href: detailHref({ id: r.id, type: r.item_type, domain: r.domain }),
      priority: r.priority,
      jurisdiction: jurisdictionCode({ jurisdiction: r.jurisdictions?.[0] ?? undefined }),
      meta: metaLine({ type: r.item_type, modes: r.transport_modes ?? undefined, topic: r.category ?? undefined }),
      tier: embeddedTier(src),
      summary: clip(redactDeep(r.summary, mine), INTERSECTION_CHARS),
      excerpt: clip(brief, EXCERPT_CHARS),
      intersection: clip(redactDeep(r.intersection_summary, mine), INTERSECTION_CHARS),
      relatedCount: r.related_items?.length ?? 0,
      source: src || r.source_url ? { name: src?.name ?? null, url: r.source_url ?? src?.url ?? null, citationCount: stat?.citation_count ?? null, recency: stat?.recency ?? null } : null,
    };
  });
  const answers = await readAnswers(auth.client, rows, suppressed).catch((e: unknown) => {
    throw new LookupError("answers", e);
  });
  const operations = await readOperationsAskLines(auth.client, { jurisdictions: [...new Set(rows.flatMap((r) => r.jurisdictions ?? []))] }).catch((e: unknown) => {
    throw new LookupError("operations facts", e);
  });
  return reply({ hits, answers, operations });
});
