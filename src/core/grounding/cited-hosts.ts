// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 1684-1758)
// Ported from old_repo/src/lib/sources/cited-host-gate.mjs (lines 1-19)
// The cited-host gate (S1-07). A cited URL becomes a pool stub (which criterion 2 accepts by exact URL) ONLY when the system already
// KNOWS its host: the item's real fetched pool, the source registry or the item's own source_url, matched by host or by institution.
// Unconditional stubbing made criterion 2 circular (the author's citations licensed themselves). A novel-host citation is flagged,
// never stubbed, and criterion 2 then fails it honestly.
import { parseNewSources } from "@/core/brief/sections";
import { fetchAllRows, type Db } from "@/core/db";
import { hostOf } from "@/core/shared/url";

import { openFlagOnce } from "./flags";
import type { PoolRow } from "./pool";
import type { ResolveSource } from "./audit-gate";

const CITED_URL = /https?:\/\/[^\s)\]}"'<>]+/g;

export interface CitedGateResult { stubbed: number; novel: Map<string, string>; notes: string[] }

/** Partition cited URLs by whether their host (or institution) is known. */
export function partitionCitedByHost<T extends { host: string; institution: string | null }>(cited: T[], knownHosts: Set<string>, knownInstitutions: Set<string>): { allowed: T[]; novel: T[] } {
  const allowed: T[] = [];
  const novel: T[] = [];
  for (const c of cited) {
    if ((!!c.host && knownHosts.has(c.host)) || (!!c.institution && knownInstitutions.has(c.institution))) allowed.push(c);
    else novel.push(c);
  }
  return { allowed, novel };
}

/**
 * Stub the cited URLs on known hosts and flag the novel ones. A pool read or registry read that fails throws (the gate fails closed:
 * grounding aborts rather than stubbing under a blind known-host set). `dry` computes the partition and writes nothing.
 */
export async function citedHostGate(
  sb: Db,
  resolve: ResolveSource,
  a: { itemId: string; sourceUrl: string | null; fullBrief: string | null; sections: { content_md: string | null }[]; usablePool: PoolRow[]; allPoolUrls: Set<string>; nowIso: string; dry: boolean },
): Promise<CitedGateResult> {
  const knownHosts = new Set<string>();
  const knownInstitutions = new Set<string>();
  const instOf = async (host: string) => (host ? ((await resolve(`https://${host}`))?.institution ?? null) : null);
  const addKnown = async (u: string | null | undefined) => {
    const h = hostOf(u ?? "");
    if (!h) return;
    knownHosts.add(h);
    const inst = await instOf(h);
    if (inst) knownInstitutions.add(inst);
  };
  await addKnown(a.sourceUrl);
  for (const p of a.usablePool) await addKnown(p.url);
  const registry = await fetchAllRows<{ url: string }>((from, to) => sb.from("sources").select("url").order("id", { ascending: true }).range(from, to), { cap: 200_000 });
  for (const s of registry) await addKnown(s.url);

  const asCited = async (url: string) => {
    const host = hostOf(url);
    return { url, host, institution: await instOf(host) };
  };
  const novel = new Map<string, string>();
  const notes: string[] = [];
  let stubbed = 0;
  const stub = async (c: { url: string }, query: string, title: string, index: number, content: string) => {
    if (a.allPoolUrls.has(c.url)) return;
    a.allPoolUrls.add(c.url);
    if (a.dry) return void (stubbed += 1);
    const { error } = await sb.from("agent_run_searches").insert({ intelligence_item_id: a.itemId, search_query: query, result_url: c.url, result_title: title, result_index: index, result_content: content, searched_at: a.nowIso });
    if (error) notes.push(`cited-source stub not written (${c.url}): ${error.message}`);
    else stubbed += 1;
  };
  const table = await Promise.all(parseNewSources(a.fullBrief).map(async (cs) => ({ ...(await asCited(cs.url)), name: cs.name })));
  const t = partitionCitedByHost(table, knownHosts, knownInstitutions);
  for (const n of t.novel) if (!novel.has(n.url)) novel.set(n.url, "new-sources table");
  for (const c of t.allowed) await stub(c, "canonical:cited-source", c.name, 90, c.name.slice(0, 280));
  const prose = new Set<string>();
  for (const s of a.sections) for (const m of (s.content_md ?? "").matchAll(CITED_URL)) prose.add(m[0].replace(/[.,;:]+$/, ""));
  const p = partitionCitedByHost(await Promise.all([...prose].map(asCited)), knownHosts, knownInstitutions);
  for (const n of p.novel) if (!novel.has(n.url)) novel.set(n.url, "section prose");
  for (const c of p.allowed) await stub(c, "canonical:cited-url", "cited in brief", 91, "");
  if (novel.size && !a.dry) {
    const list = [...novel.entries()];
    const note = await openFlagOnce(sb, {
      category: "source_issue", subject_type: "item", subject_ref: a.itemId, created_by: "cited-host-gate",
      description: `${novel.size} cited URL(s) on hosts unknown to the item's fetched pool and the source registry: NOT stubbed for criterion 2 (self-grounding gate): ${list.map(([u]) => u).slice(0, 6).join("; ")}`,
      recommended_actions: list.slice(0, 8).map(([u, ctx]) => ({ action: "register_and_rate_source", rationale: `${u} (cited in ${ctx}): register and rate the host (rule 18), capture it, then re-ground` })),
    });
    if (note) notes.push(note);
  }
  return { stubbed, novel, notes };
}
