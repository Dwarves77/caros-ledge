// Ported from old_repo/src/lib/entities/corridor-scope.ts (lines 1-146)
// Ported from old_repo/src/lib/entities/corridor-scope-cache.ts (lines 1-45)

import type { Db } from "@/core/db";
import { fetchAllByIdChunks, fetchAllRows } from "@/core/db";

import { parseCorridorName, type CorridorName } from "./kinds";
import { formatCorridorLabel, nameForJurisdiction } from "./unlocode-names";

const RELATION_TOUCHES_JURISDICTION = "touches_jurisdiction";

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

