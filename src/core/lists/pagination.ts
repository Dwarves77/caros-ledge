// Ported from old_repo/src/lib/list-pagination.ts (lines 1-158)
// Page sizes, the ledger row payload trim, and the lossless keyset cursor (INV-266).
import type { Resource } from "@/core/types";

/** Rows per page and for the first page of a list surface. */
export const pageSizes = { next: 30, first: 60 } as const;

/** The fields a list row never draws are dropped before the payload crosses to the client. */
export function trimRemainder(r: Resource): Resource {
  return {
    ...r,
    keyData: [],
    reasoning: "",
    fullBrief: undefined,
    regulatoryConflict: undefined,
    trajectoryPoints: undefined,
    operationalImpact: undefined,
    riskRegister: undefined,
    recommendedActions: undefined,
    openQuestions: undefined,
    sourceUrls: undefined,
    costMechanism: undefined,
    penaltyRange: undefined,
    enforcementBody: undefined,
    requirementTrajectory: undefined,
  };
}

export interface ListingCursor {
  offset: number;
  afterPriority?: string;
  afterAddedDate?: string | null;
  afterId?: string;
}
const FIRST: ListingCursor = { offset: 0 };

export const keysetCursor = {
  first: FIRST,
  /** The cursor after `rows`: the last row's priority, added date and id (the listing RPC's own order ends in id). */
  after(previous: ListingCursor, rows: Resource[]): ListingCursor {
    const last = rows[rows.length - 1];
    return last ? { offset: previous.offset + rows.length, afterPriority: last.priority, afterAddedDate: last.added ?? null, afterId: last.id } : previous;
  },
  encode: (cursor: ListingCursor): string => encodeURIComponent(JSON.stringify(cursor)),
  /** Never throws: a malformed or tampered cursor restarts at page one. */
  decode(raw: string | null | undefined): ListingCursor {
    if (!raw) return FIRST;
    try {
      const parsed: unknown = JSON.parse(decodeURIComponent(raw));
      if (!parsed || typeof parsed !== "object") return FIRST;
      const p = parsed as Record<string, unknown>;
      if (typeof p.offset !== "number" || !Number.isInteger(p.offset) || p.offset < 0) return FIRST;
      const cursor: ListingCursor = { offset: p.offset };
      if (typeof p.afterPriority === "string" && p.afterPriority) cursor.afterPriority = p.afterPriority;
      if (typeof p.afterId === "string" && p.afterId) cursor.afterId = p.afterId;
      if (typeof p.afterAddedDate === "string" || p.afterAddedDate === null) cursor.afterAddedDate = p.afterAddedDate;
      return cursor;
    } catch {
      return FIRST;
    }
  },
};
