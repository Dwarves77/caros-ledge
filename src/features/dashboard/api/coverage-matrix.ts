// Ported from old_repo/src/app/api/dashboard/coverage/matrix/logic.ts (lines 10-51)
// Ported from old_repo/src/app/api/dashboard/coverage/matrix/route.ts (lines 1-10)
import { buildCoverageView, csvFilename, matrixToCsv, parseCoverageQuery } from "@/core/coverage";
import { serviceClient } from "@/core/db/clients";
import { countryLabel } from "@/core/jurisdictions";
import { LookupError, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { makeCoverageData } from "@/features/coverage/server";

// GET /api/dashboard/coverage/matrix: the coverage matrix as JSON, as a summary (?summary=1) or as CSV (?format=csv), for a signed-in reader. The census is platform data no workspace owns, so the read is
// a live platform read. An outage is a 503 the client retries, never an empty matrix that reads as "nothing catalogued" (INV-263).
const coverage = makeCoverageData({ db: serviceClient, now: () => new Date().toISOString(), labelOf: countryLabel });
const PRIVATE = "private, max-age=60";

export const GET = route("/api/dashboard/coverage/matrix", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const { matrix, error } = await coverage.getCoverageMatrix();
  if (error) throw new LookupError("coverage matrix", { message: error });
  const params = new URL(request.url).searchParams;
  const query = parseCoverageQuery(params);
  if (params.get("format") === "csv") return new Response(matrixToCsv(matrix, query), { headers: { ...auth.headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${csvFilename(matrix, query)}"`, "Cache-Control": PRIVATE } });
  const body = params.get("summary") === "1" ? { version: matrix.version, generatedAt: matrix.generatedAt, dataAsOf: matrix.dataAsOf, totals: matrix.totals, verifiedBriefs: matrix.verifiedBriefs, dataClasses: matrix.dataClasses } : { matrix, view: buildCoverageView(matrix, query) };
  return Response.json(body, { headers: { ...auth.headers, "Cache-Control": PRIVATE } });
});
