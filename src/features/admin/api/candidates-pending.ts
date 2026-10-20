// Ported from old_repo/src/app/api/admin/canonical-sources/pending/route.ts (lines 63-176)
import { allRows, rowsByIds } from "@/core/db";
import { LookupError } from "@/core/http/errors";
import { canonicalUrl, hostOf } from "@/core/shared";
import { classifySourceRole, classTierForHost } from "@/core/sources";

import { adminRoute, boundedInt, reply } from "./shared";

const ISSUE_RANK: Record<string, number> = { stale_url: 0, missing_link: 1, missing_source: 2, thin_match: 3 };
const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const CANDIDATE_PAGE = 100;

interface Candidate {
  id: string;
  intelligence_item_id: string;
  issue_classification: string;
  candidate_url: string;
  candidate_title: string | null;
  candidate_publisher: string | null;
  confidence: string;
  verified: boolean;
  created_at: string;
  [k: string]: unknown;
}
interface ParentItem {
  id: string;
  legacy_id: string | null;
  title: string | null;
  item_type: string | null;
  domain: number | null;
  jurisdictions: string[] | null;
  topic_tags: string[] | null;
  source_id: string | null;
  source_url: string | null;
}

/** The classification the editor starts from, with no model: the class table's tier for the host and name, the source role, and the parent item's own domain, jurisdictions and topics (the grounding the candidate was found for). */
function classifyCandidate(c: Pick<Candidate, "candidate_url" | "candidate_title" | "candidate_publisher">, item: ParentItem | undefined) {
  const name = c.candidate_publisher || c.candidate_title;
  return { tier: classTierForHost(hostOf(c.candidate_url), name), source_role: classifySourceRole(name, c.candidate_url), domains: item?.domain ? [item.domain] : [], jurisdictions: item?.jurisdictions ?? [], transport_modes: [] as string[], topic_tags: item?.topic_tags ?? [] };
}

/** Group a page of candidates by parent item: candidates by confidence then verified, groups by issue severity then item title. Pure. */
function groupCandidates(rows: readonly Candidate[], items: ReadonlyMap<string, ParentItem>, existing: ReadonlyMap<string, string>) {
  const groups = new Map<string, { item_id: string; item: ParentItem | null; issue_classification: string; candidates: (Candidate & { existing_source_id: string | null; classification: ReturnType<typeof classifyCandidate> })[] }>();
  for (const c of rows) {
    const g = groups.get(c.intelligence_item_id) ?? { item_id: c.intelligence_item_id, item: items.get(c.intelligence_item_id) ?? null, issue_classification: c.issue_classification, candidates: [] };
    g.candidates.push({ ...c, existing_source_id: existing.get(canonicalUrl(c.candidate_url) ?? "") ?? null, classification: classifyCandidate(c, items.get(c.intelligence_item_id)) });
    groups.set(c.intelligence_item_id, g);
  }
  for (const g of groups.values()) g.candidates.sort((a, b) => (CONFIDENCE_RANK[a.confidence] ?? 9) - (CONFIDENCE_RANK[b.confidence] ?? 9) || Number(b.verified) - Number(a.verified));
  return [...groups.values()].sort((a, b) => (ISSUE_RANK[a.issue_classification] ?? 9) - (ISSUE_RANK[b.issue_classification] ?? 9) || (a.item?.title ?? "").localeCompare(b.item?.title ?? ""));
}

/** Pending canonical candidates, a page at a time (oldest first, a total order), with the whole queue's counts so the badge equals the list (INV-281). */
export const GET = adminRoute("/api/admin/canonical-sources/pending", async (admin, request) => {
  const q = new URL(request.url).searchParams;
  const limit = boundedInt(q.get("limit"), CANDIDATE_PAGE, 200);
  const offset = Math.max(0, Number.parseInt(q.get("offset") ?? "0", 10) || 0);
  const db = admin.service();
  const page = await db.from("canonical_source_candidates").select("*").eq("decision", "pending").order("created_at", { ascending: true }).order("id", { ascending: true }).range(offset, offset + limit - 1);
  if (page.error) throw new LookupError("canonical_source_candidates", page.error);
  const rows = (page.data ?? []) as Candidate[];
  const counted = await allRows<Pick<Candidate, "id" | "confidence" | "issue_classification" | "verified">>(db, "canonical_source_candidates", "id, confidence, issue_classification, verified", { where: (b) => b.eq("decision", "pending") });
  const items = await rowsByIds<ParentItem>(db, "intelligence_items", "id, legacy_id, title, item_type, domain, jurisdictions, topic_tags, source_id, source_url", rows.map((r) => r.intelligence_item_id));
  const known = await rowsByIds<{ id: string; url: string }>(db, "sources", "id, url", rows.map((r) => canonicalUrl(r.candidate_url) ?? "").filter(Boolean), "url", "id");
  const existing = new Map(known.map((s) => [canonicalUrl(s.url) ?? "", s.id]));
  const groups = groupCandidates(rows, new Map(items.map((i) => [i.id, i])), existing);
  const count = (f: (c: (typeof counted)[number]) => boolean) => counted.filter(f).length;
  const stats = {
    total: counted.length,
    items: groups.length,
    by_confidence: { high: count((c) => c.confidence === "high"), medium: count((c) => c.confidence === "medium"), low: count((c) => c.confidence === "low") },
    by_issue: Object.fromEntries(Object.keys(ISSUE_RANK).map((k) => [k, count((c) => c.issue_classification === k)])),
    high_conf_verified: count((c) => c.confidence === "high" && c.verified),
    high_conf_unverified: count((c) => c.confidence === "high" && !c.verified),
  };
  return reply(admin, { groups, stats, page: { offset, limit, hasMore: offset + rows.length < counted.length } });
});
