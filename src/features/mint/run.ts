// Ported from old_repo/scripts/mint/run-mint-batch.mjs (lines 477-647)
// Ported from old_repo/scripts/mint/apply-mint-batch.mjs (lines 517-709)
// Ported from old_repo/scripts/mint/export-census-rows.mjs (lines 922-1032)
// Ported from old_repo/scripts/mint/export-census-rows.mjs (lines 1456-1500)
// ONE in-process mint run (the old chain of three CLIs joined by files on disk): select, hold what is already held (key, then URL with identity), screen, limit to the
// mintable rows, resolve each row's source and document identity, capture (the DB cache first, then the free transports), build, preflight, apply. The flywheel hand-off
// happens inside each mint (rule 17), its counts come back on this result, and one `mint` ledger row is recorded per minted item. Every row ends with its disposition on
// census_worklist (INV-297): reconciled for a verified mint, a stage-qualified hold otherwise. A dry run writes nothing and returns the same counts as `would_*`.
import { buildTitleForRow, capture, detectCellarGarbledMetadata, detectNotInForce, FetchHoldError, assertFetchAllowed, apiEndpointFor, parseOjReference } from "@/core/fetch";
import type { CaptureResult } from "@/core/fetch";
import { fetchAllByIdChunks } from "@/core/db";
import { resolveDocumentIdentity } from "@/core/intake";
import { runResult, type RunResult } from "@/core/intake/result";
import { readRequiredSlots } from "@/core/grounding";
import { DWELL_BOUND_DAYS } from "@/features/intake/quarantine/planner";

import { applyPayload, holdRow, reconcileRow } from "./apply";
import { buildPayload } from "./build-payload";
import type { MintRunDeps } from "./deps";
import { preflight } from "./preflight";
import { buildHeldIndex, isHeld, readHolders, resolveLimit, selectCensusRows } from "./select";
import { loadReviewedVerdicts, screenVerdictFor } from "./screen";
import type { CensusRow, ExportRow, Hold, RowResult, SourceRow } from "./types";

export interface MintRunInput {
  limit?: number | null;
  sourceId?: string | null;
  celexPrefix?: string | null;
  mode?: "plan" | "apply";
  /** A dry run writes nothing; the default. `mode: "apply"` clears it. */
  dry?: boolean;
}
export type MintRunResult = RunResult & { rows: RowResult[]; mintedIds: string[] };
const SOURCE_COLUMNS = "id, url, name, base_tier, tier_override, status, institution_id, category";
const DAY_MS = 86_400_000;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The stored capture for a URL (the DB cache), the longest over 200 characters. A read error throws: the row is then deferred, never fetched blind. */
async function storedCapture(deps: MintRunDeps, url: string): Promise<string | null> {
  const r = await deps.sb.from("agent_run_searches").select("result_content").eq("result_url", url).limit(20);
  if (r.error) throw new Error(`stored capture read failed for ${url}: ${r.error.message}`);
  const best = ((r.data ?? []) as { result_content: string | null }[]).map((x) => x.result_content ?? "").filter((t) => t.trim().length > 200).sort((a, b) => b.length - a.length)[0];
  return best ?? null;
}
async function frDocType(num: string, deps: MintRunDeps): Promise<string | null> {
  const base = apiEndpointFor("https://www.federalregister.gov/");
  const url = `${base}/documents/${encodeURIComponent(num)}.json?fields[]=type`;
  await assertFetchAllowed(url, deps.fetch.caller, deps.fetch);
  const res = await (deps.fetch.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(20_000) });
  return res.ok ? (((await res.json()) as { type?: string }).type ?? null) : null;
}
const familyOf = (scheme: string | null, url: string) => (parseOjReference(url) ? ("oj_issue" as const) : scheme === "celex" ? ("celex" as const) : scheme === "uk_legislation" ? ("uk_legislation" as const) : scheme === "federal_register" ? ("federal_register" as const) : ("generic" as const));

