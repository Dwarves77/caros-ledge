// Ported from old_repo/src/lib/list-pagination.ts (lines 1-157)
// Page sizes, the ledger row payload trim, and the lossless keyset cursor (INV-266).
import type { Resource } from "@/core/types";

/** Rows per page and for the first page of a list surface. */
export const pageSizes = { next: 30, first: 60 } as const;

const DROPPED = ["fullBrief", "regulatoryConflict", "trajectoryPoints", "operationalImpact", "riskRegister", "recommendedActions", "openQuestions", "sourceUrls", "costMechanism", "penaltyRange", "enforcementBody", "requirementTrajectory"] as const;

/** The fields a list row never draws are dropped (not set to undefined) before the payload crosses to the client. */
export function trimRemainder(r: Resource): Resource {
  const out: Resource = { ...r, keyData: [], reasoning: "" };
  for (const k of DROPPED) delete out[k];
  return out;
}

export interface ListingCursor {
  offset: number;
  afterPriority?: string;
  afterAddedDate?: string | null;
  afterId?: string;
}

