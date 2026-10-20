// Ported from old_repo/src/app/community/[slug]/page.tsx (lines 143-154)
// Ported from old_repo/src/app/community/discover/page.tsx (lines 35-46)
// The spine entities a thread can be bound to, by name: the one read the group page, the discover page and the picker's search share (the two pages carried byte-equivalent copies that passed the typed text to ilike
// unescaped). A failed read throws, so a page says so with Retry instead of offering an empty picker.
import { LookupError } from "@/core/http/errors";
import type { Db } from "@/core/db/clients";


import type { EntityRef } from "./types";

const ENTITY_CANDIDATE_LIMIT = 60;
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export async function loadEntityCandidates(db: Db, query: string, limit = ENTITY_CANDIDATE_LIMIT): Promise<EntityRef[]> {
  let q = db.from("entities").select("entity_id, kind, canonical_name").eq("status", "active").order("canonical_name", { ascending: true }).order("entity_id", { ascending: true }).limit(limit);
  const text = query.trim();
  if (text) q = q.ilike("canonical_name", `%${escapeLike(text)}%`);
  const { data, error } = await q;
  if (error) throw new LookupError("entity candidates", error);
  return (data ?? []) as EntityRef[];
}