export async function runMint(deps: MintRunDeps, input: MintRunInput = {}): Promise<MintRunResult> {
  const dry = input.dry ?? input.mode !== "apply";
  const counts: Record<string, number> = { candidates: 0, held: 0, screened_out: 0, selected: 0, minted: 0, minted_verified: 0, minted_unverified: 0, would_mint: 0, refused: 0, failed: 0, deferred: 0, census_write_failed: 0, participation_steps_failed: 0, participation_steps_run: 0 };
  const notes: string[] = [];
  const rows: RowResult[] = [];
  const mintedIds: string[] = [];
  const bump = (k: string, n = 1) => void (counts[k] = (counts[k] ?? 0) + n);
  const nowIso = () => deps.now().toISOString();
  const place = async (hold: Hold, extra: Record<string, unknown> = {}) => {
    bump("held");
    bump(`hold_${hold.reason.split(":")[0]}`);
    rows.push({ rowId: hold.rowId, outcome: "held", hold: hold.reason });
    if (dry) return;
    const n = await holdRow(deps.sb, hold, nowIso(), extra);
    if (n) {
      bump("census_write_failed");
      notes.push(n);
    }
  };
  let limit: number;
  try {
    limit = resolveLimit(input.limit);
  } catch (e) {
    return { ...runResult("failed", counts, [msg(e)]), rows, mintedIds };
  }

  const keyFor = (r: CensusRow) => resolveDocumentIdentity(r, null, deps.identity).canonicalKey;
  let candidates: CensusRow[];
  let screens: Map<string, ReturnType<typeof screenVerdictFor>>;
  let held: ReturnType<typeof buildHeldIndex>;
  try {
    candidates = await selectCensusRows(deps.sb, { sourceId: input.sourceId ?? null, celexPrefix: input.celexPrefix ?? null });
    bump("candidates", candidates.length);
    held = buildHeldIndex(await readHolders(deps.sb, candidates.map((r) => r.document_url), candidates.map(keyFor).filter((k): k is string => !!k)));
    const reviewed = await loadReviewedVerdicts(deps.sb);
    screens = new Map(candidates.map((r) => [r.id, screenVerdictFor(r, reviewed)]));
  } catch (e) {
    return { ...runResult("failed", counts, [`selection failed (nothing was held or minted): ${msg(e)}`]), rows, mintedIds };
  }

  // Already held (key first, then URL with the same identity), then the screen. The limit applies to the MINTABLE rows that remain.
  const mintable: CensusRow[] = [];
  for (const r of candidates) {
    const h = isHeld({ url: r.document_url, key: keyFor(r), instrumentIdentifier: r.instrument_identifier }, held);
    const s = screens.get(r.id);
    if (h.held) await place({ rowId: r.id, reason: `held:already_held_by_${h.by}:${h.holderId}`, evidence: { holder_archived: h.archived } });
    else if (s && s.verdict === "off_vertical") {
      bump("screened_out");
      await place({ rowId: r.id, reason: `screen:off_vertical:${s.rule ?? "reviewed"}`, evidence: { basis: s.basis } });
    }
    else if (s && s.verdict === "ambiguous") {
      bump("screened_out");
      const expires = new Date(deps.now().getTime() + DWELL_BOUND_DAYS * DAY_MS).toISOString();
      await place({ rowId: r.id, reason: `screen:ambiguous:${s.rule ?? "unruled"}`, evidence: { basis: s.basis } }, { max_age_days: DWELL_BOUND_DAYS, expires_at: expires, export_kind: "screen-verdict" });
    } else mintable.push(r);
  }
  const chosen = mintable.slice(0, limit);
  bump("selected", chosen.length);

  let sources: SourceRow[];
  try {
    sources = await fetchAllByIdChunks(new Set(chosen.map((r) => r.source_id)), async (slice) => {
      const r = await deps.sb.from("sources").select(SOURCE_COLUMNS).in("id", slice);
      if (r.error) throw new Error(`sources read failed: ${r.error.message}`);
      return (r.data ?? []) as SourceRow[];
    });
  } catch (e) {
    return { ...runResult("failed", counts, [`source registry read failed: ${msg(e)}`]), rows, mintedIds };
  }
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const slotCache = new Map<string, string[]>();

  for (const row of chosen) {
    try {
      const source = sourceById.get(row.source_id);
      if (!source) { await place({ rowId: row.id, reason: "source:source_not_found" }); continue; }
      let identity = resolveDocumentIdentity(row, source, deps.identity);
      if (identity.needsFrLookup && identity.frDocumentNumber) identity = resolveDocumentIdentity(row, source, deps.identity, { frDocType: (await frDocType(identity.frDocumentNumber, deps)) ?? "" });
      if (identity.hold || !identity.itemType) { await place({ rowId: row.id, reason: `identity:${identity.hold ?? "item_type_unmapped"}`, evidence: { scheme: identity.scheme, host: identity.host } }); continue; }

      let text = await storedCapture(deps, row.document_url);
      let fetched: CaptureResult | null = null;
      if (!text) {
        fetched = await capture(row.document_url, { family: familyOf(identity.scheme, row.document_url), key: identity.canonicalKey }, deps.fetch);
        if (!fetched.usable) { await place({ rowId: row.id, reason: `capture:${fetched.holdReason ?? "capture_failed"}` }); continue; }
        text = fetched.text;
      }
      const body = text ?? "";
      const garbled = detectCellarGarbledMetadata(body);
      const force = detectNotInForce(body);
      if (body.trim().length <= 200) { await place({ rowId: row.id, reason: "capture:capture_too_short", evidence: { fetched_length: body.length } }); continue; }
      if (garbled) { await place({ rowId: row.id, reason: "capture:capture_garbled_metadata", evidence: { span: garbled.span } }); continue; }
      if (force?.notInForce) { await place({ rowId: row.id, reason: "capture:not_in_force", evidence: { span: force.span, status: force.statusText } }); continue; }

      const identifier = identity.instrumentIdentifier ?? row.instrument_identifier;
      const title = buildTitleForRow({ capture: { text: body, html: fetched?.html ?? null, title: fetched?.title ?? null, titleOrigin: fetched?.titleOrigin ?? null }, source, identifier });
      const screen = screens.get(row.id);
      if (!screen) throw new Error(`no screen verdict for ${row.id}`);
      const exportRow: ExportRow = { census_id: row.id, source_url: row.document_url, item_type: identity.itemType, title: title.title, title_origin: title.origin, instrument_identifier: identifier, canonical_instrument_key: identity.canonicalKey, jurisdiction_iso: identity.jurisdictionIso, priority: "MODERATE", source, captured_text: body, fetched_length: body.length, screen };
      if (!slotCache.has(identity.itemType)) slotCache.set(identity.itemType, (await readRequiredSlots(deps.sb, identity.itemType)).map((s) => s.slot_key));
      const built = buildPayload(exportRow, slotCache.get(identity.itemType) ?? []);
      if (!built.ok) { await place({ rowId: row.id, reason: "validation_failed:kit:build_failed", evidence: { error: built.error } }); continue; }
      const pre = preflight(built.built.payload, { isSeriesKey: (i) => deps.isSeriesKey(i) });
      for (const w of pre.warnings) notes.push(`tag warning for ${row.id}: ${w.field}`);
      const first = pre.failures[0];
      if (first) { await place({ rowId: row.id, reason: `validation_failed:${String(first.criterion)}:${first.reason}`, evidence: { failures: pre.failures } }); continue; }

      const ctx = { sb: deps.sb, entities: deps.entities, connect: deps.connect, now: () => deps.now() };
      const res = await applyPayload(built.built, source, ctx, { dry });
      notes.push(...res.notes);
      if (res.outcome === "would_mint") { bump("would_mint"); rows.push({ rowId: row.id, outcome: "would_mint" }); continue; }
      if (res.outcome === "failed") { bump("failed"); rows.push({ rowId: row.id, outcome: "failed", itemId: res.itemId, detail: res.reasons.join("; ") }); notes.push(`mint failed for ${row.id}: ${res.reasons.join("; ")}`); continue; }
      if (res.outcome === "refused") { bump("refused"); if (res.hold) await place(res.hold); continue; }

      bump("minted");
      bump(res.outcome);
      mintedIds.push(res.itemId as string);
      rows.push({ rowId: row.id, outcome: res.outcome, itemId: res.itemId });
      const p = res.detail?.participation;
      if (p) {
        bump("participation_steps_run", p.counts.steps_run ?? 0);
        bump("participation_steps_failed", p.counts.steps_failed ?? 0);
        notes.push(...p.notes);
      }
      if (res.outcome === "minted_verified") {
        const n = await reconcileRow(deps.sb, row.id);
        if (n) {
      bump("census_write_failed");
      notes.push(n);
    }
      } else if (res.hold) {
        const n = await holdRow(deps.sb, res.hold, nowIso());
        if (n) {
      bump("census_write_failed");
      notes.push(n);
    }
        bump("held");
      }
      const rec = await deps.recorder.recordRun({ family: "mint", itemId: res.itemId, outcome: res.outcome === "minted_verified" && !(p?.counts.steps_failed) ? "ok" : "partial", counts: { ...(p?.counts ?? {}), ...(res.detail?.written ?? {}) }, notes: [...(p?.notes ?? []), ...res.reasons] });
      if (rec.error) notes.push(`ledger row for ${res.itemId} not recorded: ${rec.error}`);
    } catch (e) {
      if (e instanceof FetchHoldError) {
        bump("deferred");
        rows.push({ rowId: row.id, outcome: "deferred", detail: msg(e) });
        notes.push(`fetch hold: ${row.id} deferred (${msg(e)})`);
      } else {
        bump("failed");
        rows.push({ rowId: row.id, outcome: "failed", detail: msg(e) });
        notes.push(`row ${row.id} failed: ${msg(e)}`);
      }
    }
  }

  const partial = (counts.failed ?? 0) + (counts.census_write_failed ?? 0) + (counts.participation_steps_failed ?? 0) + (counts.minted_unverified ?? 0) > 0 || notes.some((n) => n.startsWith("ledger row"));
  return { ...runResult(partial ? "partial" : "ok", counts, notes), rows, mintedIds };
}
