// Ported from old_repo/src/lib/supabase-server.ts (lines 2074-2175)
// The source rating on a list row (INV-213): the tier is customerTierOf the source row (override, then effective, then base), never a tier derived from brief
// text; the bias tags are the source's own (INV-214). A failed source read leaves those fields UNSET and says so; it never invents a rating.
import type { Db } from "@/core/db";
import type { BiasTag, Resource } from "@/core/types";
import { customerTierOf } from "@/core/sources";

const CHUNK = 150;

interface SourceRow {
  id: string;
  name: string | null;
  base_tier: number | null;
  effective_tier: number | null;
  tier_override: number | null;
}
interface BiasRow {
  source_id: string;
  dimension: BiasTag["dimension"];
  tag: string;
  confidence: number | null;
}

async function inChunks<T>(ids: string[], read: (slice: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await read(ids.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
  }
  return out;
}

/** Attach each row's source name and customer tier (and, when asked, the source's bias tags). Returns false when a read failed; rows are then left as they were. */
export async function enrichSources(db: Db, resources: Resource[], opts: { biasTags?: boolean } = {}): Promise<boolean> {
  const ids = [...new Set(resources.map((r) => r.sourceId).filter((id): id is string => !!id))];
  if (ids.length === 0) return true;
  try {
    const sources = await inChunks<SourceRow>(ids, (slice) => db.from("sources").select("id, name, base_tier, effective_tier, tier_override").in("id", slice));
    const byId = new Map(sources.map((s) => [s.id, s]));
    const bias = opts.biasTags ? await inChunks<BiasRow>(ids, (slice) => db.from("source_bias_tags").select("source_id, dimension, tag, confidence").in("source_id", slice)) : null;
    const tagsBySource = new Map<string, BiasTag[]>();
    for (const b of bias ?? []) tagsBySource.set(b.source_id, [...(tagsBySource.get(b.source_id) ?? []), { dimension: b.dimension, tag: b.tag, confidence: b.confidence }]);
    for (const r of resources) {
      const s = r.sourceId ? byId.get(r.sourceId) : undefined;
      if (s) {
        if (s.name) r.sourceName = s.name;
        const tier = customerTierOf(s);
        if (tier !== null) r.sourceTier = tier;
      }
      if (bias) r.biasTags = r.sourceId ? (tagsBySource.get(r.sourceId) ?? []) : [];
    }
    return true;
  } catch {
    return false;
  }
}
