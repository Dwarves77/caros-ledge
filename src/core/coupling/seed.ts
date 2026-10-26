// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the seeds pass (C1). Writes every coupling of couplings.json as an entity (kind per class) and the relations among them as entity_relations, each carrying the page it is
// taken from: the quote must stand verbatim on a stored capture of the cited page (registerCitedSource: acceptStoredQuote, then the page is registered and rated through the class table), and the row records that source_id and the quote. A coupling whose quote no
// capture holds is refused and counted, never written ungrounded; the propagate stage captures the cited pages first (captureCited). Idempotent: a second run writes nothing. Dry mode plans the same counts and writes nothing.
import type { Db } from "@/core/db";
import { planInstrument } from "@/core/entities/plan";
import { registerCitedSource } from "@/core/producers";
import type { RunResult } from "@/core/types/run-result";

import { readAll, type Row } from "./read";
import { COUPLING_RELATIONS, COUPLING_VERSION, COUPLINGS, type Coupling } from "./coupling";

const SEED_ASSERTED_BY = "coupling/seed";
type Cite = NonNullable<Coupling["citation"]>;
const pageKey = (c: Cite): string => `${c.url}\n${c.quote}`;

/** The pages the vocabulary is taken from: what the propagate stage captures before the seeds pass. */
export const seedPages = (): { url: string; title: string }[] => [...new Map([...COUPLINGS.flatMap((c) => [c.citation, c.modesCitation]), ...COUPLING_RELATIONS.flatMap((r) => r.citations)].filter((c): c is Cite => !!c).map((c) => [c.url, { url: c.url, title: c.title }])).values()];

/** Write the rows the table does not hold yet (by key), in chunks; the count is rows added, so a second run counts none. */
async function addNew(sb: Db, table: string, rows: Row[], order: readonly string[], key: (r: Row) => string, notes: string[]): Promise<number> {
  const held = new Set((await readAll(sb, table, order.join(","), order)).map(key));
  const seen = new Set<string>();
  const fresh = rows.filter((r) => !held.has(key(r)) && !seen.has(key(r)) && seen.add(key(r)));
  let written = 0;
  for (let i = 0; i < fresh.length; i += 200) {
    const { error } = await sb.from(table).insert(fresh.slice(i, i + 200));
    if (error) notes.push(`${table} write failed: ${error.message}`);
    else written += Math.min(200, fresh.length - i);
  }
  return written;
}

export async function seedCouplings(deps: { sb: Db; now: () => Date }, input: { dry: boolean }): Promise<RunResult> {
  const { sb } = deps;
  const notes: string[] = [];
  const counts: Record<string, number> = { seed_couplings: COUPLINGS.length, seed_relations: COUPLING_RELATIONS.length, seed_refused: 0, seed_entities_written: 0, seed_relations_written: 0 };
  const verdict = new Map<string, { source_id: string } | { reason: string }>();
  for (const c of [...COUPLINGS.flatMap((x) => [x.citation, x.modesCitation]), ...COUPLING_RELATIONS.flatMap((r) => r.citations)]) {
    if (!c || verdict.has(pageKey(c)) || input.dry) continue;
    const got = await registerCitedSource(c, { sb });
    verdict.set(pageKey(c), got.refused ? { reason: `${c.url}: ${got.reason}` } : { source_id: got.source_id });
  }
  const accepted = (c: Cite | undefined) => (c ? verdict.get(pageKey(c)) : undefined);
  const live = COUPLINGS.filter((c) => c.class === "window" || input.dry || ([c.citation, c.modesCitation].every((q) => !q || (accepted(q) && "source_id" in (accepted(q) as object)))));
  const have = new Set(live.map((c) => c.key));
  for (const v of verdict.values()) if ("reason" in v) notes.push(`refused: ${v.reason}`);
  counts.seed_refused = COUPLINGS.length - live.length;

  const entities: object[] = [];
  const identifiers: object[] = [];
  for (const c of live) {
    if (c.kind === "instrument") {
      const p = planInstrument([c.name], { assertedBy: SEED_ASSERTED_BY, now: deps.now() });
      entities.push(...p.entities);
      identifiers.push(...p.identifiers);
    } else entities.push({ entity_id: c.entityId, kind: c.kind, canonical_name: c.name, display_name: c.name, status: "active" });
  }
  const keyId = (k: string) => COUPLINGS.find((c) => c.key === k)?.entityId as string;
  const relations = COUPLING_RELATIONS.filter((r) => have.has(r.parent) && have.has(r.child)).flatMap((r) => {
    const ok = input.dry ? r.citations : r.citations.filter((c) => "source_id" in (accepted(c) ?? {}));
    return ok.length ? [{ parent_entity_id: keyId(r.parent), child_entity_id: keyId(r.child), relation: r.relation, asserted_by: SEED_ASSERTED_BY, source_id: input.dry ? null : (accepted(ok[0]) as { source_id: string }).source_id, provenance: { coupling_version: COUPLING_VERSION, citations: ok } }] : [];
  });
  Object.assign(counts, { seed_entities_planned: new Set(entities.map((e) => (e as { entity_id: string }).entity_id)).size, seed_relations_planned: relations.length });
  if (input.dry) return { counts, outcome: "ok", notes: [...notes, "dry: nothing written, no page checked"] };

  const k = (...cols: string[]) => (r: Row) => cols.map((c) => String(r[c])).join("|");
  counts.seed_entities_written = await addNew(sb, "entities", entities as Row[], ["entity_id"], k("entity_id"), notes);
  await addNew(sb, "entity_identifiers", identifiers as Row[], ["entity_id", "scheme", "value"], k("entity_id", "scheme", "value"), notes);
  counts.seed_relations_written = await addNew(sb, "entity_relations", relations as Row[], ["parent_entity_id", "child_entity_id", "relation"], k("parent_entity_id", "child_entity_id", "relation"), notes);
  // a coupling no capture holds is a gap in the vocabulary: the run is partial and says how it closes
  if (counts.seed_refused) notes.push(`${counts.seed_refused} coupling(s) refused: no stored capture of their page holds the quote; a run that captures the cited pages (the fetch gate open, or a ruled run) closes it`);
  return { counts, outcome: counts.seed_refused || notes.some((n) => n.includes("write failed")) ? "partial" : "ok", notes };
}
