// Ported from old_repo/scripts/turns/apply-theme-briefs.mjs (lines 31-118)
// Ported from old_repo/scripts/turns/export-themes-for-briefs.mjs (lines 1-138)
// Theme briefs applied over the free theme-brief seam (P2-06): each entry is validated against the theme's LIVE material (the structured contract: sections, claims, figures, the listed text against the grounded claim), and the seam
// writes only what validation returned (a ValidThemeBrief) through one database call that re-checks the live membership hash (INV-191). The stored hash and batch name are read back. A single markdown or JSON brief is turned into ONE
// entry of a one-entry batch and takes the same path: it is refused with the same reasons when it fails (there is no second route to the writer, R2b I6). A replaced brief's prior row is kept by the AFTER UPDATE trigger on
// theme_briefs (theme_brief_versions, migration 0039). The export is the themes that need a brief (none, stale or superseded), one bundle each within the character budget.
import { computeMemberHash } from "@/core/flywheel/themes";
import { parseFrontmatter } from "@/core/briefs/frontmatter";
import { parseThemeBriefEntry, type ThemeContext, type ValidThemeBrief } from "@/core/briefs/theme-brief-contract";
import { buildThemeBundle, buildValidationContext, computeThemeGaps, loadBriefs, loadLineage, loadThemeMaterial, loadThemes, themesNeedingBrief, type ThemeRow } from "@/core/briefs/theme-brief-material";
import type { Db } from "@/core/db";
import { packetReader, type Packet, type PacketReader } from "@/core/digest/packets-client";
import { applyThemeBrief } from "@/features/flywheel";
import { rowsByIds } from "@/core/db";
import { review, secondReaderBlock, singleSourceReason } from "@/core/digest/review";
import { surfaceOf } from "@/core/routing";
import { readPool } from "@/core/grounding";

import { candidateMenu, memberSeed, menuBlock, packetSeed } from "../item-briefs/candidates";
import { applyEntries, isObj, type ApplyOpts, type BatchDeps, type BatchExport, type EntrySpec } from "../../kit/session-batch";
import { activeEntityIds, connectionEntityIds, heldWriteback, verifyWriteback, writebackHeld, writeWriteback, type HeldWriteback, type WritebackLive, type WritebackPlan } from "../../kit/writeback";

/** The batch name a single payload is applied under (the one-entry batch it becomes). */
const SINGLE_BATCH = "theme-briefs-single-payload";
const DEFAULT_CHAR_BUDGET = 120_000;
interface ThemeLive { wb: WbLive; ctx: ThemeContext; themes: Map<string, ThemeRow>; /** The surface each live member sits on (the no-single-source test reads it). */ surfaces: Map<string, string>; stored: Map<string, { member_hash: string; generated_by: string; brief_md: string }> }
/** The write-back material of the batch (ENGINE-UNBLOCK-1, operator engine spec 2026-10-26): the entities that exist, the member captures a connection may quote, and the signposts an earlier apply already registered. */
interface WbLive { now: Date; entities: ReadonlyMap<string, string>; captures: Map<string, Map<string, string>>; held: HeldWriteback }
interface Plan { memberIds: string[]; brief: ValidThemeBrief; wb: WritebackPlan; briefDone: boolean }
const WB_KEYS = ["signposts", "coverage_gaps", "connections"] as const;
const hasWb = (e: unknown): boolean => isObj(e) && WB_KEYS.some((k) => e[k] !== undefined);

