// Ported from old_repo/src/app/api/coverage/entries/route.ts (lines 1-28)
import { LookupError } from "@/core/http/errors";
import { adminRoute, reply } from "@/features/admin/api/shared";

import { COVERAGE_SURFACES, getCoverageEntries, type CoverageSurface } from "../server/census";

/** The catalogue behind the coverage numbers, for the admin catalogue view only: every catalogued instrument of a surface (or all), whole. A failed read is a 503 the screen shows with Retry. */
export const GET = adminRoute("/api/coverage/entries", async (admin, request) => {
  const asked = new URL(request.url).searchParams.get("surface");
  const surface = asked && (COVERAGE_SURFACES as readonly string[]).includes(asked) ? (asked as CoverageSurface) : undefined;
  let entries;
  try {
    entries = await getCoverageEntries(admin.service(), surface);
  } catch (e) {
    throw new LookupError("coverage entries", e);
  }
  return reply(admin, { entries, total: entries.length, surface: surface ?? "all" }, 200, { "Cache-Control": "private, max-age=60" });
});
