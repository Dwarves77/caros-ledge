// Ported from old_repo/src/lib/entities/corridor-scope.ts (lines 1-146)
// Ported from old_repo/src/lib/entities/corridor-scope-cache.ts (lines 1-45)
// Corridors and the jurisdictions they touch, for the Market overlay selector and the Regulations "corridors this applies on" strip. Every read
// error is surfaced (B-0056/1560: a corridor must never render with no jurisdictions because a read failed), the cached readers throw rather than
// return an empty list (B-2157), and the cache tag is exported so the corridor seed can invalidate it (B-1559).
import { unstable_cache } from "next/cache";

import type { Db } from "@/core/db";
import { fetchAllByIdChunks, fetchAllRows, serviceClient } from "@/core/db";

import { parseCorridorName, type CorridorName } from "./kinds";
import { formatCorridorLabel, nameForJurisdiction } from "./unlocode-names";

export const RELATION_TOUCHES_JURISDICTION = "touches_jurisdiction";
export const CORRIDOR_SCOPE_TAG = "corridor-scope";
export const CORRIDOR_SCOPE_REVALIDATE_SECONDS = 60 * 60;

export interface CorridorJurisdiction {
  entityId: string;
  code: string;
  name: string | null;
}
export interface CorridorScope {
  entityId: string;
  canonicalName: string;
  displayName: string | null;
  label: string;
  parsed: CorridorName | null;
  jurisdictions: CorridorJurisdiction[];
}
interface EntityRow {
  entity_id: string;
  canonical_name: string;
  display_name?: string | null;
}
interface ScopeRow {
  subject_id: string;
  scope_id: string;
  relation: string;
}

/** Every active corridor with its jurisdictions. Any failed read throws. */
export async function corridorScopes(client: Db): Promise<CorridorScope[]> {
  const corridors = await fetchAllRows<EntityRow>((from, to) => client.from("entities").select("entity_id,canonical_name,display_name").eq("kind", "corridor").eq("status", "active").order("entity_id", { ascending: true }).range(from, to), { cap: 50_000 });
  if (!corridors.length) return [];
  const ids = corridors.map((r) => r.entity_id);
  const scopes = await fetchAllByIdChunks<ScopeRow>(ids, async (slice) => {
    const { data, error } = await client.from("entity_scope").select("subject_id,scope_id,relation").eq("relation", RELATION_TOUCHES_JURISDICTION).in("subject_id", slice);
    if (error) throw new Error(`corridor scope read failed: ${error.message}`);
    return data ?? [];
  }, { manyPerId: true });
  const jurIds = [...new Set(scopes.map((r) => r.scope_id))];
  const jurisdictions = jurIds.length
    ? await fetchAllByIdChunks<EntityRow>(jurIds, async (slice) => {
        const { data, error } = await client.from("entities").select("entity_id,canonical_name,display_name").in("entity_id", slice);
        if (error) throw new Error(`corridor jurisdiction read failed: ${error.message}`);
        return data ?? [];
      })
    : [];
  const byId = new Map(jurisdictions.map((r) => [r.entity_id, r]));
  const bySubject = new Map<string, ScopeRow[]>();
  for (const s of scopes) bySubject.set(s.subject_id, [...(bySubject.get(s.subject_id) ?? []), s]);
  return corridors.map((entity) => {
    const parsed = parseCorridorName(entity.canonical_name);
    return {
      entityId: entity.entity_id,
      canonicalName: entity.canonical_name,
      displayName: entity.display_name ?? null,
      label: entity.display_name || (parsed ? formatCorridorLabel(parsed) : entity.canonical_name),
      parsed,
      jurisdictions: (bySubject.get(entity.entity_id) ?? []).map((scope) => {
        const j = byId.get(scope.scope_id);
        const code = j?.canonical_name ?? "";
        return { entityId: scope.scope_id, code, name: j?.display_name ?? nameForJurisdiction(code) };
      }),
    };
  });
}

/** Corridors that touch any of the given ISO codes. */
export async function corridorsTouching(client: Db, isoCodes: readonly string[]): Promise<CorridorScope[]> {
  const wanted = new Set((isoCodes ?? []).map((c) => String(c).trim().toUpperCase()).filter(Boolean));
  if (!wanted.size) return [];
  return (await corridorScopes(client)).filter((c) => c.jurisdictions.some((j) => wanted.has(j.code.toUpperCase())));
}

/** The cached list (one hour, tagged). A failure rejects, and a rejected cache function stores nothing: an outage is never "no corridors". */
export async function getCachedCorridorScopes(): Promise<CorridorScope[]> {
  const client = serviceClient();
  return unstable_cache(async () => corridorScopes(client), ["corridor-scope:list"], { tags: [CORRIDOR_SCOPE_TAG], revalidate: CORRIDOR_SCOPE_REVALIDATE_SECONDS })();
}

export async function getCachedCorridorsTouchingJurisdictions(isoCodes: readonly string[]): Promise<CorridorScope[]> {
  const codes = [...new Set((isoCodes ?? []).map((c) => String(c).trim().toUpperCase()).filter(Boolean))].sort();
  if (!codes.length) return [];
  const client = serviceClient();
  return unstable_cache(async () => corridorsTouching(client, codes), ["corridor-scope:by-jurisdiction", codes.join(",")], { tags: [CORRIDOR_SCOPE_TAG], revalidate: CORRIDOR_SCOPE_REVALIDATE_SECONDS })();
}