const themeBriefsSpec: EntrySpec<ThemeLive, Plan> = {
  kind: "theme-briefs",
  batchRe: /^theme-briefs-[A-Za-z0-9._-]+$/,
  ceiling: 100,
  keyOf: (e) => (typeof e.theme_id === "string" ? e.theme_id : null),
  async load(deps, file) {
    const ids = [...new Set((file.entries as unknown[]).map((e) => (isObj(e) && typeof e.theme_id === "string" ? e.theme_id : "")).filter(Boolean))];
    const themes = await loadThemes(deps.sb, ids);
    const material = await loadThemeMaterial(deps.sb, themes);
    const stored = await rowsByIds<{ theme_id: string; member_hash: string; generated_by: string; brief_md: string }>(deps.sb, "theme_briefs", "theme_id, member_hash, generated_by, brief_md", ids, "theme_id", "theme_id");
    const wbEntries = (file.entries as unknown[]).filter(hasWb) as Record<string, unknown>[];
    const captures = new Map<string, Map<string, string>>();
    for (const e of wbEntries) if (e.connections !== undefined && typeof e.theme_id === "string") captures.set(e.theme_id, new Map((await Promise.all((themes.find((t) => t.id === e.theme_id)?.member_ids ?? []).map((id) => readPool(deps.sb, id)))).flat().map((c) => [c.id, c.text])));
    const wb: WbLive = { now: deps.now(), entities: await activeEntityIds(deps.sb, wbEntries.flatMap(connectionEntityIds)), captures, held: await heldWriteback(deps.sb, "theme-briefs", wbEntries) };
    return { wb, ctx: buildValidationContext(themes, material, computeThemeGaps(themes, material)), themes: new Map(themes.map((t) => [t.id, t])), surfaces: new Map(material.items.map((i) => [i.id, surfaceOf(i.item_type, i.domain)])), stored: new Map(stored.map((s) => [s.theme_id, s])) };
  },
  entry(e, i, live) {
    const v = parseThemeBriefEntry(e, i, live.ctx);
    if (!v.ok) return { errors: v.errors };
    const id = v.brief.theme_id;
    // The second reader's binary judges and the no-single-source test (HOW-TO-LOOK point 3, INV-DIG-7): a brief whose cited rows sit in one table or on one surface is residue with the reason.
    const cited = (v.brief.claims as { member_id: string; claim_ids: string[] }[]).flatMap((c) => c.claim_ids.map((cid) => ({ table: live.ctx.membersById.get(c.member_id)?.event_ids.has(cid) ? "item_forward_events" : "section_claim_provenance", surface: live.surfaces.get(c.member_id) ?? null })));
    const why = [...review("theme-briefs", e as Record<string, unknown>).reasons.map((r) => `second reader: ${r}`), ...[singleSourceReason(cited)].flatMap((r) => r ?? [])];
    if (why.length) return { errors: [], residue: why.map((r) => `theme ${id}: ${r}`) };
    const members = (live.themes.get(id)?.member_ids ?? []).slice().sort();
    // CONTAIN-FIX-1: the brief's figures are held by findUncitedFigures/figureCoverage (theme-brief-contract); the gaps are checked against this evidence in verifyWriteback
    const claims = v.brief.claims as { member_id: string; claim_ids: string[] }[];
    const evidence = claims.flatMap((c) => c.claim_ids.flatMap((cid) => live.ctx.groundedText.get(cid) ?? []));
    const wbLive: WritebackLive = { evidence, captures: live.wb.captures.get(id) ?? new Map(), ids: live.wb.entities, now: live.wb.now, itemIds: members };
    const wb = verifyWriteback(e as Record<string, unknown>, `theme ${id}`, wbLive);
    if (wb.errors.length) return { errors: wb.errors };
    const prior = live.stored.get(id);
    const briefDone = !!prior && prior.member_hash === computeMemberHash(members) && prior.brief_md === v.brief.brief_md;
    return briefDone && writebackHeld(wb.plan, live.wb.held) ? { errors: [], done: true } : { errors: [], plan: { memberIds: members, brief: v.brief, wb: wb.plan, briefDone } };
  },
  residueReview: (e, key) => (key ? { subjectId: key, score: review("theme-briefs", e).score, reviewedBy: review("theme-briefs", e).reviewed_by ?? "none" } : null),
  async write(deps, _live, item, batch) {
    const counts: Record<string, number> = { briefs_written: 0 };
    if (!item.plan.briefDone) {
      const r = await applyThemeBrief({ sb: deps.sb, now: deps.now }, { brief: item.plan.brief, batch, dry: false });
      if (r.outcome === "failed" || !r.counts.written) throw new Error(r.notes.join("; ") || "the seam wrote nothing");
      counts.briefs_written = 1;
    }
    // The write-back (operator engine spec 2026-10-26): signposts, new connections and the coverage gaps queued for the hunt, written after the brief they were raised by.
    const wb = await writeWriteback(deps, item.plan.wb, { kind: "theme-briefs", batch, subject: item.plan.brief.theme_id, findingId: null, citedItemIds: item.plan.memberIds, inputs: item.plan.memberIds.map((pk) => ({ table: "intelligence_items", pk })) });
    for (const [k, n] of Object.entries(wb.counts)) counts[k] = n;
    return { ref: item.plan.brief.theme_id, counts, notes: wb.notes };
  },
  async readBack(deps, live, written, batch) {
    const stored = new Map((await rowsByIds<{ theme_id: string; member_hash: string; generated_by: string }>(deps.sb, "theme_briefs", "theme_id, member_hash, generated_by", written.map((w) => w.ref), "theme_id", "theme_id")).map((r) => [r.theme_id, r]));
    return written.filter((w) => { const s = stored.get(w.ref); return !s || s.member_hash !== computeMemberHash(live.themes.get(w.ref)?.member_ids ?? []) || s.generated_by !== batch; }).map((w) => w.ref);
  },
};

const applyThemeBriefBatch = (deps: BatchDeps, file: unknown, o: ApplyOpts) => applyEntries(themeBriefsSpec, deps, file, o);

