// Ported from old_repo/src/lib/detail/load-detail.ts (lines 31-151)
// Ported from old_repo/src/lib/detail/load-detail-core.ts (lines 30-132, 227-332)
// The ONE loader every detail page calls: `loadDetail(surface, id, loadItemScoped)`. The item (one read, one uuid), the canonical-surface admission (an item renders only on the surface its raw
// item_type and domain route to), the claim ratings and the suppressed claims removed from the text (INV-270), the linked items, the cross-page analysis with the inferences read per request.
// It runs on the caller's own client: a member's page needs no service role (P2-02c), so nothing here is cached across users; the request's reads are bounded and run in parallel.
// There is no viewer branch and no injection seam: the per-viewer relevance is the /api/detail/relevance route, fetched once per item by the page (useItemRelevance).
import { notFound, redirect } from "next/navigation";

import { buildConnectionRows, buildResourceLookup, buildSupersessionRows, type ConnectionRow, type ResourceLookup } from "@/core/flywheel";
import { userClient, type Db } from "@/core/db";
import { attachImpact } from "@/core/impact/attach";
import type { DetailSurface } from "@/core/lists";
import type { ClaimTierMap } from "@/ui";
import type { ChangeLogEntry, Dispute, ItemConnection, Resource, Supersession } from "@/core/types";
import type { RelevanceInput } from "@/core/workspace";
import type { RecommendedAction } from "@/core/brief";
import { redactDeep, redactSuppressedClaims } from "@/features/corrections";

import { readClaims } from "./claim-tiers";
import { readCrossPage, type CrossPage } from "./cross-page-read";
import { resolveIdRedirect } from "./id-redirect";
import { readDetailItem, type SectionRow } from "./item-read";

export interface ItemScopedCtx {
  db: Db;
  uuid: string;
  resource: Resource;
  connections: ItemConnection[];
  supersessions: Supersession[];
}
export interface DetailBundle<ItemScoped> {
  notFound: false;
  uuid: string;
  resource: Resource;
  connections: ItemConnection[];
  supersessions: Supersession[];
  changelog: ChangeLogEntry[];
  dispute: Dispute | null;
  /** The stored sections with every suppressed claim removed. */
  sections: SectionRow[];
  claimTiers: ClaimTierMap;
  /** The claims or their suppressions could not be read (an object a migration adds is absent, or the read failed): the stored sections and the brief are withheld, never shown unredacted (INV-270), and the page says so with Retry. */
  claimsDegraded: boolean;
  resourceLookup: ResourceLookup;
  /** The masthead rows: supersessions first, then the connections (links on each item's own surface). */
  connectionRows: ConnectionRow[];
  crossPage: CrossPage;
  recommendedActions: RecommendedAction[];
  relevanceInput: RelevanceInput;
  itemScoped: ItemScoped;
}

/**
 * The detail of one item on one surface, or `{ notFound: true }` when no verified, non-archived item the reader can see has this id on THIS surface (a market item at /regulations is not found).
 * A failed read throws: the route's error boundary says so with Retry; it is never read as "not found" or as an empty block.
 * `asOfIso` (the page session's clock) is required: the theme view places a member in a horizon by its dated events against it, and there is no default date.
 */
export async function loadDetail<ItemScoped = undefined>(surface: DetailSurface, id: string, loadItemScoped: ((ctx: ItemScopedCtx) => Promise<ItemScoped>) | undefined, db: Db | undefined, orgId: string | null, asOfIso: string): Promise<DetailBundle<ItemScoped> | { notFound: true }> {
  const client = db ?? (await userClient());
  const item = await readDetailItem(client, id);
  if (!item || item.canonicalSurface !== surface) return { notFound: true };
  const { uuid, resource, connections, supersessions } = item;
  // The rail draws the stored impact scores with the reading workspace's client score, or the sentence of the input it waits for (the same function as every list row).

  const lookupPromise = buildResourceLookup(client, [...new Set([...connections.map((c) => c.id), ...supersessions.flatMap((s) => [s.old, s.new])])].filter(Boolean));

  const [, claimsRead, lookup, itemScoped, rawCrossPage] = await Promise.all([
    (async () => await attachImpact(client, [resource], new Map([[resource.id, uuid]]), orgId, undefined, new Map([[uuid, item.relevanceInput as unknown as Record<string, unknown>]])))(),
    readClaims(client, uuid).then((c) => ({ ok: true as const, ...c }), (e: unknown) => ({ ok: false as const, error: e })),
    lookupPromise,
    loadItemScoped ? loadItemScoped({ db: client, uuid, resource, connections, supersessions }) : Promise.resolve(undefined as ItemScoped),
    readCrossPage(client, uuid, surface, item.intersectionSummary, connections, lookupPromise, asOfIso),
  ]);
  // INV-270 fails closed: without the suppressions the text is withheld (a named degraded block), never rendered unredacted and never read as 'nothing suppressed'.
  const claims = claimsRead.ok ? claimsRead : { tiers: {} as ClaimTierMap, suppressed: [] };
  // Every text column of the page, not the sections and the brief alone: the claim was copied to the summary, the key data, the stated intersection summary and the theme brief (F:27).
  const crossPage = redactDeep(rawCrossPage, claims.suppressed);
  const redacted = claimsRead.ok ? redactSuppressedClaims({ sections: item.sections, fullBrief: resource.fullBrief ?? null, claims: claims.suppressed }) : { sections: [] as SectionRow[], fullBrief: "" };
  return {
    notFound: false,
    uuid,
    resource: redactDeep(redacted.fullBrief === (resource.fullBrief ?? null) ? resource : { ...resource, fullBrief: redacted.fullBrief ?? "" }, claims.suppressed),
    connections,
    supersessions,
    changelog: item.changelog,
    dispute: item.dispute,
    sections: redacted.sections,
    claimTiers: claims.tiers,
    claimsDegraded: !claimsRead.ok,
    resourceLookup: lookup,
    connectionRows: [...buildSupersessionRows(supersessions, resource.id, lookup), ...buildConnectionRows(connections, lookup)],
    crossPage,
    recommendedActions: item.recommendedActions,
    relevanceInput: item.relevanceInput,
    itemScoped,
  };
}

/** The route-level id decision: a uuid URL renders where it belongs, redirects to the owning page under its slug, or is not found (INV-269). Call it before loadDetail. */
export async function applyIdRedirect(surface: DetailSurface, id: string, db?: Db): Promise<void> {
  const decision = await resolveIdRedirect(db ?? (await userClient()), surface, id);
  if (decision.kind === "redirect") redirect(decision.to);
  if (decision.kind === "not-found") notFound();
}
