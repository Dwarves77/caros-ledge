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

import { candidateMenu, memberSeed, menuBlock, packetSeed } from "../item-briefs/candidates";
import { applyEntries, isObj, type ApplyOpts, type BatchDeps, type BatchExport, type EntrySpec } from "../../kit/session-batch";

/** The batch name a single payload is applied under (the one-entry batch it becomes). */
const SINGLE_BATCH = "theme-briefs-single-payload";
const DEFAULT_CHAR_BUDGET = 120_000;
interface ThemeLive { ctx: ThemeContext; themes: Map<string, ThemeRow>; /** The surface each live member sits on (the no-single-source test reads it). */ surfaces: Map<string, string>; stored: Map<string, { member_hash: string; generated_by: string; brief_md: string }> }
interface Plan { memberIds: string[]; brief: ValidThemeBrief }

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
    return { ctx: buildValidationContext(themes, material, computeThemeGaps(themes, material)), themes: new Map(themes.map((t) => [t.id, t])), surfaces: new Map(material.items.map((i) => [i.id, surfaceOf(i.item_type, i.domain)])), stored: new Map(stored.map((s) => [s.theme_id, s])) };
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
    const prior = live.stored.get(id);
    return prior && prior.member_hash === computeMemberHash(members) && prior.brief_md === v.brief.brief_md ? { errors: [], done: true } : { errors: [], plan: { memberIds: members, brief: v.brief } };
  },
  residueReview: (e, key) => (key ? { subjectId: key, score: review("theme-briefs", e).score, reviewedBy: review("theme-briefs", e).reviewed_by ?? "none" } : null),
  async write(deps, _live, item, batch) {
    const r = await applyThemeBrief({ sb: deps.sb, now: deps.now }, { brief: item.plan.brief, batch, dry: false });
    if (r.outcome === "failed" || !r.counts.written) throw new Error(r.notes.join("; ") || "the seam wrote nothing");
    return { ref: item.plan.brief.theme_id, counts: { briefs_written: 1 } };
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
  return async ({ limit }: { limit: number }): Promise<BatchExport> => {
    try {
      const [themes, briefs, lineage] = [await loadThemes(sb), await loadBriefs(sb), await loadLineage(sb)];
      const needs = themesNeedingBrief(themes, briefs, { lineage });
      const chosen = needs.slice(0, limit);
      const material = await loadThemeMaterial(sb, chosen.map((n) => n.theme));
      const gaps = computeThemeGaps(chosen.map((n) => n.theme), material);
      const packetRead = await (o.packets ?? packetReader(sb))(chosen.map((n) => n.theme.id));
      const items: ThemeBundle[] = [];
      for (const n of chosen) {
        const packets = packetRead.packets.filter((p) => p.id === n.theme.id);
        // the menu: the packet's member entities, or (packets pending) the entities the member items' claims and events are filed under
        const seed = packets.length ? await packetSeed(sb, packets) : await memberSeed(sb, n.theme.member_ids ?? []);
        items.push({ ...buildThemeBundle(n, material, gaps.get(n.theme.id), { charBudget: o.charBudget ?? DEFAULT_CHAR_BUDGET }), packets, candidate_entities: menuBlock(await candidateMenu(sb, seed)) });
      }
      const by = (r: string) => needs.filter((n) => n.reason === r).length;
      return { ok: true, items: items as never, source: { type: "table", table: "connection_themes" }, summary: { second_reader: secondReaderBlock("theme-briefs"), themes: themes.length, needing_brief: needs.length, no_brief: by("no_brief"), stale: by("stale"), superseded: by("superseded"), exported: items.length, not_exported_over_limit: needs.length - items.length, packets: packetRead.marker ?? "read" } };
    } catch (e) {
      return { ok: false, items: [], error: (e as Error).message };
    }
  };
}
