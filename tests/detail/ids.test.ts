// INV-269: every uuid URL lands on a page that renders that item, or on not-found when no surface admits it. The property runs over a fixture corpus on every surface; a deliberately broken decision
// (redirects to the wrong surface, renders a market item on /regulations, calls an unverified item admissible) is shown to violate it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isAdmissibleItem } from "@/core/derived/admissible";
import { itemIdColumn, resolveIdRedirect, type IdRedirectDecision, type IdRedirectRow } from "@/core/detail/id-redirect";
import { isUuid } from "@/core/http/parse";
import { canonicalSurface, type DetailSurface } from "@/core/lists";

import { memoryDb, type Row } from "../_support/memory-db.ts";

const U = (n: number) => `aaaaaaaa-2000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n: number, over: Partial<IdRedirectRow>): IdRedirectRow => ({ id: U(n), legacy_id: null, item_type: "regulation", domain: 1, provenance_status: "verified", is_archived: false, replaced_by: null, ...over });
const CORPUS: IdRedirectRow[] = [
  row(1, { legacy_id: "g14" }),
  row(2, {}),
  row(3, { item_type: "market_signal", domain: 4, legacy_id: "m1" }),
  row(4, { item_type: "market_signal", domain: 4 }),
  row(5, { item_type: "research_finding", domain: 3 }),
  row(6, { item_type: null, domain: 6 }),
  row(7, { provenance_status: "unverified" }),
  row(8, { provenance_status: "quarantined", legacy_id: "q1", item_type: "market_signal", domain: 4 }),
  row(9, { item_type: null, domain: null }),
  row(10, { is_archived: true, legacy_id: "a1" }),
  row(11, { replaced_by: U(1), legacy_id: "r1" }),
];
const SURFACES: DetailSurface[] = ["regulations", "market", "operations", "research"];
const db = memoryDb({ intelligence_items: CORPUS as unknown as Row[] }).db;
/** The surface that admits a row: only an admissible row (verified, not archived, not replaced) is admitted, on the surface its raw item_type and domain map to. */
const admittedSurfaceFor = (r: IdRedirectRow): DetailSurface | null => (isAdmissibleItem(r) ? canonicalSurface({ type: r.item_type, domain: r.domain }) : null);
/** The decision the route reaches for a row: the resolver over the corpus database. */
const resolved = (surface: DetailSurface, r: IdRedirectRow): Promise<IdRedirectDecision> => resolveIdRedirect(db, surface, r.id);

/** The page at /<surface>/<urlId>: the verified row it renders, or none (the route would answer not-found). */
function pageAt(rows: readonly IdRedirectRow[], surface: string, urlId: string): IdRedirectRow | null {
  const hits = rows.filter((r) => isAdmissibleItem(r) && (r.legacy_id === urlId || (isUuid(urlId) && r.id === urlId)) && admittedSurfaceFor(r) === surface);
  return hits.length === 1 ? (hits[0] as IdRedirectRow) : null;
}
/** Every violation of the property over the corpus for a decision function. */
async function violations(rows: readonly IdRedirectRow[], decide: (s: DetailSurface, r: IdRedirectRow) => Promise<IdRedirectDecision>): Promise<string[]> {
  const out: string[] = [];
  for (const r of rows)
    for (const surface of SURFACES) {
      const d = await decide(surface, r);
      const at = `/${surface}/${r.id}`;
      if (d.kind === "render") {
        if (pageAt(rows, surface, r.id)?.id !== r.id) out.push(`${at}: renders nothing`);
      } else if (d.kind === "redirect") {
        const m = /^\/([a-z]+)\/([^/?#]+)$/.exec(d.to);
        if (!m || pageAt(rows, m[1] as string, decodeURIComponent(m[2] as string))?.id !== r.id) out.push(`${at}: redirects to ${d.to}, which does not render the item`);
      } else if (admittedSurfaceFor(r) !== null) out.push(`${at}: not-found for an admitted item`);
    }
  return out;
}

test("the id-redirect property holds over every item on every surface", async () => {
  assert.deepEqual(await violations(CORPUS, resolved), []);
});

test("the property catches a broken decision (red first): wrong surface, an unverified item admitted, a market item rendered on /regulations", async () => {
  const wrongSurface = async (s: DetailSurface, r: IdRedirectRow): Promise<IdRedirectDecision> => {
    const d = await resolved(s, r);
    return d.kind === "redirect" ? { kind: "redirect", to: `/regulations/${r.legacy_id || r.id}` } : d;
  };
  assert.ok((await violations(CORPUS, wrongSurface)).some((v) => /redirects to/.test(v)), "a redirect that always lands on /regulations is caught");
  const admitAll = async (s: DetailSurface, r: IdRedirectRow): Promise<IdRedirectDecision> => (!isAdmissibleItem(r) ? { kind: "render" } : resolved(s, r));
  assert.ok((await violations(CORPUS, admitAll)).some((v) => /renders nothing/.test(v)), "an unverified item that renders is caught");
  const renderHere = async (): Promise<IdRedirectDecision> => ({ kind: "render" });
  assert.ok((await violations(CORPUS, renderHere)).length > 0, "rendering every item on every surface is caught");
});

test("a uuid URL for an item with a legacy slug redirects to the slug; an item with none renders at its uuid; an unverified item is not found", async () => {
  assert.deepEqual(await resolved("regulations", CORPUS[0] as IdRedirectRow), { kind: "redirect", to: "/regulations/g14" });
  assert.deepEqual(await resolved("regulations", CORPUS[1] as IdRedirectRow), { kind: "render" });
  assert.deepEqual(await resolved("regulations", CORPUS[2 + 4] as IdRedirectRow), { kind: "not-found" });
  assert.deepEqual(await resolveIdRedirect(db, "regulations", "g14"), { kind: "render" }, "a legacy slug renders as it is");
  assert.equal(itemIdColumn(U(1)), "id");
  assert.equal(itemIdColumn("g14"), "legacy_id");
});
