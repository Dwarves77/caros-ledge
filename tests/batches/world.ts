// The batch kit's test world: the intake slice's memory database and dependency stubs (one small world, so every flow runs against the same material), the kit's deps over it, and the authored files.
import { review } from "@/core/digest/review";
import type { BatchDeps } from "@/features/batches";

import { factClaim, ITEM, makeWorld, metadata, NOW, OFFICIAL_TEXT, OFFICIAL_URL, poolHashOf, SOURCE, SPAN_FORCE, SPAN_PENALTY, SPAN_REPORT } from "../intake/fixtures.ts";

export { ITEM, NOW, OFFICIAL_TEXT, OFFICIAL_URL, SOURCE, SPAN_FORCE, SPAN_PENALTY, SPAN_REPORT, metadata, poolHashOf, factClaim };

export function batchWorld(opts: Parameters<typeof makeWorld>[0] = {}) {
  const w = makeWorld(opts);
  const deps: BatchDeps = { sb: w.db.client, now: () => NOW, intake: w.deps, verdicts: null };
  return { ...w, deps };
}

/** A market_signal_brief body that covers its own figures: every figure and date it states sits inside a quoted span, the requirement sections are labelled, and the timeline section carries a dated entry. */
export function goodBody(over: { sec1?: string; sec3?: string; sec4?: string; timeline?: string | null } = {}): string {
  const heads = ["What's Moving and What Triggered It", "Who's Driving It and What They Want", "Expected Trajectory and Conversion Triggers", "Operational and Cost Implications If It Materializes", "Competitive Implications", "Client Conversation Talking Points", "What the Workspace Should Do Now", "Sources"];
  const filler = "Operators of cargo aircraft and container vessels face a new annual emissions reporting duty, and the reporting calendar belongs in this quarter's planning for every operator concerned. ";
  const tl = over.timeline === undefined ? "- 1 January 2027: Regulation (EU) 2023/9999 enters into force." : over.timeline;
  const secs = [
    `${filler}${SPAN_REPORT}${over.sec1 ?? ""}`,
    `${filler}Carriers expect surcharge pass-through to follow the duty.`,
    `${filler}${SPAN_FORCE}${over.sec3 ?? ""}${tl ? `\n\n${tl}` : ""}`,
    `${filler}${SPAN_PENALTY}${over.sec4 ?? ""}`,
    `${filler}Competitors with existing reporting systems start ahead.`,
    `${filler}Talk to clients about the reporting calendar early.`,
    `${filler}COST ALERT: Build the reporting calendar now. *Operational implication:* the duty needs an owner in each operating unit.`,
    `- EUR-Lex: ${OFFICIAL_URL}`,
  ];
  return heads.map((h, i) => `## ${i + 1}. ${h}\n\n${secs[i]}`).join("\n\n");
}

export const claims = (): Record<string, unknown>[] => [factClaim(SPAN_REPORT, { section: "1" }), factClaim(SPAN_FORCE, { section: "3" }), factClaim(SPAN_PENALTY, { section: "4" })];

export const NO_PACKETS = "packets: 1 of 1 ids have no live pattern packet";
/** A packet door that finds none, as a database with no live pattern answers (the world's own database does not hold the CONNECT-2 fixture). */
export const noPackets = async (ids: readonly string[]) => ({ packets: [], marker: ids.length ? NO_PACKETS : null });

/** The second reader's verdicts on an entry: every judge that applies passes, each with its evidence (a test that needs a fail overrides one). */
export function passingReview(entry: Record<string, unknown>, kind = "item-briefs"): Record<string, unknown> {
  return { reviewed_by: "second-reader-test", judges: Object.fromEntries(review(kind, entry).required.map((id) => [id, { pass: true, evidence: `${id}: the fixture states it` }])) };
}
/** An authored entry with the second reader's all-pass verdicts added. */
export const withReview = (entry: Record<string, unknown>, kind = "item-briefs"): Record<string, unknown> => ({ ...entry, review: passingReview(entry, kind) });
export function recordEntry(db: ReturnType<typeof makeWorld>["db"], over: Record<string, unknown> = {}): Record<string, unknown> {
  const entry = { item_id: ITEM, source_pool_hash: poolHashOf(db), body: goodBody(), metadata: metadata(), claims: claims(), ...over };
  return { ...entry, review: passingReview(entry), ...(over.review === undefined ? {} : { review: over.review }) };
}
export const batchFile = (kind: string, entries: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> => ({ batch: `${kind}-001`, generated_at: NOW.toISOString(), authored_by: "session-lane", entries, ...over });