/**
 * One theme-briefs apply from the stage's content. A batch file (it has `entries`) goes through the structured batch path; a single brief (an entry as JSON, or markdown with a frontmatter block) becomes the one entry of a
 * one-entry batch and goes through the SAME path, so the same validator refuses it with the same reasons. A markdown brief carries no sections or claims, so it is refused: the unvalidated route no longer exists.
 */
export async function applyThemeBriefs(deps: BatchDeps, input: { content: string; format?: "json" | "md" }, o: ApplyOpts) {
  const wrap = (entry: unknown) => ({ batch: SINGLE_BATCH, generated_at: deps.now().toISOString(), authored_by: "session-lane", entries: [entry] });
  if (input.format === "md") {
    const fm = parseFrontmatter(input.content);
    return applyThemeBriefBatch(deps, wrap({ ...(fm?.fields ?? {}), brief_md: fm?.body }), o);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.content);
  } catch (e) {
    return { counts: { refused: 1 }, outcome: "failed" as const, notes: [`theme-briefs content is not JSON: ${(e as Error).message}`] };
  }
  return applyThemeBriefBatch(deps, isObj(parsed) && Array.isArray(parsed.entries) ? parsed : wrap(parsed), o);
}

/** The export: themes that need a brief with their bundle and, declared in the bundle type, the pattern packet of each (read through the packets door; the summary states what is absent). The bundle keeps the theme material the live validator
 * (parseThemeBriefEntry) checks an entry against. */
export type ThemeBundle = ReturnType<typeof buildThemeBundle> & { packets: Packet[]; candidate_entities: ReturnType<typeof menuBlock> };
export function themeBriefsExporter(sb: Db, o: { charBudget?: number; packets?: PacketReader } = {}) {
  return async ({ limit, ids }: { limit: number; ids?: readonly string[] }): Promise<BatchExport> => {
    try {
      const [themes, briefs, lineage] = [await loadThemes(sb), await loadBriefs(sb), await loadLineage(sb)];
      const needs = themesNeedingBrief(themes, briefs, { lineage });
      const chosen = (ids?.length ? needs.filter((n) => ids.includes(n.theme.id)) : needs).slice(0, limit);
      const material = await loadThemeMaterial(sb, chosen.map((n) => n.theme));
      const gaps = computeThemeGaps(chosen.map((n) => n.theme), material);
      const packetRead = await (o.packets ?? packetReader(sb))(chosen.map((n) => n.theme.id));
      const items: ThemeBundle[] = [];
      // A theme is one reading: a bundle that would drop members is refused by name, never handed out short (a session writes from the whole membership).
      const residue: { theme_id: string; reason: string }[] = [];
      for (const id of ids ?? []) {
        if (chosen.some((n) => n.theme.id === id)) continue;
        const brief = briefs.find((b) => b.theme_id === id);
        residue.push({ theme_id: id, reason: needs.some((n) => n.theme.id === id) ? "over_limit" : !themes.some((t) => t.id === id) ? "no_live_theme" : `not_needing_brief: its brief is current${brief ? ` (generated_by ${brief.generated_by})` : ""}` });
      }
      for (const n of chosen) {
        const packets = packetRead.packets.filter((p) => p.id === n.theme.id);
        // the menu: the packet's member entities, or (packets pending) the entities the member items' claims and events are filed under
        const seed = packets.length ? await packetSeed(sb, packets) : await memberSeed(sb, n.theme.member_ids ?? []);
        const bundle = buildThemeBundle(n, material, gaps.get(n.theme.id), { charBudget: o.charBudget ?? DEFAULT_CHAR_BUDGET });
        if (bundle.truncation.members_omitted) { residue.push({ theme_id: n.theme.id, reason: `over_budget: ${bundle.truncation.members_omitted} of ${bundle.truncation.members_total} member(s) do not fit the ${bundle.truncation.char_budget}-character budget; the theme is not exported short (raise charBudget)` }); continue; }
        items.push({ ...bundle, packets, candidate_entities: menuBlock(await candidateMenu(sb, seed)) });
      }
      const by = (r: string) => needs.filter((n) => n.reason === r).length;
      return { ok: true, items: items as never, source: { type: "table", table: "connection_themes" }, summary: { second_reader: secondReaderBlock("theme-briefs"), themes: themes.length, needing_brief: needs.length, no_brief: by("no_brief"), stale: by("stale"), superseded: by("superseded"), exported: items.length, not_exported_over_limit: needs.length - chosen.length, not_exported_over_budget: residue.length, packets: packetRead.marker ?? "read" }, residue };
    } catch (e) {
      return { ok: false, items: [], error: (e as Error).message };
    }
  };
}
