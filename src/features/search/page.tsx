// Ported from old_repo/src/app/search/page.tsx (lines 16-42)
import { userClient } from "@/core/db/clients";
import { formatLocaleDate } from "@/core/shared";
import { pageSession } from "@/features/account/server/page-session";
import { PageFailure } from "@/features/account/ui/PageFailure";

import { runSearch } from "./run-search";
import { MAX_RESULTS, MIN_QUERY_LEN, type SearchOutcome, type SearchRow } from "./types";
import { SearchResultsView } from "./ui/SearchResultsView";

/** `/search?q=`: the session gate, then the one retrieval on the caller's own client. A failed read is the view's failure state with Retry, never "No results". */
export default async function SearchRoute({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  const session = await pageSession(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  if ("failed" in session) return <PageFailure what="Search" />;
  const outcome: SearchOutcome<SearchRow> = q.length >= MIN_QUERY_LEN ? await runSearch<SearchRow>(await userClient(), q) : { ok: true, rows: [] };
  const dateLabel = formatLocaleDate(new Date(session.nowIso), { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  return <SearchResultsView q={q} outcome={outcome} maxResults={MAX_RESULTS} dateLabel={dateLabel} nowIso={session.nowIso} />;
}
