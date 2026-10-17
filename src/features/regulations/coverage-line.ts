// New in P2-10: what the coverage line under a list draws. The link to the coverage page is ALWAYS present; the count beside it is the stated count, the empty-catalogue note, or the Absence token when
// the count could not be read (the read failed, or the database does not yet carry the object it reads). One function, so the page and its test agree.
import { coverageHref } from "@/core/coverage";
import type { DenominatorLine } from "@/core/coverage/matrix";

export interface CoverageLineModel {
  href: string;
  state: "count" | "empty-catalogue" | "unavailable";
}
export function coverageLineModel(denominator: DenominatorLine | null, failed: boolean, surface: string): CoverageLineModel {
  const href = denominator?.href ?? coverageHref({ dataClass: surface });
  if (failed || !denominator) return { href, state: "unavailable" };
  return { href, state: denominator.denominator === 0 ? "empty-catalogue" : "count" };
}
