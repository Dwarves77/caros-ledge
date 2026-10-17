// Ported from old_repo/src/lib/detail/load-detail.ts (lines 31-151)
// Ported from old_repo/src/lib/detail/load-detail-core.ts (lines 30-132, 227-332)
// The ONE loader every detail page calls: `loadDetail(surface, id, loadItemScoped)`. The item (one read, one uuid), the canonical-surface admission (an item renders only on the surface its raw
// item_type and domain route to), the claim ratings and the suppressed claims removed from the text (INV-270), the linked items, the cross-page analysis with the inferences read per request.
// It runs on the caller's own client: a member's page needs no service role (P2-02c), so nothing here is cached across users; the request's reads are bounded and run in parallel.
// There is no viewer branch and no injection seam: the per-viewer relevance is the /api/detail/relevance route, fetched once per item by the page (useItemRelevance).
import { notFound, redirect } from "next/navigation";

import { buildConnectionRows, buildResourceLookup, buildSupersessionRows, type ConnectionRow, type ResourceLookup } from "@/core/flywheel";
import { userClient, type Db } from "@/core/db";
import type { DetailSurface } from "@/core/lists";
import type { ClaimTierMap } from "@/ui";
import type { ChangeLogEntry, Dispute, ItemConnection, Resource, Supersession } from "@/core/types";
import type { RelevanceInput } from "@/core/workspace";
import type { RecommendedAction } from "@/core/brief";
import { redactSuppressedClaims } from "@/features/corrections";

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
 */
export async function loadDetail<ItemScoped = undefined>(surface: DetailSurface, id: string, loadItemScoped?: (ctx: ItemScopedCtx) => Promise<ItemScoped>, db?: Db): Promise<DetailBundle<ItemScoped> | { notFound: true }> {
  const client = db ?? (await userClient());
  const item = await readDetailItem(client, id);
  if (!item || item.canonicalSurface !== surface) return { notFound: true };
  const { uuid, resource, connections, supersessions } = item;
  const relatedIds = [...new Set([...connections.map((c) => c.id), ...supersessions.flatMap((s) => [s.old, s.new])])].filter(Boolean);
  const [claims, lookup, itemScoped] = await Promise.all([
    readClaims(client, uuid),
    buildResourceLookup(client, relatedIds),
    loadItemScoped ? loadItemScoped({ db: client, uuid, resource, connections, supersessions }) : Promise.resolve(undefined as ItemScoped),
  ]);
  const crossPage = await readCrossPage(client, uuid, surface, item.intersectionSummary, connections, lookup);
  const redacted = redactSuppressedClaims({ sections: item.sections, fullBrief: resource.fullBrief ?? null, claims: claims.suppressed });
  return {
    notFound: false,
    uuid,
    resource: redacted.fullBrief === (resource.fullBrief ?? null) ? resource : { ...resource, fullBrief: redacted.fullBrief ?? "" },
    connections,
    supersessions,
    changelog: item.changelog,
    dispute: item.dispute,
    sections: redacted.sections,
    claimTiers: claims.tiers,
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
