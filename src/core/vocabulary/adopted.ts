// Ported from old_repo/src/lib/vocabulary/adopted-terms.mjs (lines 1-102)
// Ported from old_repo/src/lib/vocabulary/adopted-entities.mjs (lines 1-60)
// The adopted vocabulary: terms the recurrence rule adopted (vocabulary_terms, status adopted), read once per pass and handed to the deriver, the
// mention detector and the entity link step; standards and materials also become entities. A failed read is reported to the caller (the code
// vocabularies then stand) and never widens what is accepted.
import type { Db } from "@/core/db";
import { fetchAllByIdChunks, fetchAllRows } from "@/core/db";
import { entityId } from "@/core/entities/id";

export const ADOPTED_KINDS = ["standard", "material", "theme", "scenario", "compliance_object", "term"] as const;
export type AdoptedKind = (typeof ADOPTED_KINDS)[number];
export interface AdoptedEntry {
  key: string;
  label: string;
}
export type AdoptedVocabulary = Record<AdoptedKind, AdoptedEntry[]>;

/** The one key normal form: NFKC, lower case, single spaces, edge punctuation trimmed. */
export function normaliseTermKey(text: unknown): string {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'`([{]+/, "")
    .replace(/[\s"'`)\]}.,;:]+$/, "");
}

export const emptyAdopted = (): AdoptedVocabulary => Object.fromEntries(ADOPTED_KINDS.map((k) => [k, []])) as unknown as AdoptedVocabulary;

export function groupAdoptedTerms(rows: readonly { kind?: string; term_key?: string; label?: string | null; status?: string }[] | null | undefined): AdoptedVocabulary {
  const out = emptyAdopted();
  const seen = new Set<string>();
  for (const r of rows ?? []) {
    if (!r || r.status !== "adopted" || !(ADOPTED_KINDS as readonly string[]).includes(String(r.kind))) continue;
    const key = normaliseTermKey(r.term_key);
    if (!key || seen.has(`${r.kind}|${key}`)) continue;
    seen.add(`${r.kind}|${key}`);
    out[r.kind as AdoptedKind].push({ key, label: typeof r.label === "string" && r.label.trim() ? r.label.trim() : key });
  }
  for (const k of ADOPTED_KINDS) out[k].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/** The adopted terms, or the failure typed: `ok: false` carries the empty vocabulary (the readers fall back to the code vocabularies) and the reason, which the caller must put in its notes. */
export type AdoptedRead = { ok: true; adopted: AdoptedVocabulary } | { ok: false; adopted: AdoptedVocabulary; reason: string };
export async function readAdoptedVocabulary(sb: Db): Promise<AdoptedRead> {
  try {
    const rows = await fetchAllRows<{ kind: string; term_key: string; label: string | null; status: string }>(
      (from, to) => sb.from("vocabulary_terms").select("kind, term_key, label, status").eq("status", "adopted").order("id", { ascending: true }).range(from, to),
      { cap: 100_000 },
    );
    return { ok: true, adopted: groupAdoptedTerms(rows) };
  } catch (e) {
    return { ok: false, adopted: emptyAdopted(), reason: `adopted terms unreadable (${e instanceof Error ? e.message : String(e)}); readers use the code vocabularies only` };
  }
}

export const adoptedKeys = (adopted: Partial<AdoptedVocabulary> | undefined, kind: AdoptedKind): string[] => (adopted?.[kind] ?? []).map((e) => e.key);
export const adoptedEntries = (adopted: Partial<AdoptedVocabulary> | undefined, kind: AdoptedKind): AdoptedEntry[] => adopted?.[kind] ?? [];

export const ADOPTED_ENTITY_KINDS = { standard: "instrument", material: "material" } as const;

/** Entities for adopted standards and materials not yet held. */
export function planAdoptedTermEntities(adopted: Partial<AdoptedVocabulary>, existingEntityIds: ReadonlySet<string> = new Set()): { entities: { entity_id: string; kind: string; canonical_name: string; status: "active" }[]; byTerm: Map<string, string> } {
  const entities: { entity_id: string; kind: string; canonical_name: string; status: "active" }[] = [];
  const byTerm = new Map<string, string>();
  for (const [termKind, entityKind] of Object.entries(ADOPTED_ENTITY_KINDS) as [AdoptedKind, "instrument" | "material"][]) {
    for (const e of adoptedEntries(adopted, termKind)) {
      const id = entityId(entityKind, e.key);
      byTerm.set(`${termKind}|${e.key}`, id);
      if (!existingEntityIds.has(id) && !entities.some((x) => x.entity_id === id)) entities.push({ entity_id: id, kind: entityKind, canonical_name: e.label || e.key, status: "active" });
    }
  }
  return { entities, byTerm };
}

/** Mint the entities of adopted terms (bounded id reads, one upsert). Errors are returned, not swallowed. */
export async function mintAdoptedTermEntities(sb: Db, adopted: Partial<AdoptedVocabulary>, opts: { dry?: boolean } = {}): Promise<{ planned: number; minted: number; error?: string }> {
  const all = [...planAdoptedTermEntities(adopted).byTerm.values()];
  if (!all.length) return { planned: 0, minted: 0 };
  let existing: Set<string>;
  try {
    const rows = await fetchAllByIdChunks<{ entity_id: string }>(all, async (chunk) => {
      const { data, error } = await sb.from("entities").select("entity_id").in("entity_id", chunk);
      if (error) throw new Error(error.message);
      return data ?? [];
    });
    existing = new Set(rows.map((r) => r.entity_id));
  } catch (e) {
    return { planned: 0, minted: 0, error: `entities read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const { entities } = planAdoptedTermEntities(adopted, existing);
  if (opts.dry || !entities.length) return { planned: entities.length, minted: 0 };
  const { error } = await sb.from("entities").upsert(entities, { onConflict: "entity_id", ignoreDuplicates: true });
  return error ? { planned: entities.length, minted: 0, error: `entities upsert failed: ${error.message}` } : { planned: entities.length, minted: entities.length };
}
