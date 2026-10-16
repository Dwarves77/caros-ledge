// Ported from old_repo/scripts/turns/ledger-verdicts/README.md (lines 1-241)
// The session-verdict batch for the portal ledger (the free replacement for the metered classifier): the file P2-04's reader validates (a structural violation refuses the WHOLE file; an entry under another prompt version
// is excluded and COUNTED; one verdict per URL, the newest wins), then the intake consume runs with exactly those verdicts, so a candidate with a verdict is classified, minted at record grade through the one chokepoint
// and stamped, and a candidate with none stays owed. The export lists the candidates awaiting a verdict with their page text where the scrape gate allows a fetch (an access wall or a failed fetch is named, never
// sent for a verdict). Nothing is sent to a model.
import { CLASSIFY_INSTRUCTION, CLASSIFY_PROMPT_VERSION, CONTENT_MAX_CHARS, readVerdictFile } from "@/core/intake";
import { runResult, worst } from "@/core/types/run-result";
import type { RunResult } from "@/core/types/run-result";
import { consumePortalCandidates, selectCandidateLedgerPage } from "@/features/intake";

import type { ApplyOpts, BatchDeps, BatchExport, Obj } from "../../kit/session-batch";

export const LEDGER_EXPORT_LIMIT = 100;
export const LEDGER_APPLY_LIMIT = 200;
export const LEDGER_MAX_PROMOTE = 50;

/** Apply one verdict file: validate it whole, then consume the ledger with its verdicts (plan when dry). */
export async function applyLedgerVerdicts(deps: BatchDeps, file: unknown, o: ApplyOpts & { maxPromote?: number }): Promise<RunResult> {
  const read = readVerdictFile(file);
  if (!read.ok) return runResult("failed", { refused: 1, file_refused: 1 }, read.errors.slice(0, 12).map((e) => `ledger-verdicts: verdict file refused whole: ${e}`));
  const limit = typeof o.limit === "number" && o.limit > 0 ? o.limit : LEDGER_APPLY_LIMIT;
  const c = await consumePortalCandidates(deps.intake, { mode: o.dry ? "plan" : "apply", limit, verdicts: read.byUrl, maxPromote: o.maxPromote ?? LEDGER_MAX_PROMOTE, recordOnly: true });
  const by = (d: string) => c.outcomes.filter((x) => x.disposition === d).length;
  const promoted = c.outcomes.filter((x) => x.disposition === "promoted" && x.itemId).map((x) => x.itemId as string);
  const counts = {
    entries: read.byUrl.size, stale_prompt_version: read.stale, superseded: read.superseded, discovered: c.discovered, fetched: c.fetched, classified: c.classified, promoted: promoted.length, exists: by("exists"),
    rejected: by("rejected") + by("not_an_item"), skipped: by("skipped"), verdicts_owed: c.outcomes.filter((x) => x.reason.startsWith("skipped-no-verdict")).length, applied: promoted.length + by("rejected") + by("not_an_item") + by("exists"),
  };
  return { ...runResult(worst(c.outcome, read.stale ? "partial" : "ok"), counts, [...(read.stale ? [`${read.stale} entry(ies) under another prompt version were excluded: re-author them under ${CLASSIFY_PROMPT_VERSION}`] : []), ...c.notes]), data: { ids: { minted_item_ids: promoted } } } as RunResult;
}

/** The candidates awaiting a verdict, each with the page text a session classifies from (the scrape gate decides whether a fetch is allowed; no text is guessed from the URL). */
export function ledgerVerdictsExporter(deps: BatchDeps) {
  return async ({ limit }: { limit: number }): Promise<BatchExport> => {
    try {
      const page = await selectCandidateLedgerPage(deps.sb, { limit });
      const items: Obj[] = [];
      for (const r of page) {
        const base = { candidate_id: r.id, url: r.url, source_id: r.source_id, anchor_text: r.anchor_text, first_seen_at: r.first_seen_at, source_name: r.sources?.name ?? null, source_category: r.sources?.category ?? null, source_tier: r.sources?.base_tier ?? null };
        if (!deps.intake.sources.fetchAllowed(r.url, null)) {
          items.push({ ...base, text: null, fetch_ok: false, fetch_error: "fetch held: the scrape gate is closed" });
          continue;
        }
        const cap = await deps.intake.sources.capture(r.url, { family: "portal-ledger", key: r.id });
        const text = cap.ok ? cap.text.slice(0, CONTENT_MAX_CHARS) : null;
        const error = cap.wall ? `access_wall:${cap.wall.kind}` : !cap.ok ? (cap.reason ?? "fetch failed") : cap.text.trim().length < 200 ? "below_floor_200" : null;
        items.push({ ...base, text, fetch_ok: error === null, fetch_error: error, fetched_chars: cap.text.length });
      }
      return { ok: true, items, current_prompt_version: CLASSIFY_PROMPT_VERSION, source: { type: "table", table: "portal_link_candidates" }, summary: { prompt_version: CLASSIFY_PROMPT_VERSION, content_max_chars: CONTENT_MAX_CHARS, instruction: CLASSIFY_INSTRUCTION, candidates: items.length, classify_ready: items.filter((i) => i.fetch_ok === true).length } };
    } catch (e) {
      return { ok: false, items: [], error: (e as Error).message };
    }
  };
}
