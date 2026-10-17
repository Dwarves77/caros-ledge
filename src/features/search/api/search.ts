// Ported from old_repo/src/app/api/search/route.ts (lines 29-58)
import { LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";

import { runSearch } from "../run-search";
import { MIN_QUERY_LEN, type SearchRow } from "../types";

// GET /api/search?q=: Standard Search on the caller's own client (SEC-10). A query under two characters answers an empty list; a failed read is a 503 with Retry-After, which the
// command bar shows as a failed search with Retry (INV-263), never as "No results".
export const GET = route("/api/search", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < MIN_QUERY_LEN) return ok(auth.headers, { query: q, results: [] });
  const found = await runSearch<SearchRow>(auth.client, q);
  if (!found.ok) throw new LookupError("search", { message: found.message });
  return ok(auth.headers, { query: q, results: found.rows });
});
